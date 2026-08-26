import { createHash, randomUUID } from "node:crypto";
import { CronExpressionParser } from "cron-parser";

import type {
  SchedulerLogSink,
  SchedulerQueueOptions,
  SchedulerQueuePort,
} from "./pg-boss";
import type {
  ScheduledTaskConfiguration,
  SchedulerRepositoryPort,
} from "./scheduler-repository";
import {
  ScheduledTaskConflictError,
  ScheduledTaskNotFoundError,
  SchedulerValidationError,
  type CreateScheduledTaskInput,
  type ScheduledTask,
  type SchedulerJobPayload,
  type UpdateScheduledTaskInput,
} from "./scheduler-types";

const MAX_NAME_LENGTH = 200;
const MAX_INSTRUCTION_LENGTH = 8_000;
const MAX_ERROR_LENGTH = 2_000;

export interface SchedulerServiceOptions {
  readonly queue: SchedulerQueuePort;
  readonly repository: SchedulerRepositoryPort;
  readonly queueOptions: SchedulerQueueOptions;
  readonly logger: SchedulerLogSink;
  readonly now?: () => Date;
}

export class SchedulerService {
  private readonly now: () => Date;
  private started = false;

  constructor(private readonly options: SchedulerServiceOptions) {
    this.now = options.now ?? (() => new Date());
  }

  async start(): Promise<void> {
    if (this.started) return;
    await this.options.queue.start();
    await this.options.queue.ensureQueue(this.options.queueOptions);
    await this.reconcile();
    this.started = true;
    this.options.logger.info({}, "scheduler started");
  }

  async stop(): Promise<void> {
    if (!this.started) return;
    this.started = false;
    await this.options.queue.stop();
    this.options.logger.info({}, "scheduler stopped");
  }

  async create(input: CreateScheduledTaskInput): Promise<ScheduledTask> {
    const now = this.now();
    const id = randomUUID();
    const configuration = validateConfiguration(
      {
        name: input.name,
        instruction: input.instruction,
        scheduleType: input.scheduleType,
        scheduleExpression: input.scheduleExpression ?? null,
        runAt: input.runAt ?? null,
        intervalSeconds: input.intervalSeconds ?? null,
        timezone: input.timezone,
        scheduleKey: input.scheduleType === "cron" ? id : null,
      },
      now,
      false,
    );
    const nextRunAt = initialNextRun(configuration, now);
    const task = await this.options.repository.createTask({
      id,
      userId: input.userId,
      conversationId: input.conversationId,
      ...configuration,
      nextRunAt,
      now,
    });
    try {
      const provisioned = await this.provision(task, now);
      this.options.logger.info(
        {
          scheduledTaskId: task.id,
          scheduleType: task.scheduleType,
          revision: task.revision,
        },
        "scheduler task created",
      );
      return provisioned;
    } catch (error: unknown) {
      await this.options.repository.deleteTask(task.userId, task.id);
      throw error;
    }
  }

  async update(
    userId: string,
    id: string,
    patch: UpdateScheduledTaskInput,
  ): Promise<ScheduledTask> {
    const existing = await this.requiredOwnedTask(userId, id);
    const now = this.now();
    const scheduleType = patch.scheduleType ?? existing.scheduleType;
    const typeChanged = scheduleType !== existing.scheduleType;
    const configuration = validateConfiguration(
      {
        name: patch.name ?? existing.name,
        instruction: patch.instruction ?? existing.instruction,
        scheduleType,
        scheduleExpression:
          patch.scheduleExpression !== undefined
            ? patch.scheduleExpression
            : typeChanged
              ? null
              : existing.scheduleExpression,
        runAt:
          patch.runAt !== undefined
            ? patch.runAt
            : typeChanged
              ? null
              : existing.runAt,
        intervalSeconds:
          patch.intervalSeconds !== undefined
            ? patch.intervalSeconds
            : typeChanged
              ? null
              : existing.intervalSeconds,
        timezone: patch.timezone ?? existing.timezone,
        scheduleKey: scheduleType === "cron" ? existing.id : null,
      },
      now,
      false,
    );
    const updated = await this.options.repository.replaceConfiguration(
      userId,
      id,
      existing.revision,
      configuration,
      now,
    );
    if (!updated) throw concurrentChange();
    await this.deprovision(existing);
    const provisioned = updated.enabled
      ? await this.provision(updated, now)
      : updated;
    this.options.logger.info(
      {
        scheduledTaskId: id,
        scheduleType: provisioned.scheduleType,
        revision: provisioned.revision,
      },
      "scheduler task updated",
    );
    return provisioned;
  }

