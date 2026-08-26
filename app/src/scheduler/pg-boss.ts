import { PgBoss, type Job } from "pg-boss";

import { SCHEDULER_QUEUE, type SchedulerJobPayload } from "./scheduler-types";

export interface SchedulerLogSink {
  info(detail: Readonly<Record<string, unknown>>, message: string): void;
  warn(detail: Readonly<Record<string, unknown>>, message: string): void;
  error(detail: Readonly<Record<string, unknown>>, message: string): void;
}

export interface SchedulerQueueOptions {
  readonly retryLimit: number;
  readonly retryDelaySeconds: number;
  readonly expireInSeconds: number;
  readonly heartbeatSeconds: number;
  readonly retentionSeconds: number;
  readonly deleteAfterSeconds: number;
}

export interface SchedulerQueueJob {
  readonly id: string;
  readonly data: SchedulerJobPayload;
  readonly signal: AbortSignal;
}

export type SchedulerJobDisposition =
  | { readonly status: "completed" }
  | { readonly status: "failed"; readonly error: string }
  | { readonly status: "deadletter"; readonly error: string };

export interface SchedulerQueuePort {
  start(): Promise<void>;
  stop(): Promise<void>;
  ensureQueue(options: SchedulerQueueOptions): Promise<void>;
  send(
    jobId: string,
    payload: SchedulerJobPayload,
    startAfter: Date,
    options: SchedulerQueueOptions,
  ): Promise<string | null>;
  schedule(
    key: string,
    cron: string,
    timezone: string,
    payload: SchedulerJobPayload,
    options: SchedulerQueueOptions,
  ): Promise<void>;
  unschedule(key: string): Promise<void>;
  cancel(jobId: string): Promise<void>;
  work(
    handler: (job: SchedulerQueueJob) => Promise<SchedulerJobDisposition>,
  ): Promise<string>;
}

export interface CreateSchedulerQueueOptions {
  readonly databaseUrl: string;
  readonly databaseSsl: boolean;
  readonly poolMax: number;
  readonly monitorSchedules: boolean;
  readonly applicationName: string;
  readonly logger: SchedulerLogSink;
}

/** One adapter keeps pg-boss construction and exact v12 APIs consistent. */
export function createSchedulerQueue(
  options: CreateSchedulerQueueOptions,
): SchedulerQueuePort {
  const boss = new PgBoss({
    connectionString: options.databaseUrl,
    ssl: options.databaseSsl ? { rejectUnauthorized: true } : false,
    max: options.poolMax,
    schema: "pgboss",
    application_name: options.applicationName,
    schedule: options.monitorSchedules,
    useListenNotify: options.monitorSchedules,
    connectionTimeoutMillis: 10_000,
  });
  boss.on("error", (error) => {
    options.logger.error({ err: error }, "pg-boss scheduler error");
  });
  boss.on("warning", (warning) => {
    options.logger.warn({ warning }, "pg-boss scheduler warning");
  });

  return {
    async start() {
      await boss.start();
    },
    async stop() {
      await boss.stop({ graceful: true, timeout: 30_000 });
    },
    async ensureQueue(queueOptions) {
      const settings = pgBossQueueOptions(queueOptions);
      await boss.createQueue(SCHEDULER_QUEUE, {
        ...settings,
        notify: true,
      });
      await boss.updateQueue(SCHEDULER_QUEUE, {
        ...settings,
        notify: true,
      });
    },
    send(jobId, payload, startAfter, queueOptions) {
      return boss.send(SCHEDULER_QUEUE, payload, {
        id: jobId,
        startAfter,
        ...pgBossQueueOptions(queueOptions),
      });
    },
    schedule(key, cron, timezone, payload, queueOptions) {
      return boss.schedule(SCHEDULER_QUEUE, cron, payload, {
        key,
        tz: timezone,
        ...pgBossQueueOptions(queueOptions),
      });
    },
    async unschedule(key) {
      // pg-boss 12.28 deletes only the empty key when key is omitted.
      await boss.unschedule(SCHEDULER_QUEUE, key);
    },
    async cancel(jobId) {
      await boss.cancel(SCHEDULER_QUEUE, jobId);
    },
    work(handler) {
      return boss.work<SchedulerJobPayload, unknown, {
        batchSize: 1;
        perJobResults: true;
        localConcurrency: 1;
        pollingIntervalSeconds: 2;
        heartbeatRefreshSeconds: number;
      }>(
        SCHEDULER_QUEUE,
        {
          batchSize: 1,
          perJobResults: true,
          localConcurrency: 1,
          pollingIntervalSeconds: 2,
          heartbeatRefreshSeconds: 10,
        },
        async (jobs) => {
          const results = [];
          for (const job of jobs) {
            const disposition = await handler(publicJob(job));
            results.push(
              disposition.status === "completed"
                ? { id: job.id, status: "completed" as const }
                : {
                    id: job.id,
                    status: disposition.status,
                    output: { error: disposition.error },
                  },
            );
          }
          return results;
        },
      );
    },
  };
}

function pgBossQueueOptions(options: SchedulerQueueOptions) {
  return {
    retryLimit: options.retryLimit,
    retryDelay: options.retryDelaySeconds,
    retryBackoff: true,
    expireInSeconds: options.expireInSeconds,
    heartbeatSeconds: options.heartbeatSeconds,
    retentionSeconds: options.retentionSeconds,
    deleteAfterSeconds: options.deleteAfterSeconds,
  } as const;
}

function publicJob(job: Job<SchedulerJobPayload>): SchedulerQueueJob {
  return { id: job.id, data: job.data, signal: job.signal };
}
