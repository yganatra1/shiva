import { randomUUID } from "node:crypto";

import {
  AgentDelegationError,
  type DelegateOptions,
} from "./agent-client";
import type { AgentRegistry } from "./agent-registry";
import {
  OrchestrationRepositoryError,
  type AgentTaskRecord,
  type OrchestrationRepositoryPort,
} from "./orchestration-repository";
import type { AgentTask } from "./shared/protocol";

export interface AgentTaskPublisher {
  publishTask(task: AgentTask): Promise<string>;
  isAgentOnline(agentId: string): Promise<boolean>;
}

export interface DurableDelegationOptions extends DelegateOptions {
  readonly orchestration?: {
    readonly agentRunId: string;
    readonly conversationId: string;
    readonly userId: string;
    readonly sourceMessageId?: string;
    readonly originalUserRequest?: string;
    readonly executionContext?: string;
    readonly userMessage?: string;
    readonly orchestrationRequestId?: string;
    readonly agentResponseId?: string;
    readonly now: Date;
  };
}

export interface QueuedAgentTask {
  readonly queued: true;
  readonly requestId: string;
  readonly taskId: string;
  readonly userMessage: string;
}

export interface AgentTaskDispatcherOptions {
  readonly taskTimeoutMs: number;
  /** Agent-specific deadlines for work that legitimately exceeds the default. */
  readonly taskTimeoutMsByAgent?: Readonly<Record<string, number>>;
  readonly requireHeartbeat?: boolean;
  readonly createId?: () => string;
  readonly onPublishError?: (error: unknown, task: AgentTaskRecord) => void;
}

/**
 * Core's PostgreSQL-outbox-backed delegation boundary. It persists the
 * natural-language execution context and minimal instruction before Redis is
 * touched, so a process crash cannot erase Core's intent.
 */
export class AgentTaskDispatcher {
  private readonly taskTimeoutMs: number;
  private readonly taskTimeoutMsByAgent: ReadonlyMap<string, number>;
  private readonly requireHeartbeat: boolean;
  private readonly createId: () => string;
  private readonly onPublishError: (
    error: unknown,
    task: AgentTaskRecord,
  ) => void;

  constructor(
    private readonly registry: AgentRegistry,
    private readonly repository: OrchestrationRepositoryPort,
    private readonly transport: AgentTaskPublisher,
    options: AgentTaskDispatcherOptions,
  ) {
    validateTaskTimeout(options.taskTimeoutMs, "Agent task timeout");
    this.taskTimeoutMs = options.taskTimeoutMs;
    const taskTimeoutMsByAgent = new Map<string, number>();
    for (const [agentId, timeoutMs] of Object.entries(
      options.taskTimeoutMsByAgent ?? {},
    )) {
      if (!this.registry.has(agentId)) {
        throw new RangeError(
          `Agent task timeout override references unknown agent '${agentId}'.`,
        );
      }
      validateTaskTimeout(
        timeoutMs,
        `Agent task timeout override for '${agentId}'`,
      );
      taskTimeoutMsByAgent.set(agentId, timeoutMs);
    }
    this.taskTimeoutMsByAgent = taskTimeoutMsByAgent;
    this.requireHeartbeat = options.requireHeartbeat ?? true;
    this.createId = options.createId ?? randomUUID;
    this.onPublishError = options.onPublishError ?? (() => {});
  }