  async pause(userId: string, id: string): Promise<ScheduledTask> {
    const existing = await this.requiredOwnedTask(userId, id);
    if (!existing.enabled) return existing;
    const now = this.now();
    const paused = await this.options.repository.setEnabled(
      userId,
      id,
      existing.revision,
      false,
      now,
    );
    if (!paused) throw concurrentChange();
    await this.deprovision(existing);
    this.options.logger.info(
      { scheduledTaskId: id, revision: paused.revision },
      "scheduler task paused",
    );
    return paused;
  }

  async resume(userId: string, id: string): Promise<ScheduledTask> {
    const existing = await this.requiredOwnedTask(userId, id);
    if (existing.enabled) return existing;
    const now = this.now();
    // An overdue one-time reminder is intentionally valid on resume and is
    // submitted with a past startAfter so pg-boss runs it promptly.
    validateConfiguration(existing, now, true);
    const resumed = await this.options.repository.setEnabled(
      userId,
      id,
      existing.revision,
      true,
      now,
    );
    if (!resumed) throw concurrentChange();
    try {
      const provisioned = await this.provision(resumed, now);
      this.options.logger.info(
        { scheduledTaskId: id, revision: provisioned.revision },
        "scheduler task resumed",
      );
      return provisioned;
    } catch (error: unknown) {
      await this.options.repository.setEnabled(
        userId,
        id,
        resumed.revision,
        false,
        this.now(),
      );
      throw error;
    }
  }

  async delete(userId: string, id: string): Promise<boolean> {
    const existing = await this.options.repository.getOwnedTask(userId, id);
    if (!existing) return false;
    const deleted = await this.options.repository.deleteTask(userId, id);
    if (!deleted) return false;
    await this.deprovision(existing);
    this.options.logger.info(
      { scheduledTaskId: id },
      "scheduler task deleted",
    );
    return true;
  }

  get(userId: string, id: string): Promise<ScheduledTask | undefined> {
    return this.options.repository.getOwnedTask(userId, id);
  }

  list(
    userId: string,
    enabled?: boolean,
  ): Promise<readonly ScheduledTask[]> {
    return this.options.repository.listTasks(userId, enabled);
  }

  /** Repairs metadata-to-pg-boss gaps after an API/VM restart. */
  async reconcile(): Promise<void> {
    const tasks = await this.options.repository.listEnabledTasks();
    let reconciled = 0;
    for (const task of tasks) {
      try {
        validateConfiguration(task, this.now(), true);
        await this.provision(task, this.now());
        reconciled += 1;
      } catch (error: unknown) {
        const message = safeError(error);
        await this.options.repository.recordTaskResult(
          task.id,
          task.revision,
          "failed",
          message,
          this.now(),
        );
        this.options.logger.error(
          {
            scheduledTaskId: task.id,
            revision: task.revision,
            error: message,
          },
          "scheduler task reconciliation failed",
        );
      }
    }
    this.options.logger.info(
      { scheduledTasks: tasks.length, reconciled },
      "scheduler reconciliation completed",
    );
  }

  /**
   * Chained interval jobs are anchored to their prior due time. Downtime skips
   * elapsed slots and creates exactly the first future occurrence, never a
   * backlog. The deterministic UUID makes a worker retry idempotent.
   */
  async advanceIntervalBeforeExecution(
    task: ScheduledTask,
    currentJobId: string,
    scheduledFor: Date,
    now: Date,
  ): Promise<boolean> {
    if (task.scheduleType !== "interval" || !task.intervalSeconds) return true;
    const nextRunAt = nextAnchoredInterval(
      scheduledFor,
      task.intervalSeconds,
      now,
    );
    const nextJobId = occurrenceJobId(task.id, task.revision, nextRunAt);
    const payload: SchedulerJobPayload = {
      scheduledTaskId: task.id,
      scheduleType: "interval",
      scheduleRevision: task.revision,
      scheduledFor: nextRunAt.toISOString(),
    };
    await this.options.queue.send(
      nextJobId,
      payload,
      nextRunAt,
      this.options.queueOptions,
    );
    const advanced = await this.options.repository.advanceInterval(
      task.id,
      task.revision,
      currentJobId,
      nextJobId,
      nextRunAt,
      now,
    );
    if (advanced === "stale") {
      await this.options.queue.cancel(nextJobId);
      return false;
    }
    return true;
  }

