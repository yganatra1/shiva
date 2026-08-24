import {
  and,
  asc,
  eq,
  isNull,
  lte,
  or,
  sql,
} from "drizzle-orm";

import type { ShivaDatabase } from "../database/pool.js";
import {
  agentResponses,
  agentTasks,
  conversations,
  messages,
  orchestrationRequests,
} from "../database/schema.js";

export type OrchestrationRequestRecord =
  typeof orchestrationRequests.$inferSelect;
export type AgentTaskRecord = typeof agentTasks.$inferSelect;
export type AgentResponseRecord = typeof agentResponses.$inferSelect;
export type OrchestrationAssistantMessage = typeof messages.$inferSelect;

export interface CreateInitialRequestWithTaskInput {
  readonly requestId?: string;
  readonly taskId?: string;
  readonly userId: string;
  readonly conversationId: string;
  readonly sourceMessageId: string;
  readonly originalUserRequest: string;
  readonly executionContext: string;
  readonly agentId: string;
  readonly instruction: string;
  readonly now: Date;
  readonly deadlineAt: Date;
}

export interface CreateNextTaskInput {
  readonly taskId?: string;
  readonly requestId: string;
  readonly createdFromResponseId: string;
  readonly agentId: string;
  readonly instruction: string;
  readonly now: Date;
  readonly deadlineAt: Date;
}

export interface PlainAgentResponseEnvelope {
  readonly taskId: string;
  readonly agentId: string;
  readonly message: string;
  readonly metadata?: Readonly<Record<string, unknown>>;
  readonly timestamp: string;
}

export interface AcceptedAgentResponse {
  readonly accepted: boolean;
  readonly request: OrchestrationRequestRecord;
  readonly task: AgentTaskRecord;
  readonly response: AgentResponseRecord;
}

export interface FinishResponseWithMessageInput {
  readonly requestId: string;
  readonly responseId: string;
  readonly message: string;
  readonly complete: boolean;
  /** Fences completion to the Core worker that owns the processing lease. */
  readonly claimedAt: Date;
  readonly now: Date;
}

export interface CompleteRequestAfterConfirmationInput {
  readonly requestId: string;
  readonly responseId: string;
  readonly now: Date;
}

export interface OrchestrationRepositoryPort {
  getRequest(
    requestId: string,
  ): Promise<OrchestrationRequestRecord | undefined>;
  createInitialRequestWithTask(
    input: CreateInitialRequestWithTaskInput,
  ): Promise<{
    readonly request: OrchestrationRequestRecord;
    readonly task: AgentTaskRecord;
  }>;
  createNextTask(input: CreateNextTaskInput): Promise<AgentTaskRecord>;
  markTaskPublished(
    taskId: string,
    redisMessageId: string,
    now: Date,
  ): Promise<AgentTaskRecord>;
  listUnpublishedTasks(limit: number): Promise<readonly AgentTaskRecord[]>;
  acceptResponse(
    envelope: PlainAgentResponseEnvelope,
    redisMessageId: string,
  ): Promise<AcceptedAgentResponse>;
  listUnprocessedResponses(
    staleBefore: Date,
    limit: number,
  ): Promise<readonly AcceptedAgentResponse[]>;
  claimResponseProcessing(
    responseId: string,
    claimedAt: Date,
    staleBefore: Date,
  ): Promise<AcceptedAgentResponse | undefined>;
  releaseResponseProcessing(
    responseId: string,
    claimedAt: Date,
    error: string,
  ): Promise<void>;
  /**
   * Closes a request whose continuation confirmation ended without a child
   * task. This is lifecycle bookkeeping only, not a semantic workflow status.
   */
  completeRequestAfterConfirmation(
    input: CompleteRequestAfterConfirmationInput,
  ): Promise<OrchestrationRequestRecord | undefined>;
  finishResponseWithMessage(
    input: FinishResponseWithMessageInput,
  ): Promise<OrchestrationAssistantMessage>;
  listExpiredTasks(
    now: Date,
    limit: number,
  ): Promise<readonly AgentTaskRecord[]>;
  markTaskAbandoned(
    taskId: string,
    reason: string,
    now: Date,
  ): Promise<AgentTaskRecord | undefined>;
}

