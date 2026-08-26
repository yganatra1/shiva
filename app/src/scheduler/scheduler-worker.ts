import { z } from "zod";

import { ConfigurationError, loadSchedulerConfig } from "../config/environment";
import { createDatabase } from "../database/pool";
import {
  CoreTriggerPermanentError,
  CoreTriggerTransientError,
  HttpScheduledCoreClient,
  type ScheduledCoreClient,
} from "./core-trigger-client";
import {
  createSchedulerQueue,
  type SchedulerLogSink,
  type SchedulerQueueJob,
  type SchedulerQueuePort,
} from "./pg-boss";
import { DrizzleSchedulerRepository, type SchedulerRepositoryPort } from "./scheduler-repository";
import { SchedulerService } from "./scheduler-service";
import type { ScheduledTask } from "./scheduler-types";

const payloadSchema = z
  .object({
    scheduledTaskId: z.string().uuid(),
    scheduleType: z.enum(["once", "cron", "interval"]),
    scheduleRevision: z.number().int().positive(),
    scheduledFor: z.iso.datetime({ offset: true }).optional(),
  })
  .strict();
const MAX_TASK_ERROR_LENGTH = 2_000;

export interface SchedulerWorkerOptions {
  readonly queue: SchedulerQueuePort;
  readonly service: Pick<
    SchedulerService,
    "start" | "stop" | "advanceIntervalBeforeExecution" | "nextCronRun"
  >;
  readonly repository: SchedulerRepositoryPort;
  readonly core: ScheduledCoreClient;
  readonly logger: SchedulerLogSink;
  readonly now?: () => Date;
}

export class SchedulerWorker {
  private readonly now: () => Date;
  private started = false;

  constructor(private readonly options: SchedulerWorkerOptions) {
    this.now = options.now ?? (() => new Date());
  }

  async start(): Promise<void> {
    if (this.started) return;
    await this.options.service.start();
    await this.options.queue.work((job) => this.process(job));
    this.started = true;
    this.options.logger.info({}, "scheduler worker started");
  }

  async stop(): Promise<void> {
    if (!this.started) return;
    this.started = false;
    await this.options.service.stop();
    this.options.logger.info({}, "scheduler worker stopped");
  }

  async process(job: SchedulerQueueJob) {
    const parsed = payloadSchema.safeParse(job.data);
    if (!parsed.success) {
      this.options.logger.error(
        { jobId: job.id },
        "scheduler job payload rejected",
      );
      return {
        status: "deadletter" as const,
        error: "Invalid scheduler job payload.",
      };
    }
    const payload = parsed.data;
    const task = await this.options.repository.getTask(payload.scheduledTaskId);
    this.options.logger.info(
      {
        scheduledTaskId: payload.scheduledTaskId,
        jobId: job.id,
        occurrenceId: job.id,
        revision: payload.scheduleRevision,
      },
      "scheduler job received",
    );
    if (
      !task ||
      !isCurrentTask(task, payload.scheduleRevision, payload.scheduleType)
    ) {
      if (task) {
        await this.options.repository.recordTaskResult(
          task.id,
          task.revision,
          "skipped",
          null,
          this.now(),
        );
      }
      return { status: "completed" as const };
    }

    const startedAt = this.now();
    if (task.scheduleType === "interval") {
      const scheduledFor = new Date(payload.scheduledFor ?? "");
      if (!Number.isFinite(scheduledFor.getTime())) {
        return {
          status: "deadletter" as const,
          error: "Interval occurrence is missing scheduledFor.",
        };
      }
      const current = await this.options.service.advanceIntervalBeforeExecution(
        task,
        job.id,
        scheduledFor,
        startedAt,
      );
      if (!current) return { status: "completed" as const };
    }

    await this.options.repository.recordTaskStarted(
      task.id,
      task.revision,
      startedAt,
    );
    this.options.logger.info(
      {
        scheduledTaskId: task.id,
        jobId: job.id,
        occurrenceId: job.id,
      },
      "scheduler core trigger started",
    );
    try {
      await this.options.core.trigger(
        {
          source: "scheduled_task",
          scheduledTaskId: task.id,
          scheduleRevision: task.revision,
          jobId: job.id,
          occurrenceId: job.id,
          triggeredAt: startedAt.toISOString(),
        },
        job.signal,
      );
      const finishedAt = this.now();
      if (task.scheduleType === "once") {
        await this.options.repository.completeOneTime(
          task.id,
          task.revision,
          job.id,
          "succeeded",
          null,
          finishedAt,
        );
      } else {
        await this.options.repository.recordTaskResult(
          task.id,
          task.revision,
          "succeeded",
          null,
          finishedAt,
          task.scheduleType === "cron"
            ? this.options.service.nextCronRun(task, finishedAt)
            : undefined,
        );
      }
      return { status: "completed" as const };
    } catch (error: unknown) {
      const message = safeTaskError(error);
      const finishedAt = this.now();
      const permanent = error instanceof CoreTriggerPermanentError;
      if (permanent && task.scheduleType === "once") {
        await this.options.repository.completeOneTime(
          task.id,
          task.revision,
          job.id,
          "failed",
          message,
          finishedAt,
        );
      } else {
        await this.options.repository.recordTaskResult(
          task.id,
          task.revision,
          "failed",
          message,
          finishedAt,
          task.scheduleType === "cron"
            ? this.options.service.nextCronRun(task, finishedAt)
            : undefined,
        );
      }
      this.options.logger.error(
        {
          scheduledTaskId: task.id,
          jobId: job.id,
          occurrenceId: job.id,
          retryable: !permanent,
          error: message,
        },
        "scheduler core trigger failed",
      );
      return permanent
        ? { status: "deadletter" as const, error: message }
        : { status: "failed" as const, error: message };
    }
  }
}

