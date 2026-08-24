import { hostname } from "node:os";

import type {
  AgentTaskDelivery,
  RedisAgentTransport,
} from "./redis-agent-transport";
import { taskConsumerGroup, type AgentResponse, type AgentTask } from "./protocol";

const DEFAULT_MAX_ATTEMPTS = 3;
const DEFAULT_RECLAIM_IDLE_MS = 30_000;
const DEFAULT_READ_BLOCK_MS = 1_000;
const DEFAULT_BATCH_SIZE = 10;
const DEFAULT_HEARTBEAT_INTERVAL_MS = 5_000;
const DEFAULT_HEARTBEAT_TTL_MS = 15_000;
const DEFAULT_MAX_TRANSPORT_ERRORS = 5;
const DEFAULT_TRANSPORT_RETRY_DELAY_MS = 250;
const DEFAULT_MAX_TRANSPORT_RETRY_DELAY_MS = 5_000;

export interface AgentHandlerContext {
  readonly attempt: number;
  readonly recovered: boolean;
  readonly signal: AbortSignal;
}

export interface AgentHandlerResponse {
  readonly message: string;
  readonly metadata?: Readonly<Record<string, unknown>>;
}

export type AgentTaskHandler = (
  task: AgentTask,
  context: AgentHandlerContext,
) => Promise<string | AgentHandlerResponse>;

export interface AgentWorkerTransport
  extends Pick<
    RedisAgentTransport,
    | "ensureTaskConsumerGroup"
    | "claimStaleTasks"
    | "readTasks"
    | "publishResponse"
    | "hasPublishedResponse"
    | "acknowledgeTask"
    | "renewTaskLease"
    | "refreshAgentHeartbeat"
    | "clearAgentHeartbeat"
  > {}

export interface AgentWorkerOptions {
  readonly agentId: string;
  readonly handler: AgentTaskHandler;
  readonly transport: AgentWorkerTransport;
  readonly consumerName?: string;
  readonly maxAttempts?: number;
  readonly reclaimIdleMs?: number;
  readonly readBlockMs?: number;
  readonly batchSize?: number;
  readonly heartbeatIntervalMs?: number;
  readonly heartbeatTtlMs?: number;
  readonly maxConsecutiveTransportErrors?: number;
  readonly transportRetryDelayMs?: number;
  readonly maxTransportRetryDelayMs?: number;
  /** Defaults to one third of reclaimIdleMs so active work cannot be claimed. */
  readonly taskLeaseRenewIntervalMs?: number;
  readonly now?: () => Date;
  readonly onError?: (error: unknown) => void;
  readonly onRetry?: (detail: {
    readonly taskId: string;
    readonly attempt: number;
    readonly maxAttempts: number;
  }) => void;
}

/**
 * Long-running worker for one specialized agent process. A task is acknowledged
 * only after its natural-language response has been appended successfully.
 */
export class AgentWorker {
  readonly agentId: string;
  readonly consumerName: string;

  private readonly handler: AgentTaskHandler;
  private readonly transport: AgentWorkerTransport;
  private readonly maxAttempts: number;
  private readonly reclaimIdleMs: number;
  private readonly readBlockMs: number;
  private readonly batchSize: number;
  private readonly heartbeatIntervalMs: number;
  private readonly heartbeatTtlMs: number;
  private readonly maxConsecutiveTransportErrors: number;
  private readonly transportRetryDelayMs: number;
  private readonly maxTransportRetryDelayMs: number;
  private readonly taskLeaseRenewIntervalMs: number;
  private readonly now: () => Date;
  private readonly onError: (error: unknown) => void;
  private readonly onRetry: NonNullable<AgentWorkerOptions["onRetry"]>;
  private readonly stopController = new AbortController();
  private running: Promise<void> | undefined;

