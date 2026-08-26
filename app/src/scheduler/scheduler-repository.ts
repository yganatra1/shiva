import { and, desc, eq } from "drizzle-orm";

import type { ShivaDatabase } from "../database/pool";
import {
  scheduledTaskExecutions,
  scheduledTasks,
} from "../database/schema";
import type {
  CreateScheduledTaskInput,
  ScheduledTask,
  ScheduledTaskExecution,
  ScheduledTaskExecutionStatus,
  ScheduledTaskLastStatus,
} from "./scheduler-types";
import { ScheduledTaskConflictError } from "./scheduler-types";

export interface StoredScheduledTaskInput {
  readonly id: string;
  readonly userId: string;
  readonly conversationId: string;
  readonly name: string;
  readonly instruction: string;
  readonly scheduleType: CreateScheduledTaskInput["scheduleType"];
  readonly timezone: string;
  readonly scheduleExpression: string | null;
  readonly runAt: Date | null;
  readonly intervalSeconds: number | null;
  readonly scheduleKey: string | null;
  readonly nextRunAt: Date | null;
  readonly now: Date;
}

export interface ScheduledTaskConfiguration {
  readonly name: string;
  readonly instruction: string;
  readonly scheduleType: ScheduledTask["scheduleType"];
  readonly scheduleExpression: string | null;
  readonly runAt: Date | null;
  readonly intervalSeconds: number | null;
  readonly timezone: string;
  readonly scheduleKey: string | null;
}

export interface ExecutionClaimInput {
  readonly scheduledTaskId: string;
  readonly pgBossJobId: string;
  readonly occurrenceId: string;
  readonly scheduleRevision: number;
  readonly triggeredAt: Date;
  readonly now: Date;
}

export interface ExecutionClaim {
  readonly execution: ScheduledTaskExecution;
  readonly claimed: boolean;
}

export interface SchedulerRepositoryPort {
  createTask(input: StoredScheduledTaskInput): Promise<ScheduledTask>;
  getTask(id: string): Promise<ScheduledTask | undefined>;
  getOwnedTask(userId: string, id: string): Promise<ScheduledTask | undefined>;
  listTasks(userId: string, enabled?: boolean): Promise<readonly ScheduledTask[]>;
  listEnabledTasks(): Promise<readonly ScheduledTask[]>;
  replaceConfiguration(
    userId: string,
    id: string,
    expectedRevision: number,
    configuration: ScheduledTaskConfiguration,
    now: Date,
  ): Promise<ScheduledTask | undefined>;
  setEnabled(
    userId: string,
    id: string,
    expectedRevision: number,
    enabled: boolean,
    now: Date,
  ): Promise<ScheduledTask | undefined>;
  setInfrastructure(
    id: string,
    expectedRevision: number,
    currentJobId: string | null,
    nextRunAt: Date | null,
    now: Date,
  ): Promise<ScheduledTask | undefined>;
  recordTaskStarted(
    id: string,
    expectedRevision: number,
    startedAt: Date,
  ): Promise<void>;
  recordTaskResult(
    id: string,
    expectedRevision: number,
    status: Exclude<ScheduledTaskLastStatus, "pending" | "running">,
    error: string | null,
    finishedAt: Date,
    nextRunAt?: Date | null,
  ): Promise<void>;
  completeOneTime(
    id: string,
    expectedRevision: number,
    jobId: string,
    status: "succeeded" | "failed",
    error: string | null,
    finishedAt: Date,
  ): Promise<void>;
  advanceInterval(
    id: string,
    expectedRevision: number,
    currentJobId: string,
    nextJobId: string,
    nextRunAt: Date,
    now: Date,
  ): Promise<"advanced" | "already_advanced" | "stale">;
  setTaskConversation(
    id: string,
    conversationId: string,
    now: Date,
  ): Promise<void>;
  deleteTask(userId: string, id: string): Promise<boolean>;
  claimExecution(input: ExecutionClaimInput): Promise<ExecutionClaim>;
  attachExecutionMessages(
    executionId: string,
    sourceMessageId: string,
    assistantMessageId: string | null,
  ): Promise<void>;
  finishExecution(
    executionId: string,
    status: Exclude<ScheduledTaskExecutionStatus, "processing">,
    response: string | null,
    error: string | null,
    assistantMessageId: string | null,
    finishedAt: Date,
  ): Promise<ScheduledTaskExecution>;
}

export class DrizzleSchedulerRepository implements SchedulerRepositoryPort {
  constructor(private readonly database: ShivaDatabase) {}

  async createTask(input: StoredScheduledTaskInput): Promise<ScheduledTask> {
    const [created] = await this.database
      .insert(scheduledTasks)
      .values({
        id: input.id,
        userId: input.userId,
        conversationId: input.conversationId,
        name: input.name,
        instruction: input.instruction,
        scheduleType: input.scheduleType,
        scheduleExpression: input.scheduleExpression,
        runAt: input.runAt,
        intervalSeconds: input.intervalSeconds,
        timezone: input.timezone,
        scheduleKey: input.scheduleKey,
        nextRunAt: input.nextRunAt,
        lastStatus: "pending",
        createdAt: input.now,
        updatedAt: input.now,
      })
      .returning();
    return requiredRow(created, "scheduled task");
  }