function isCurrentTask(
  task: ScheduledTask,
  revision: number,
  scheduleType: ScheduledTask["scheduleType"],
): boolean {
  return (
    task.enabled &&
    task.revision === revision &&
    task.scheduleType === scheduleType
  );
}

function safeTaskError(error: unknown): string {
  const message =
    error instanceof CoreTriggerTransientError ||
    error instanceof CoreTriggerPermanentError
      ? error.message
      : error instanceof Error
        ? error.message
        : "Unknown scheduler worker error";
  return message.slice(0, MAX_TASK_ERROR_LENGTH);
}

async function run(): Promise<void> {
  const config = loadSchedulerConfig();
  const logger = consoleSchedulerLogger();
  const database = createDatabase({
    databaseUrl: config.databaseUrl,
    databaseSsl: config.databaseSsl,
    databasePoolMax: config.schedulerDatabasePoolMax,
  });
  const repository = new DrizzleSchedulerRepository(database.db);
  const queue = createSchedulerQueue({
    databaseUrl: config.databaseUrl,
    databaseSsl: config.databaseSsl,
    poolMax: config.schedulerDatabasePoolMax,
    monitorSchedules: true,
    applicationName: "shiva-scheduler",
    logger,
  });
  const service = new SchedulerService({
    queue,
    repository,
    queueOptions: config.schedulerQueueOptions,
    logger,
  });
  const worker = new SchedulerWorker({
    queue,
    service,
    repository,
    core: new HttpScheduledCoreClient({
      baseUrl: config.schedulerCoreUrl,
      token: config.schedulerToken,
      timeoutMs: config.schedulerCoreTimeoutMs,
    }),
    logger,
  });
  let shuttingDown = false;
  const shutdown = async (signal: NodeJS.Signals): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info({ signal }, "scheduler shutting down");
    try {
      await worker.stop();
      await database.pool.end();
    } catch (error: unknown) {
      logger.error({ err: error }, "scheduler shutdown failed");
      process.exitCode = 1;
    }
  };
  process.once("SIGINT", () => void shutdown("SIGINT"));
  process.once("SIGTERM", () => void shutdown("SIGTERM"));
  await worker.start();
}

function consoleSchedulerLogger(): SchedulerLogSink {
  return {
    info(detail, message) {
      console.info(`[SHIVA-TRACE] ${message}`, detail);
    },
    warn(detail, message) {
      console.warn(`[SHIVA-TRACE] ${message}`, detail);
    },
    error(detail, message) {
      console.error(`[SHIVA-TRACE] ${message}`, detail);
    },
  };
}

if (process.env.NODE_ENV !== "test") {
  void run().catch((error: unknown) => {
    if (error instanceof ConfigurationError) console.error(error.message);
    else console.error("shiva-scheduler failed", error);
    process.exitCode = 1;
  });
}