  async delegate(
    agentId: string,
    instruction: string,
    options: DurableDelegationOptions = {},
  ): Promise<QueuedAgentTask> {
    if (!this.registry.has(agentId)) {
      throw new AgentDelegationError(
        "AGENT_NOT_FOUND",
        `No agent with id '${agentId}' is registered.`,
      );
    }
    const descriptor = this.registry.get(agentId);
    options.signal?.throwIfAborted();
    if (this.requireHeartbeat) {
      let online: boolean;
      try {
        online = await this.transport.isAgentOnline(agentId);
      } catch (error: unknown) {
        throw new AgentDelegationError(
          "TRANSPORT_UNAVAILABLE",
          "The internal agent transport is unavailable.",
          { cause: error },
        );
      }
      if (!online) {
        throw new AgentDelegationError(
          "AGENT_OFFLINE",
          `${descriptor.name} is offline, so no task was queued.`,
        );
      }
    }

    const orchestration = options.orchestration;
    if (!orchestration) {
      throw new AgentDelegationError(
        "AGENT_FAILED",
        "Core did not provide durable orchestration context.",
      );
    }
    const now = orchestration.now;
    const taskTimeoutMs =
      this.taskTimeoutMsByAgent.get(descriptor.id) ?? this.taskTimeoutMs;
    const deadlineAt = new Date(now.getTime() + taskTimeoutMs);
    const taskId = this.createId();
    let requestId: string;
    let task: AgentTaskRecord;

    if (orchestration.orchestrationRequestId) {
      if (!orchestration.agentResponseId) {
        throw new AgentDelegationError(
          "AGENT_FAILED",
          "A continued delegation is missing its correlated agent response.",
        );
      }
      requestId = orchestration.orchestrationRequestId;
      try {
        task = await this.repository.createNextTask({
          taskId,
          requestId,
          createdFromResponseId: orchestration.agentResponseId,
          agentId,
          instruction,
          now,
          deadlineAt,
        });
      } catch (error: unknown) {
        if (
          error instanceof OrchestrationRepositoryError &&
          error.failure === "DELEGATION_LIMIT_REACHED"
        ) {
          throw new AgentDelegationError(
            "DELEGATION_LIMIT_REACHED",
            error.message,
            { cause: error },
          );
        }
        throw error;
      }
    } else {
      if (
        !orchestration.sourceMessageId ||
        !orchestration.originalUserRequest ||
        !orchestration.executionContext
      ) {
        throw new AgentDelegationError(
          "AGENT_FAILED",
          "The first delegation is missing its original request or natural-language execution context.",
        );
      }
      requestId = this.createId();
      const created = await this.repository.createInitialRequestWithTask({
        requestId,
        taskId,
        userId: orchestration.userId,
        conversationId: orchestration.conversationId,
        sourceMessageId: orchestration.sourceMessageId,
        originalUserRequest: orchestration.originalUserRequest,
        executionContext: orchestration.executionContext,
        agentId,
        instruction,
        now,
        deadlineAt,
      });
      requestId = created.request.id;
      task = created.task;
    }

    // From this point the task is durable. A disconnected HTTP client must not
    // cancel it; failed publication remains in the outbox for recovery.
    await this.publishPersistedTask(task).catch((error: unknown) => {
      this.onPublishError(error, task);
    });

    return {
      queued: true,
      requestId,
      taskId: task.id,
      userMessage:
        orchestration.userMessage ??
        `I've asked ${descriptor.name} to handle that.`,
    };
  }

  async flushUnpublished(limit = 100): Promise<number> {
    const tasks = await this.repository.listUnpublishedTasks(limit);
    let published = 0;
    for (const task of tasks) {
      try {
        await this.publishPersistedTask(task);
        published += 1;
      } catch (error: unknown) {
        this.onPublishError(error, task);
      }
    }
    return published;
  }

  private async publishPersistedTask(task: AgentTaskRecord): Promise<void> {
    if (task.publishedAt) return;
    const redisMessageId = await this.transport.publishTask({
      id: task.id,
      conversationId: await this.conversationIdFor(task),
      agentId: task.agentId,
      instruction: task.instruction,
      createdAt: task.createdAt.toISOString(),
      deadlineAt: task.deadlineAt.toISOString(),
    });
    await this.repository.markTaskPublished(
      task.id,
      redisMessageId,
      new Date(),
    );
  }

  private async conversationIdFor(task: AgentTaskRecord): Promise<string> {
    // The transport envelope deliberately contains no semantic context. The
    // durable request owns the conversation correlation; repository record
    // implementations may expose it on joined task records in the future.
    const request = await this.repository.getRequest(
      task.orchestrationRequestId,
    );
    if (!request) {
      throw new AgentDelegationError(
        "AGENT_FAILED",
        "The durable request for this agent task is unavailable.",
      );
    }
    return request.conversationId;
  }
}

function validateTaskTimeout(timeoutMs: number, label: string): void {
  if (
    !Number.isInteger(timeoutMs) ||
    timeoutMs < 5_000 ||
    timeoutMs > 86_400_000
  ) {
    throw new RangeError(
      `${label} must be an integer from 5000 to 86400000 milliseconds.`,
    );
  }
}