  async getTask(id: string): Promise<ScheduledTask | undefined> {
    const [task] = await this.database
      .select()
      .from(scheduledTasks)
      .where(eq(scheduledTasks.id, id))
      .limit(1);
    return task;
  }

  async getOwnedTask(
    userId: string,
    id: string,
  ): Promise<ScheduledTask | undefined> {
    const [task] = await this.database
      .select()
      .from(scheduledTasks)
      .where(and(eq(scheduledTasks.id, id), eq(scheduledTasks.userId, userId)))
      .limit(1);
    return task;
  }

  async listTasks(
    userId: string,
    enabled?: boolean,
  ): Promise<readonly ScheduledTask[]> {
    return this.database
      .select()
      .from(scheduledTasks)
      .where(
        enabled === undefined
          ? eq(scheduledTasks.userId, userId)
          : and(
              eq(scheduledTasks.userId, userId),
              eq(scheduledTasks.enabled, enabled),
            ),
      )
      .orderBy(desc(scheduledTasks.updatedAt), desc(scheduledTasks.id));
  }

  async listEnabledTasks(): Promise<readonly ScheduledTask[]> {
    return this.database
      .select()
      .from(scheduledTasks)
      .where(eq(scheduledTasks.enabled, true))
      .orderBy(scheduledTasks.createdAt, scheduledTasks.id);
  }

  async replaceConfiguration(
    userId: string,
    id: string,
    expectedRevision: number,
    configuration: ScheduledTaskConfiguration,
    now: Date,
  ): Promise<ScheduledTask | undefined> {
    const [updated] = await this.database
      .update(scheduledTasks)
      .set({
        ...configuration,
        revision: expectedRevision + 1,
        currentJobId: null,
        nextRunAt: null,
        lastStatus: "pending",
        lastError: null,
        updatedAt: now,
      })
      .where(
        and(
          eq(scheduledTasks.id, id),
          eq(scheduledTasks.userId, userId),
          eq(scheduledTasks.revision, expectedRevision),
        ),
      )
      .returning();
    return updated;
  }

  async setEnabled(
    userId: string,
    id: string,
    expectedRevision: number,
    enabled: boolean,
    now: Date,
  ): Promise<ScheduledTask | undefined> {
    const [updated] = await this.database
      .update(scheduledTasks)
      .set({
        enabled,
        revision: expectedRevision + 1,
        currentJobId: null,
        nextRunAt: null,
        lastStatus: enabled ? "pending" : "skipped",
        lastError: null,
        updatedAt: now,
      })
      .where(
        and(
          eq(scheduledTasks.id, id),
          eq(scheduledTasks.userId, userId),
          eq(scheduledTasks.revision, expectedRevision),
        ),
      )
      .returning();
    return updated;
  }

  async setInfrastructure(
    id: string,
    expectedRevision: number,
    currentJobId: string | null,
    nextRunAt: Date | null,
    now: Date,
  ): Promise<ScheduledTask | undefined> {
    const [updated] = await this.database
      .update(scheduledTasks)
      .set({ currentJobId, nextRunAt, updatedAt: now })
      .where(
        and(
          eq(scheduledTasks.id, id),
          eq(scheduledTasks.revision, expectedRevision),
          eq(scheduledTasks.enabled, true),
        ),
      )
      .returning();
    return updated;
  }

  async recordTaskStarted(
    id: string,
    expectedRevision: number,
    startedAt: Date,
  ): Promise<void> {
    await this.database
      .update(scheduledTasks)
      .set({
        lastRunAt: startedAt,
        lastStatus: "running",
        lastError: null,
        updatedAt: startedAt,
      })
      .where(
        and(
          eq(scheduledTasks.id, id),
          eq(scheduledTasks.revision, expectedRevision),
        ),
      );
  }

  async recordTaskResult(
    id: string,
    expectedRevision: number,
    status: Exclude<ScheduledTaskLastStatus, "pending" | "running">,
    error: string | null,
    finishedAt: Date,
    nextRunAt?: Date | null,
  ): Promise<void> {
    await this.database
      .update(scheduledTasks)
      .set({
        lastStatus: status,
        lastError: error,
        ...(nextRunAt !== undefined ? { nextRunAt } : {}),
        updatedAt: finishedAt,
      })
      .where(
        and(
          eq(scheduledTasks.id, id),
          eq(scheduledTasks.revision, expectedRevision),
        ),
      );
  }

  async completeOneTime(
    id: string,
    expectedRevision: number,
    jobId: string,
    status: "succeeded" | "failed",
    error: string | null,
    finishedAt: Date,
  ): Promise<void> {
    await this.database
      .update(scheduledTasks)
      .set({
        enabled: false,
        currentJobId: null,
        nextRunAt: null,
        lastStatus: status,
        lastError: error,
        updatedAt: finishedAt,
      })
      .where(
        and(
          eq(scheduledTasks.id, id),
          eq(scheduledTasks.revision, expectedRevision),
          eq(scheduledTasks.currentJobId, jobId),
        ),
      );
  }