  constructor(options: AgentWorkerOptions) {
    // Validates the agent ID using the same contract as the transport group.
    taskConsumerGroup(options.agentId);
    this.agentId = options.agentId.trim();
    this.consumerName = normalizeConsumerName(
      options.consumerName ?? `${this.agentId}:${hostname()}:${process.pid}`,
    );
    this.handler = options.handler;
    this.transport = options.transport;
    this.maxAttempts = boundedPositiveInteger(
      options.maxAttempts,
      DEFAULT_MAX_ATTEMPTS,
      20,
      "maxAttempts",
    );
    this.reclaimIdleMs = nonNegativeInteger(
      options.reclaimIdleMs,
      DEFAULT_RECLAIM_IDLE_MS,
      "reclaimIdleMs",
    );
    this.readBlockMs = boundedPositiveInteger(
      options.readBlockMs,
      DEFAULT_READ_BLOCK_MS,
      5_000,
      "readBlockMs",
    );
    this.batchSize = boundedPositiveInteger(
      options.batchSize,
      DEFAULT_BATCH_SIZE,
      100,
      "batchSize",
    );
    this.heartbeatIntervalMs = boundedPositiveInteger(
      options.heartbeatIntervalMs,
      DEFAULT_HEARTBEAT_INTERVAL_MS,
      60_000,
      "heartbeatIntervalMs",
    );
    this.heartbeatTtlMs = boundedPositiveInteger(
      options.heartbeatTtlMs,
      DEFAULT_HEARTBEAT_TTL_MS,
      300_000,
      "heartbeatTtlMs",
    );
    if (this.heartbeatTtlMs <= this.heartbeatIntervalMs) {
      throw new Error("heartbeatTtlMs must be greater than heartbeatIntervalMs.");
    }
    this.maxConsecutiveTransportErrors = boundedPositiveInteger(
      options.maxConsecutiveTransportErrors,
      DEFAULT_MAX_TRANSPORT_ERRORS,
      100,
      "maxConsecutiveTransportErrors",
    );
    this.transportRetryDelayMs = boundedPositiveInteger(
      options.transportRetryDelayMs,
      DEFAULT_TRANSPORT_RETRY_DELAY_MS,
      60_000,
      "transportRetryDelayMs",
    );
    this.maxTransportRetryDelayMs = boundedPositiveInteger(
      options.maxTransportRetryDelayMs,
      Math.max(
        DEFAULT_MAX_TRANSPORT_RETRY_DELAY_MS,
        this.transportRetryDelayMs,
      ),
      60_000,
      "maxTransportRetryDelayMs",
    );
    if (this.maxTransportRetryDelayMs < this.transportRetryDelayMs) {
      throw new Error(
        "maxTransportRetryDelayMs must be greater than or equal to transportRetryDelayMs.",
      );
    }
    this.taskLeaseRenewIntervalMs = boundedPositiveInteger(
      options.taskLeaseRenewIntervalMs,
      Math.max(1, Math.floor(this.reclaimIdleMs / 3)),
      60_000,
      "taskLeaseRenewIntervalMs",
    );
    if (
      this.reclaimIdleMs > 0 &&
      this.taskLeaseRenewIntervalMs >= this.reclaimIdleMs
    ) {
      throw new Error("taskLeaseRenewIntervalMs must be less than reclaimIdleMs.");
    }
    this.now = options.now ?? (() => new Date());
    this.onError = options.onError ?? (() => {});
    this.onRetry = options.onRetry ?? (() => {});
  }

  start(signal?: AbortSignal): Promise<void> {
    if (this.running) {
      throw new Error(`Agent worker '${this.agentId}' is already running.`);
    }
    const workerSignal = signal
      ? AbortSignal.any([signal, this.stopController.signal])
      : this.stopController.signal;
    const run = this.runLoop(workerSignal);
    this.running = run;
    void run.finally(() => {
      if (this.running === run) this.running = undefined;
    }).catch(() => undefined);
    return run;
  }

  async stop(): Promise<void> {
    this.stopController.abort();
    await this.running;
  }

  private async runLoop(signal: AbortSignal): Promise<void> {
    await this.transport.ensureTaskConsumerGroup(this.agentId);
    await this.transport.refreshAgentHeartbeat(
      this.agentId,
      this.consumerName,
      this.heartbeatTtlMs,
    );
    const heartbeat = this.startHeartbeat(signal);
    let consecutiveTransportErrors = 0;

    try {
      while (!signal.aborted) {
        try {
          const recovered = await this.transport.claimStaleTasks(
            this.agentId,
            this.consumerName,
            { minIdleMs: this.reclaimIdleMs, count: this.batchSize },
          );
          const deliveries =
            recovered.length > 0
              ? recovered
              : await this.transport.readTasks(
                  this.agentId,
                  this.consumerName,
                  { blockMs: this.readBlockMs, count: this.batchSize },
                );
          // XREADGROUP can put an entire batch in this consumer's pending list.
          // Start leases for every entry before processing sequentially so a slow
          // first handler does not make later entries eligible for XAUTOCLAIM.
          const leasedDeliveries = deliveries.map((delivery) => ({
            delivery,
            lease: this.startTaskLease(delivery, signal),
          }));
          try {
            for (const { delivery, lease } of leasedDeliveries) {
              if (signal.aborted) break;
              await this.processDelivery(delivery, lease.signal);
              await lease.stop();
            }
          } finally {
            await Promise.all(leasedDeliveries.map(({ lease }) => lease.stop()));
          }
          consecutiveTransportErrors = 0;
        } catch (error: unknown) {
          if (signal.aborted) break;
          consecutiveTransportErrors += 1;
          this.onError(error);
          if (consecutiveTransportErrors >= this.maxConsecutiveTransportErrors) {
            throw new AgentWorkerTransportError(
              `Agent worker '${this.agentId}' stopped after ${consecutiveTransportErrors} consecutive transport failures.`,
              { cause: error },
            );
          }
          await abortableDelay(
            exponentialBackoff(
              this.transportRetryDelayMs,
              this.maxTransportRetryDelayMs,
              consecutiveTransportErrors,
            ),
            signal,
          );
        }
      }
    } finally {
      await heartbeat.stop();
      try {
        await this.transport.clearAgentHeartbeat(
          this.agentId,
          this.consumerName,
        );
      } catch (error: unknown) {
        if (!signal.aborted) this.onError(error);
      }
    }
  }