  nextCronRun(task: ScheduledTask, after: Date): Date | null {
    if (task.scheduleType !== "cron" || !task.scheduleExpression) return null;
    return cronNext(task.scheduleExpression, task.timezone, after);
  }

  private async requiredOwnedTask(
    userId: string,
    id: string,
  ): Promise<ScheduledTask> {
    const task = await this.options.repository.getOwnedTask(userId, id);
    if (!task) {
      throw new ScheduledTaskNotFoundError(
        "The requested scheduled task does not exist.",
      );
    }
    return task;
  }

  private async provision(task: ScheduledTask, now: Date): Promise<ScheduledTask> {
    if (!task.enabled) return task;
    if (task.scheduleType === "cron") {
      const expression = required(task.scheduleExpression, "cron expression");
      await this.options.queue.schedule(
        task.id,
        expression,
        task.timezone,
        {
          scheduledTaskId: task.id,
          scheduleType: "cron",
          scheduleRevision: task.revision,
        },
        this.options.queueOptions,
      );
      const updated = await this.options.repository.setInfrastructure(
        task.id,
        task.revision,
        null,
        cronNext(expression, task.timezone, now),
        now,
      );
      return updated ?? task;
    }

    const runAt =
      task.scheduleType === "once"
        ? required(task.runAt, "one-time run date")
        : task.nextRunAt ??
          new Date(now.getTime() + required(task.intervalSeconds, "interval") * 1_000);
    const jobId = occurrenceJobId(task.id, task.revision, runAt);
    await this.options.queue.send(
      jobId,
      {
        scheduledTaskId: task.id,
        scheduleType: task.scheduleType,
        scheduleRevision: task.revision,
        scheduledFor: runAt.toISOString(),
      },
      runAt,
      this.options.queueOptions,
    );
    const updated = await this.options.repository.setInfrastructure(
      task.id,
      task.revision,
      jobId,
      runAt,
      now,
    );
    return updated ?? task;
  }

  private async deprovision(task: ScheduledTask): Promise<void> {
    const operations: Promise<unknown>[] = [];
    if (task.scheduleType === "cron") {
      operations.push(this.options.queue.unschedule(task.id));
    }
    if (task.currentJobId) {
      operations.push(this.options.queue.cancel(task.currentJobId));
    }
    const results = await Promise.allSettled(operations);
    for (const result of results) {
      if (result.status === "rejected") {
        this.options.logger.warn(
          { scheduledTaskId: task.id, err: result.reason },
          "scheduler stale job cleanup failed",
        );
      }
    }
  }
}

export function occurrenceJobId(
  taskId: string,
  revision: number,
  scheduledFor: Date,
): string {
  const hex = createHash("sha256")
    .update(`${taskId}\u0000${revision}\u0000${scheduledFor.toISOString()}`)
    .digest("hex")
    .slice(0, 32)
    .split("");
  hex[12] = "5";
  const variant = Number.parseInt(hex[16] ?? "0", 16);
  hex[16] = ((variant & 0x3) | 0x8).toString(16);
  const value = hex.join("");
  return `${value.slice(0, 8)}-${value.slice(8, 12)}-${value.slice(12, 16)}-${value.slice(16, 20)}-${value.slice(20)}`;
}

export function nextAnchoredInterval(
  scheduledFor: Date,
  intervalSeconds: number,
  now: Date,
): Date {
  const intervalMs = intervalSeconds * 1_000;
  const elapsed = Math.max(0, now.getTime() - scheduledFor.getTime());
  const slots = Math.floor(elapsed / intervalMs) + 1;
  return new Date(scheduledFor.getTime() + slots * intervalMs);
}