  async advanceInterval(
    id: string,
    expectedRevision: number,
    currentJobId: string,
    nextJobId: string,
    nextRunAt: Date,
    now: Date,
  ): Promise<"advanced" | "already_advanced" | "stale"> {
    const [updated] = await this.database
      .update(scheduledTasks)
      .set({ currentJobId: nextJobId, nextRunAt, updatedAt: now })
      .where(
        and(
          eq(scheduledTasks.id, id),
          eq(scheduledTasks.revision, expectedRevision),
          eq(scheduledTasks.enabled, true),
          eq(scheduledTasks.scheduleType, "interval"),
          eq(scheduledTasks.currentJobId, currentJobId),
        ),
      )
      .returning({ id: scheduledTasks.id });
    if (updated) return "advanced";
    const task = await this.getTask(id);
    if (
      task?.enabled &&
      task.revision === expectedRevision &&
      task.currentJobId === nextJobId
    ) {
      return "already_advanced";
    }
    return "stale";
  }

  async setTaskConversation(
    id: string,
    conversationId: string,
    now: Date,
  ): Promise<void> {
    await this.database
      .update(scheduledTasks)
      .set({ conversationId, updatedAt: now })
      .where(eq(scheduledTasks.id, id));
  }

  async deleteTask(userId: string, id: string): Promise<boolean> {
    const deleted = await this.database
      .delete(scheduledTasks)
      .where(and(eq(scheduledTasks.id, id), eq(scheduledTasks.userId, userId)))
      .returning({ id: scheduledTasks.id });
    return deleted.length > 0;
  }

  async claimExecution(input: ExecutionClaimInput): Promise<ExecutionClaim> {
    const [created] = await this.database
      .insert(scheduledTaskExecutions)
      .values({
        scheduledTaskId: input.scheduledTaskId,
        pgBossJobId: input.pgBossJobId,
        occurrenceId: input.occurrenceId,
        scheduleRevision: input.scheduleRevision,
        triggeredAt: input.triggeredAt,
        startedAt: input.now,
      })
      .onConflictDoNothing()
      .returning();
    if (created) return { execution: created, claimed: true };

    const [existingByJob] = await this.database
      .select()
      .from(scheduledTaskExecutions)
      .where(eq(scheduledTaskExecutions.pgBossJobId, input.pgBossJobId))
      .limit(1);
    const existing =
      existingByJob ??
      (
        await this.database
          .select()
          .from(scheduledTaskExecutions)
          .where(
            and(
              eq(
                scheduledTaskExecutions.scheduledTaskId,
                input.scheduledTaskId,
              ),
              eq(scheduledTaskExecutions.occurrenceId, input.occurrenceId),
            ),
          )
          .limit(1)
      )[0];
    if (!existing) {
      throw new ScheduledTaskConflictError(
        "The scheduled occurrence conflicted with another execution.",
      );
    }
    if (
      existing.scheduledTaskId !== input.scheduledTaskId ||
      existing.scheduleRevision !== input.scheduleRevision
    ) {
      throw new ScheduledTaskConflictError(
        "The pg-boss job identifier is already bound to another schedule revision.",
      );
    }
    return { execution: existing, claimed: false };
  }

  async attachExecutionMessages(
    executionId: string,
    sourceMessageId: string,
    assistantMessageId: string | null,
  ): Promise<void> {
    await this.database
      .update(scheduledTaskExecutions)
      .set({
        sourceMessageId,
        ...(assistantMessageId ? { assistantMessageId } : {}),
      })
      .where(
        and(
          eq(scheduledTaskExecutions.id, executionId),
          eq(scheduledTaskExecutions.status, "processing"),
        ),
      );
  }

  async finishExecution(
    executionId: string,
    status: Exclude<ScheduledTaskExecutionStatus, "processing">,
    response: string | null,
    error: string | null,
    assistantMessageId: string | null,
    finishedAt: Date,
  ): Promise<ScheduledTaskExecution> {
    const [updated] = await this.database
      .update(scheduledTaskExecutions)
      .set({
        status,
        response,
        lastError: error,
        assistantMessageId,
        finishedAt,
      })
      .where(
        and(
          eq(scheduledTaskExecutions.id, executionId),
          eq(scheduledTaskExecutions.status, "processing"),
        ),
      )
      .returning();
    if (updated) return updated;
    const [existing] = await this.database
      .select()
      .from(scheduledTaskExecutions)
      .where(eq(scheduledTaskExecutions.id, executionId))
      .limit(1);
    return requiredRow(existing, "scheduled task execution");
  }
}

function requiredRow<T>(row: T | undefined, entity: string): T {
  if (!row) throw new Error(`Database did not return the ${entity}.`);
  return row;
}