  private startHeartbeat(signal: AbortSignal): RefreshLoop {
    let inFlight: Promise<void> | undefined;
    const timer = setInterval(() => {
      if (signal.aborted || inFlight) return;
      inFlight = this.transport
        .refreshAgentHeartbeat(
          this.agentId,
          this.consumerName,
          this.heartbeatTtlMs,
        )
        .catch(this.onError)
        .finally(() => {
          inFlight = undefined;
        });
    }, this.heartbeatIntervalMs);
    timer.unref();
    return {
      stop: async () => {
        clearInterval(timer);
        await inFlight;
      },
    };
  }

  private startTaskLease(
    delivery: AgentTaskDelivery,
    workerSignal: AbortSignal,
  ): TaskLease {
    const leaseController = new AbortController();
    const signal = AbortSignal.any([workerSignal, leaseController.signal]);
    let stopped = false;
    let inFlight: Promise<void> | undefined;

    const renew = async (): Promise<void> => {
      try {
        const renewed = await this.transport.renewTaskLease(
          this.agentId,
          this.consumerName,
          delivery.streamId,
        );
        if (!renewed && !stopped) {
          leaseController.abort(
            new AgentTaskLeaseLostError(
              `Task '${delivery.task.id}' is no longer leased to this worker.`,
            ),
          );
        }
      } catch (error: unknown) {
        if (!stopped) {
          this.onError(error);
          // Fail closed: if ownership cannot be renewed, suppress a late result
          // that could race a different consumer after XAUTOCLAIM.
          leaseController.abort(error);
        }
      }
    };

    const timer = setInterval(() => {
      if (stopped || signal.aborted || inFlight) return;
      inFlight = renew().finally(() => {
        inFlight = undefined;
      });
    }, this.taskLeaseRenewIntervalMs);
    timer.unref();

    return {
      signal,
      stop: async () => {
        if (!stopped) {
          stopped = true;
          clearInterval(timer);
        }
        await inFlight;
      },
    };
  }

  private async processDelivery(
    delivery: AgentTaskDelivery,
    signal: AbortSignal,
  ): Promise<void> {
    if (signal.aborted) return;
    if (await this.transport.hasPublishedResponse(delivery.task.id)) {
      await this.transport.acknowledgeTask(this.agentId, delivery.streamId);
      return;
    }
    if (taskDeadlineExpired(delivery.task, this.now())) {
      await this.publishDeadlineAndAcknowledge(delivery);
      return;
    }
    if (delivery.attempt > this.maxAttempts) {
      await this.publishFailureAndAcknowledge(delivery);
      return;
    }

    let response: AgentHandlerResponse;
    const taskSignal = taskDeadlineSignal(delivery.task, signal, this.now());
    try {
      response = normalizeHandlerResponse(
        await this.handler(delivery.task, {
          attempt: delivery.attempt,
          recovered: delivery.recovered,
          signal: taskSignal,
        }),
      );
      taskSignal.throwIfAborted();
    } catch (error: unknown) {
      if (signal.aborted) return;
      if (taskDeadlineExpired(delivery.task, this.now())) {
        await this.publishDeadlineAndAcknowledge(delivery);
        return;
      }
      this.onError(error);
      if (delivery.attempt < this.maxAttempts) {
        this.onRetry({
          taskId: delivery.task.id,
          attempt: delivery.attempt,
          maxAttempts: this.maxAttempts,
        });
        // Deliberately leave the entry pending. XAUTOCLAIM redelivers it after
        // reclaimIdleMs, including after a process restart.
        return;
      }
      await this.publishFailureAndAcknowledge(delivery);
      return;
    }

    await this.publishAndAcknowledge(delivery, {
      taskId: delivery.task.id,
      agentId: this.agentId,
      message: response.message,
      ...(response.metadata ? { metadata: response.metadata } : {}),
      timestamp: this.now().toISOString(),
    });
  }