function validateConfiguration(
  candidate: ScheduledTaskConfiguration | ScheduledTask,
  now: Date,
  allowOverdueOnce: boolean,
): ScheduledTaskConfiguration {
  const name = boundedText(candidate.name, "name", MAX_NAME_LENGTH);
  const instruction = boundedText(
    candidate.instruction,
    "instruction",
    MAX_INSTRUCTION_LENGTH,
  );
  const timezone = boundedText(candidate.timezone, "timezone", 255);
  assertTimeZone(timezone);
  const scheduleExpression = candidate.scheduleExpression ?? null;
  const runAt = candidate.runAt ?? null;
  const intervalSeconds = candidate.intervalSeconds ?? null;
  const scheduleKey = candidate.scheduleKey ?? null;

  switch (candidate.scheduleType) {
    case "once":
      if (!runAt || scheduleExpression || intervalSeconds || scheduleKey) {
        throw new SchedulerValidationError(
          "A one-time task requires only runAt.",
        );
      }
      if (!Number.isFinite(runAt.getTime())) {
        throw new SchedulerValidationError("runAt must be a valid ISO date.");
      }
      if (!allowOverdueOnce && runAt.getTime() <= now.getTime()) {
        throw new SchedulerValidationError("runAt must be in the future.");
      }
      break;
    case "cron":
      if (!scheduleExpression || runAt || intervalSeconds || !scheduleKey) {
        throw new SchedulerValidationError(
          "A cron task requires only scheduleExpression.",
        );
      }
      cronNext(scheduleExpression, timezone, now);
      break;
    case "interval":
      if (scheduleExpression || runAt || !intervalSeconds || scheduleKey) {
        throw new SchedulerValidationError(
          "An interval task requires only intervalSeconds.",
        );
      }
      if (!Number.isInteger(intervalSeconds) || intervalSeconds < 1) {
        throw new SchedulerValidationError(
          "intervalSeconds must be a positive integer.",
        );
      }
      break;
  }

  return {
    name,
    instruction,
    scheduleType: candidate.scheduleType,
    scheduleExpression,
    runAt,
    intervalSeconds,
    timezone,
    scheduleKey,
  };
}

function initialNextRun(
  configuration: ScheduledTaskConfiguration,
  now: Date,
): Date {
  switch (configuration.scheduleType) {
    case "once":
      return required(configuration.runAt, "one-time run date");
    case "cron":
      return cronNext(
        required(configuration.scheduleExpression, "cron expression"),
        configuration.timezone,
        now,
      );
    case "interval":
      return new Date(
        now.getTime() +
          required(configuration.intervalSeconds, "interval") * 1_000,
      );
  }
}

function cronNext(expression: string, timezone: string, after: Date): Date {
  if (expression.trim().split(/\s+/u).length !== 5) {
    throw new SchedulerValidationError(
      "scheduleExpression must use a five-field cron expression.",
    );
  }
  try {
    return CronExpressionParser.parse(expression, {
      currentDate: after,
      tz: timezone,
    })
      .next()
      .toDate();
  } catch (error: unknown) {
    throw new SchedulerValidationError("scheduleExpression is invalid.", {
      cause: error,
    });
  }
}

function assertTimeZone(timezone: string): void {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: timezone }).format();
  } catch (error: unknown) {
    throw new SchedulerValidationError("timezone must be a valid IANA zone.", {
      cause: error,
    });
  }
}

function boundedText(value: string, name: string, max: number): string {
  const normalized = value.trim();
  if (!normalized || normalized.length > max) {
    throw new SchedulerValidationError(
      `${name} must contain between 1 and ${max} characters.`,
    );
  }
  return normalized;
}

function required<T>(value: T | null, name: string): T {
  if (value === null) {
    throw new SchedulerValidationError(`The ${name} is missing.`);
  }
  return value;
}

function concurrentChange(): ScheduledTaskConflictError {
  return new ScheduledTaskConflictError(
    "The scheduled task changed concurrently. Refresh it and retry.",
  );
}

function safeError(error: unknown): string {
  const message = error instanceof Error ? error.message : "Unknown scheduler error";
  return message.slice(0, MAX_ERROR_LENGTH);
}