export type OrchestrationRepositoryFailure =
  | "REQUEST_NOT_FOUND"
  | "REQUEST_COMPLETED"
  | "TASK_NOT_FOUND"
  | "TASK_NOT_ACTIVE"
  | "TASK_AGENT_MISMATCH"
  | "TASK_PUBLICATION_CONFLICT"
  | "RESPONSE_NOT_FOUND"
  | "RESPONSE_REQUEST_MISMATCH"
  | "INVALID_INPUT"
  | "PERSISTENCE_FAILED";

export class OrchestrationRepositoryError extends Error {
  override readonly name = "OrchestrationRepositoryError";

  constructor(
    readonly failure: OrchestrationRepositoryFailure,
    message: string,
  ) {
    super(message);
  }
}

/** PostgreSQL-backed durable request context, task outbox, and response inbox. */
export class DrizzleOrchestrationRepository
  implements OrchestrationRepositoryPort
{
  constructor(private readonly database: ShivaDatabase) {}

  async getRequest(
    requestId: string,
  ): Promise<OrchestrationRequestRecord | undefined> {
    const [request] = await this.database
      .select()
      .from(orchestrationRequests)
      .where(eq(orchestrationRequests.id, requestId))
      .limit(1);
    return request;
  }

  async createInitialRequestWithTask(
    input: CreateInitialRequestWithTaskInput,
  ): Promise<{
    readonly request: OrchestrationRequestRecord;
    readonly task: AgentTaskRecord;
  }> {
    validateDeadline(input.now, input.deadlineAt);
    const originalUserRequest = nonEmptyText(
      input.originalUserRequest,
      "originalUserRequest",
    );
    const executionContext = nonEmptyText(
      input.executionContext,
      "executionContext",
    );
    const agentId = normalizedIdentifier(input.agentId, "agentId");
    const instruction = nonEmptyText(input.instruction, "instruction");

    return this.database.transaction(async (transaction) => {
      const [createdRequest] = await transaction
        .insert(orchestrationRequests)
        .values({
          ...(input.requestId ? { id: input.requestId } : {}),
          userId: input.userId,
          conversationId: input.conversationId,
          sourceMessageId: input.sourceMessageId,
          originalUserRequest,
          executionContext,
          createdAt: input.now,
          updatedAt: input.now,
        })
        .returning();
      const request = requiredRow(createdRequest, "orchestration request");

      const [createdTask] = await transaction
        .insert(agentTasks)
        .values({
          ...(input.taskId ? { id: input.taskId } : {}),
          orchestrationRequestId: request.id,
          agentId,
          instruction,
          createdAt: input.now,
          deadlineAt: input.deadlineAt,
        })
        .returning();

      return {
        request,
        task: requiredRow(createdTask, "initial agent task"),
      };
    });
  }

  async createNextTask(input: CreateNextTaskInput): Promise<AgentTaskRecord> {
    validateDeadline(input.now, input.deadlineAt);
    const agentId = normalizedIdentifier(input.agentId, "agentId");
    const instruction = nonEmptyText(input.instruction, "instruction");

    return this.database.transaction(async (transaction) => {
      // Serialize child-task creation with confirmation cancellation. Without
      // this request-scoped lock, a denial and a newly queued child could both
      // observe an active request and commit conflicting lifecycle decisions.
      await transaction.execute(
        sql`select pg_advisory_xact_lock(hashtextextended(${input.requestId}, 0))`,
      );
      const [source] = await transaction
        .select({
          requestId: agentTasks.orchestrationRequestId,
          completedAt: orchestrationRequests.completedAt,
        })
        .from(agentResponses)
        .innerJoin(agentTasks, eq(agentTasks.id, agentResponses.taskId))
        .innerJoin(
          orchestrationRequests,
          eq(orchestrationRequests.id, agentTasks.orchestrationRequestId),
        )
        .where(eq(agentResponses.id, input.createdFromResponseId))
        .limit(1);

      if (!source) {
        throw new OrchestrationRepositoryError(
          "RESPONSE_NOT_FOUND",
          "The source agent response does not exist.",
        );
      }
      if (source.requestId !== input.requestId) {
        throw new OrchestrationRepositoryError(
          "RESPONSE_REQUEST_MISMATCH",
          "The source response belongs to a different orchestration request.",
        );
      }
      if (source.completedAt) {
        throw new OrchestrationRepositoryError(
          "REQUEST_COMPLETED",
          "The orchestration request is already complete.",
        );
      }

      const [inserted] = await transaction
        .insert(agentTasks)
        .values({
          ...(input.taskId ? { id: input.taskId } : {}),
          orchestrationRequestId: input.requestId,
          agentId,
          instruction,
          createdFromResponseId: input.createdFromResponseId,
          createdAt: input.now,
          deadlineAt: input.deadlineAt,
        })
        .onConflictDoNothing()
        .returning();
      if (inserted) return inserted;

      const [existing] = await transaction
        .select()
        .from(agentTasks)
        .where(
          eq(agentTasks.createdFromResponseId, input.createdFromResponseId),
        )
        .limit(1);
      return requiredRow(existing, "idempotent next agent task");
    });
  }

  async markTaskPublished(
    taskId: string,
    redisMessageId: string,
    now: Date,
  ): Promise<AgentTaskRecord> {
    const normalizedRedisId = normalizedIdentifier(
      redisMessageId,
      "redisMessageId",
    );
    const [published] = await this.database
      .update(agentTasks)
      .set({
        publishedAt: now,
        redisMessageId: normalizedRedisId,
        deliveryAttempts: sql`${agentTasks.deliveryAttempts} + 1`,
        lastDeliveryError: null,
      })
      .where(
        and(
          eq(agentTasks.id, taskId),
          isNull(agentTasks.publishedAt),
          isNull(agentTasks.abandonedAt),
        ),
      )
      .returning();
    if (published) return published;

    const task = await this.findTask(taskId);
    if (!task) {
      throw new OrchestrationRepositoryError(
        "TASK_NOT_FOUND",
        "The agent task does not exist.",
      );
    }
    if (
      task.publishedAt &&
      task.redisMessageId === normalizedRedisId &&
      !task.abandonedAt
    ) {
      return task;
    }
    throw new OrchestrationRepositoryError(
      "TASK_PUBLICATION_CONFLICT",
      "The agent task can no longer be marked with this Redis message ID.",
    );
  }

  async listUnpublishedTasks(
    limit: number,
  ): Promise<readonly AgentTaskRecord[]> {
    const rows = await this.database
      .select({ task: agentTasks })
      .from(agentTasks)
      .leftJoin(agentResponses, eq(agentResponses.taskId, agentTasks.id))
      .where(
        and(
          isNull(agentTasks.publishedAt),
          isNull(agentTasks.abandonedAt),
          isNull(agentResponses.id),
        ),
      )
      .orderBy(asc(agentTasks.createdAt), asc(agentTasks.id))
      .limit(normalizedLimit(limit));
    return rows.map(({ task }) => task);
  }

  async acceptResponse(
    envelope: PlainAgentResponseEnvelope,
    redisMessageId: string,
  ): Promise<AcceptedAgentResponse> {
    const agentId = normalizedIdentifier(envelope.agentId, "agentId");
    const message = nonEmptyText(envelope.message, "message");
    const normalizedRedisId = normalizedIdentifier(
      redisMessageId,
      "redisMessageId",
    );
    const agentTimestamp = parsedTimestamp(envelope.timestamp);
    const metadata = { ...(envelope.metadata ?? {}) };

    return this.database.transaction(async (transaction) => {
      const [correlation] = await transaction
        .select({ task: agentTasks, request: orchestrationRequests })
        .from(agentTasks)
        .innerJoin(
          orchestrationRequests,
          eq(orchestrationRequests.id, agentTasks.orchestrationRequestId),
        )
        .where(eq(agentTasks.id, envelope.taskId))
        .limit(1);
      if (!correlation) {
        throw new OrchestrationRepositoryError(
          "TASK_NOT_FOUND",
          "The response references an unknown agent task.",
        );
      }
      if (correlation.task.agentId !== agentId) {
        throw new OrchestrationRepositoryError(
          "TASK_AGENT_MISMATCH",
          "The response agent does not match the task recipient.",
        );
      }
      const [alreadyAccepted] = await transaction
        .select()
        .from(agentResponses)
        .where(eq(agentResponses.taskId, envelope.taskId))
        .limit(1);
      if (alreadyAccepted) {
        return {
          accepted: false,
          request: correlation.request,
          task: correlation.task,
          response: alreadyAccepted,
        };
      }
      if (correlation.task.abandonedAt || correlation.request.completedAt) {
        throw new OrchestrationRepositoryError(
          "TASK_NOT_ACTIVE",
          "The response arrived after its task was no longer active.",
        );
      }

      const [inserted] = await transaction
        .insert(agentResponses)
        .values({
          taskId: envelope.taskId,
          agentId,
          message,
          metadata,
          agentTimestamp,
          redisMessageId: normalizedRedisId,
        })
        .onConflictDoNothing()
        .returning();
      if (inserted) {
        return {
          accepted: true,
          request: correlation.request,
          task: correlation.task,
          response: inserted,
        };
      }

      // Another Core consumer may have won the unique task-response race after
      // the lookup above. Reload its row so replay remains idempotent.
      const [existing] = await transaction
        .select()
        .from(agentResponses)
        .where(eq(agentResponses.taskId, envelope.taskId))
        .limit(1);
      return {
        accepted: false,
        request: correlation.request,
        task: correlation.task,
        response: requiredRow(existing, "idempotent agent response"),
      };
    });
  }

  async listUnprocessedResponses(
    staleBefore: Date,
    limit: number,
  ): Promise<readonly AcceptedAgentResponse[]> {
    const rows = await this.database
      .select({
        request: orchestrationRequests,
        task: agentTasks,
        response: agentResponses,
      })
      .from(agentResponses)
      .innerJoin(agentTasks, eq(agentTasks.id, agentResponses.taskId))
      .innerJoin(
        orchestrationRequests,
        eq(orchestrationRequests.id, agentTasks.orchestrationRequestId),
      )
      .where(
        and(
          isNull(agentResponses.processedAt),
          or(
            isNull(agentResponses.processingStartedAt),
            lte(agentResponses.processingStartedAt, staleBefore),
          ),
        ),
      )
      .orderBy(asc(agentResponses.receivedAt), asc(agentResponses.id))
      .limit(normalizedLimit(limit));
    return rows.map((row) => ({ accepted: false, ...row }));
  }

  async claimResponseProcessing(
    responseId: string,
    claimedAt: Date,
    staleBefore: Date,
  ): Promise<AcceptedAgentResponse | undefined> {
    return this.database.transaction(async (transaction) => {
      const [claimed] = await transaction
        .update(agentResponses)
        .set({
          processingStartedAt: claimedAt,
          processingAttempts: sql`${agentResponses.processingAttempts} + 1`,
          lastProcessingError: null,
        })
        .where(
          and(
            eq(agentResponses.id, responseId),
            isNull(agentResponses.processedAt),
            or(
              isNull(agentResponses.processingStartedAt),
              lte(agentResponses.processingStartedAt, staleBefore),
            ),
          ),
        )
        .returning();
      if (!claimed) return undefined;

      const [correlation] = await transaction
        .select({ request: orchestrationRequests, task: agentTasks })
        .from(agentTasks)
        .innerJoin(
          orchestrationRequests,
          eq(orchestrationRequests.id, agentTasks.orchestrationRequestId),
        )
        .where(eq(agentTasks.id, claimed.taskId))
        .limit(1);
      if (!correlation) {
        throw new OrchestrationRepositoryError(
          "PERSISTENCE_FAILED",
          "The claimed response no longer has durable task correlation.",
        );
      }
      return {
        accepted: false,
        request: correlation.request,
        task: correlation.task,
        response: claimed,
      };
    });
  }

  async releaseResponseProcessing(
    responseId: string,
    claimedAt: Date,
    error: string,
  ): Promise<void> {
    await this.database
      .update(agentResponses)
      .set({
        processingStartedAt: null,
        lastProcessingError: nonEmptyText(error, "error"),
      })
      .where(
        and(
          eq(agentResponses.id, responseId),
          eq(agentResponses.processingStartedAt, claimedAt),
          isNull(agentResponses.processedAt),
        ),
      );
  }

  async completeRequestAfterConfirmation(
    input: CompleteRequestAfterConfirmationInput,
  ): Promise<OrchestrationRequestRecord | undefined> {
    if (!Number.isFinite(input.now.getTime())) {
      throw new OrchestrationRepositoryError(
        "INVALID_INPUT",
        "now must be a valid timestamp.",
      );
    }
    return this.database.transaction(async (transaction) => {
      await transaction.execute(
        sql`select pg_advisory_xact_lock(hashtextextended(${input.requestId}, 0))`,
      );
      const [correlation] = await transaction
        .select({
          request: orchestrationRequests,
          response: agentResponses,
        })
        .from(agentResponses)
        .innerJoin(agentTasks, eq(agentTasks.id, agentResponses.taskId))
        .innerJoin(
          orchestrationRequests,
          eq(orchestrationRequests.id, agentTasks.orchestrationRequestId),
        )
        .where(eq(agentResponses.id, input.responseId))
        .limit(1);
      if (!correlation) {
        throw new OrchestrationRepositoryError(
          "RESPONSE_NOT_FOUND",
          "The confirmation's source agent response does not exist.",
        );
      }
      if (correlation.request.id !== input.requestId) {
        throw new OrchestrationRepositoryError(
          "RESPONSE_REQUEST_MISMATCH",
          "The confirmation's source response belongs to a different orchestration request.",
        );
      }
      if (correlation.request.completedAt) return correlation.request;

      const [nextTask] = await transaction
        .select({ id: agentTasks.id })
        .from(agentTasks)
        .where(eq(agentTasks.createdFromResponseId, input.responseId))
        .limit(1);
      if (nextTask) return undefined;

      const [completed] = await transaction
        .update(orchestrationRequests)
        .set({ completedAt: input.now, updatedAt: input.now })
        .where(
          and(
            eq(orchestrationRequests.id, input.requestId),
            isNull(orchestrationRequests.completedAt),
          ),
        )
        .returning();
      return completed;
    });
  }

  async finishResponseWithMessage(
    input: FinishResponseWithMessageInput,
  ): Promise<OrchestrationAssistantMessage> {
    const content = nonEmptyText(input.message, "message");

    return this.database.transaction(async (transaction) => {
      const response = await findResponse(transaction, input.responseId);
      if (!response) {
        throw new OrchestrationRepositoryError(
          "RESPONSE_NOT_FOUND",
          "The agent response does not exist.",
        );
      }
      const task = await findTask(transaction, response.taskId);
      if (!task || task.orchestrationRequestId !== input.requestId) {
        throw new OrchestrationRepositoryError(
          "RESPONSE_REQUEST_MISMATCH",
          "The response belongs to a different orchestration request.",
        );
      }

      if (response.processedAt && response.assistantMessageId) {
        const [existingMessage] = await transaction
          .select()
          .from(messages)
          .where(eq(messages.id, response.assistantMessageId))
          .limit(1);
        return requiredRow(existingMessage, "processed assistant message");
      }
      if (
        !response.processingStartedAt ||
        response.processingStartedAt.getTime() !== input.claimedAt.getTime()
      ) {
        throw new OrchestrationRepositoryError(
          "PERSISTENCE_FAILED",
          "The response processing lease is not owned by this Core worker.",
        );
      }

      const [request] = await transaction
        .select()
        .from(orchestrationRequests)
        .where(eq(orchestrationRequests.id, input.requestId))
        .limit(1);
      if (!request) {
        throw new OrchestrationRepositoryError(
          "REQUEST_NOT_FOUND",
          "The orchestration request does not exist.",
        );
      }
      if (request.completedAt) {
        throw new OrchestrationRepositoryError(
          "REQUEST_COMPLETED",
          "The orchestration request is already complete.",
        );
      }

      const [createdMessage] = await transaction
        .insert(messages)
        .values({
          conversationId: request.conversationId,
          role: "assistant",
          content,
          createdAt: input.now,
        })
        .returning();
      const assistantMessage = requiredRow(
        createdMessage,
        "assistant message",
      );

      const [processed] = await transaction
        .update(agentResponses)
        .set({
          processedAt: input.now,
          assistantMessageId: assistantMessage.id,
          lastProcessingError: null,
        })
        .where(
          and(
            eq(agentResponses.id, input.responseId),
            eq(agentResponses.processingStartedAt, input.claimedAt),
            isNull(agentResponses.processedAt),
          ),
        )
        .returning({ id: agentResponses.id });
      requiredRow(processed, "processed agent response");

      await transaction
        .update(orchestrationRequests)
        .set({
          updatedAt: input.now,
          ...(input.complete ? { completedAt: input.now } : {}),
        })
        .where(eq(orchestrationRequests.id, input.requestId));
      await transaction
        .update(conversations)
        .set({ lastMessageAt: input.now, updatedAt: input.now })
        .where(eq(conversations.id, request.conversationId));

      return assistantMessage;
    });
  }

  async listExpiredTasks(
    now: Date,
    limit: number,
  ): Promise<readonly AgentTaskRecord[]> {
    const rows = await this.database
      .select({ task: agentTasks })
      .from(agentTasks)
      .leftJoin(agentResponses, eq(agentResponses.taskId, agentTasks.id))
      .where(
        and(
          lte(agentTasks.deadlineAt, now),
          isNull(agentTasks.abandonedAt),
          isNull(agentResponses.id),
        ),
      )
      .orderBy(asc(agentTasks.deadlineAt), asc(agentTasks.id))
      .limit(normalizedLimit(limit));
    return rows.map(({ task }) => task);
  }

  async markTaskAbandoned(
    taskId: string,
    reason: string,
    now: Date,
  ): Promise<AgentTaskRecord | undefined> {
    const errorMessage = nonEmptyText(reason, "reason");
    return this.database.transaction(async (transaction) => {
      const [response] = await transaction
        .select({ id: agentResponses.id })
        .from(agentResponses)
        .where(eq(agentResponses.taskId, taskId))
        .limit(1);
      if (response) return undefined;

      const [abandoned] = await transaction
        .update(agentTasks)
        .set({ abandonedAt: now, lastDeliveryError: errorMessage })
        .where(
          and(eq(agentTasks.id, taskId), isNull(agentTasks.abandonedAt)),
        )
        .returning();
      if (abandoned) return abandoned;
      return findTask(transaction, taskId);
    });
  }

  private async findTask(taskId: string): Promise<AgentTaskRecord | undefined> {
    return findTask(this.database, taskId);
  }
}