  private publishFailureAndAcknowledge(
    delivery: AgentTaskDelivery,
  ): Promise<void> {
    return this.publishAndAcknowledge(delivery, {
      taskId: delivery.task.id,
      agentId: this.agentId,
      message: `${this.agentId} could not complete the delegated task after ${delivery.attempt} attempts.`,
      metadata: {
        transportFailure: true,
        attempts: delivery.attempt,
      },
      timestamp: this.now().toISOString(),
    });
  }

  private publishDeadlineAndAcknowledge(
    delivery: AgentTaskDelivery,
  ): Promise<void> {
    return this.publishAndAcknowledge(delivery, {
      taskId: delivery.task.id,
      agentId: this.agentId,
      message: `${this.agentId} did not start or finish the delegated task before its deadline.`,
      metadata: { transportFailure: "AGENT_TASK_DEADLINE" },
      timestamp: this.now().toISOString(),
    });
  }

  private async publishAndAcknowledge(
    delivery: AgentTaskDelivery,
    response: AgentResponse,
  ): Promise<void> {
    await this.transport.publishResponse(response);
    await this.transport.acknowledgeTask(this.agentId, delivery.streamId);
  }
}

function taskDeadlineExpired(task: AgentTask, now: Date): boolean {
  if (!task.deadlineAt) return false;
  return new Date(task.deadlineAt).getTime() <= now.getTime();
}

function taskDeadlineSignal(
  task: AgentTask,
  signal: AbortSignal,
  now: Date,
): AbortSignal {
  if (!task.deadlineAt) return signal;
  const remaining = Math.max(
    1,
    new Date(task.deadlineAt).getTime() - now.getTime(),
  );
  return AbortSignal.any([signal, AbortSignal.timeout(remaining)]);
}

export class AgentWorkerTransportError extends Error {
  override readonly name = "AgentWorkerTransportError";
}

export class AgentTaskLeaseLostError extends Error {
  override readonly name = "AgentTaskLeaseLostError";
}

interface RefreshLoop {
  stop(): Promise<void>;
}

interface TaskLease extends RefreshLoop {
  readonly signal: AbortSignal;
}

function normalizeHandlerResponse(
  response: string | AgentHandlerResponse,
): AgentHandlerResponse {
  const normalized = typeof response === "string" ? { message: response } : response;
  const message = normalized.message.trim();
  if (!message) {
    throw new Error("Agent handlers must return a non-empty natural-language message.");
  }
  if (message.length > 20_000) {
    throw new Error("Agent handler messages cannot exceed 20,000 characters.");
  }
  return {
    message,
    ...(normalized.metadata !== undefined
      ? { metadata: normalized.metadata }
      : {}),
  };
}

function normalizeConsumerName(value: string): string {
  const normalized = value.trim();
  if (!normalized || normalized.length > 255) {
    throw new Error("Agent worker consumer names must contain 1-255 characters.");
  }
  return normalized;
}

function boundedPositiveInteger(
  value: number | undefined,
  fallback: number,
  maximum: number,
  name: string,
): number {
  const normalized = value ?? fallback;
  if (!Number.isInteger(normalized) || normalized < 1 || normalized > maximum) {
    throw new Error(`${name} must be an integer from 1 to ${maximum}.`);
  }
  return normalized;
}

function nonNegativeInteger(
  value: number | undefined,
  fallback: number,
  name: string,
): number {
  const normalized = value ?? fallback;
  if (!Number.isInteger(normalized) || normalized < 0) {
    throw new Error(`${name} must be a non-negative integer.`);
  }
  return normalized;
}

function exponentialBackoff(
  baseDelayMs: number,
  maximumDelayMs: number,
  attempt: number,
): number {
  return Math.min(maximumDelayMs, baseDelayMs * 2 ** Math.max(0, attempt - 1));
}

async function abortableDelay(milliseconds: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return;
  await new Promise<void>((resolve) => {
    const timer = setTimeout(finish, milliseconds);
    timer.unref();
    signal.addEventListener("abort", finish, { once: true });

    function finish(): void {
      clearTimeout(timer);
      signal.removeEventListener("abort", finish);
      resolve();
    }
  });
}