type DatabaseExecutor = Pick<ShivaDatabase, "select">;

async function findTask(
  database: DatabaseExecutor,
  taskId: string,
): Promise<AgentTaskRecord | undefined> {
  const [task] = await database
    .select()
    .from(agentTasks)
    .where(eq(agentTasks.id, taskId))
    .limit(1);
  return task;
}

async function findResponse(
  database: DatabaseExecutor,
  responseId: string,
): Promise<AgentResponseRecord | undefined> {
  const [response] = await database
    .select()
    .from(agentResponses)
    .where(eq(agentResponses.id, responseId))
    .limit(1);
  return response;
}

function nonEmptyText(value: string, field: string): string {
  if (value.trim().length === 0) {
    throw new OrchestrationRepositoryError(
      "INVALID_INPUT",
      `${field} must not be empty.`,
    );
  }
  return value;
}

function normalizedIdentifier(value: string, field: string): string {
  const normalized = value.trim();
  if (normalized.length === 0) {
    throw new OrchestrationRepositoryError(
      "INVALID_INPUT",
      `${field} must not be empty.`,
    );
  }
  return normalized;
}

function validateDeadline(now: Date, deadlineAt: Date): void {
  if (
    !Number.isFinite(now.getTime()) ||
    !Number.isFinite(deadlineAt.getTime()) ||
    deadlineAt <= now
  ) {
    throw new OrchestrationRepositoryError(
      "INVALID_INPUT",
      "deadlineAt must be later than now.",
    );
  }
}

function parsedTimestamp(value: string): Date {
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.getTime())) {
    throw new OrchestrationRepositoryError(
      "INVALID_INPUT",
      "The agent response timestamp is invalid.",
    );
  }
  return parsed;
}

function normalizedLimit(value: number): number {
  if (!Number.isInteger(value) || value < 1 || value > 1_000) {
    throw new OrchestrationRepositoryError(
      "INVALID_INPUT",
      "limit must be an integer between 1 and 1000.",
    );
  }
  return value;
}

function requiredRow<T>(row: T | undefined, entity: string): T {
  if (!row) {
    throw new OrchestrationRepositoryError(
      "PERSISTENCE_FAILED",
      `Database did not return the ${entity}.`,
    );
  }
  return row;
}
