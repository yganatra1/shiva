import { randomUUID } from "node:crypto";

import type { AgentOrchestratorPort, AgentRunResult } from "../agent/types";
import {
  OrchestrationRepositoryError,
  type AcceptedAgentResponse,
  type OrchestrationRepositoryPort,
  type PlainAgentResponseEnvelope,
} from "../agents/orchestration-repository";
import type {
  AgentResponseDelivery,
  ClaimOptions,
  RedisAgentTransport,
} from "../agents/shared/redis-agent-transport";
import type { AgentResponse } from "../agents/shared/protocol";
import type { MemoryRepositoryPort } from "../memory/types";
import { scheduledTaskTriggerFromMetadata } from "./request-trigger";
import type { CoreUpdatePublisher } from "./core-update-hub";

const DEFAULT_BATCH_SIZE = 10;
const REDIS_LOOP_RETRY_BASE_MS = 100;
const REDIS_LOOP_RETRY_MAX_MS = 5_000;

export interface CoreAgentResponseProcessorOptions {
  readonly transport: Pick<
    RedisAgentTransport,
    | "ensureResponseConsumerGroup"
    | "readResponses"
    | "claimStaleResponses"
    | "acknowledgeResponse"
  >;
  readonly repository: OrchestrationRepositoryPort;
  readonly conversationRepository: Pick<
    MemoryRepositoryPort,
    "getRecentMessages"
  > &
    Partial<Pick<MemoryRepositoryPort, "getMessageById">>;
  readonly orchestrator: AgentOrchestratorPort;
  readonly updates: CoreUpdatePublisher;
  readonly userName: string;
  readonly timeZone: string;
  readonly workingMemoryMessageLimit: number;
  readonly reclaimIdleMs: number;
  /** Must exceed the longest bounded Core planning pass to fence consumers. */
  readonly processingLeaseMs: number;
  readonly maxProcessingAttempts: number;
  readonly consumerName?: string;
  readonly now?: () => Date;
  readonly onError?: (error: unknown) => void;
}

/**
 * Core's only agent-response ingress. It correlates by task id, reloads the
 * original request and immutable executionContext, and starts a fresh Core
 * reasoning pass. Agent text never becomes a user message or direct command.
 */
export class CoreAgentResponseProcessor {
  private readonly consumerName: string;
  private readonly now: () => Date;
  private readonly onError: (error: unknown) => void;
  private readonly abortController = new AbortController();
  private loopPromise: Promise<void> | undefined;

  constructor(private readonly options: CoreAgentResponseProcessorOptions) {
    this.consumerName =
      options.consumerName ?? `core-${process.pid}-${randomUUID()}`;
    this.now = options.now ?? (() => new Date());
    this.onError = options.onError ?? (() => {});
    assertPositiveInteger(
      options.workingMemoryMessageLimit,
      "workingMemoryMessageLimit",
    );
    assertPositiveInteger(options.reclaimIdleMs, "reclaimIdleMs");
    assertPositiveInteger(options.processingLeaseMs, "processingLeaseMs");
    assertPositiveInteger(
      options.maxProcessingAttempts,
      "maxProcessingAttempts",
    );
  }

  async start(): Promise<void> {
    if (this.loopPromise) return;
    await this.options.transport.ensureResponseConsumerGroup();
    this.loopPromise = this.runLoop();
  }

  async stop(): Promise<void> {
    this.abortController.abort();
    await this.loopPromise;
  }

  /** Public seam for deadline recovery and deterministic tests. */
  async processResponse(
    response: AgentResponse,
    redisMessageId: string,
    _attempt = 1,
  ): Promise<void> {
    const accepted = await this.options.repository.acceptResponse(
      response,
      redisMessageId,
    );
    await this.processAcceptedResponse(accepted);
  }

  /** Recovers responses durably ingested before a Core restart or failure. */
  async recoverUnprocessed(limit = DEFAULT_BATCH_SIZE): Promise<void> {
    const candidates = await this.options.repository.listUnprocessedResponses(
      this.staleProcessingBoundary(),
      limit,
    );
    for (const candidate of candidates) {
      try {
        await this.processAcceptedResponse(candidate);
      } catch (error: unknown) {
        this.onError(error);
      }
    }
  }

  private async processAcceptedResponse(
    candidate: AcceptedAgentResponse,
  ): Promise<void> {
    if (candidate.response.processedAt) return;
    const claimedAt = this.now();
    const accepted = await this.options.repository.claimResponseProcessing(
      candidate.response.id,
      claimedAt,
      this.staleProcessingBoundary(claimedAt),
    );
    if (!accepted) return;
    try {
      if (
        accepted.response.processingAttempts >
        this.options.maxProcessingAttempts
      ) {
        await this.finishAfterBoundedFailure(accepted, claimedAt);
        return;
      }
      await this.continueRequest(accepted, claimedAt);
    } catch (error: unknown) {
      if (
        accepted.response.processingAttempts >=
        this.options.maxProcessingAttempts
      ) {
        await this.finishAfterBoundedFailure(accepted, claimedAt);
        this.onError(error);
        return;
      }
      await this.options.repository.releaseResponseProcessing(
        accepted.response.id,
        claimedAt,
        "Core continuation failed and will be retried within the configured bound.",
      );
      throw error;
    }
  }

  private async runLoop(): Promise<void> {
    const signal = this.abortController.signal;
    let consecutiveRedisErrors = 0;
    while (!signal.aborted) {
      try {
        const claimed = await this.options.transport.claimStaleResponses(
          this.consumerName,
          {
            minIdleMs: this.options.reclaimIdleMs,
            count: DEFAULT_BATCH_SIZE,
          } satisfies ClaimOptions,
        );
        await this.ingestDeliveries(claimed);
        if (signal.aborted) break;
        const fresh = await this.options.transport.readResponses(
          this.consumerName,
          { count: DEFAULT_BATCH_SIZE, blockMs: 1_000 },
        );
        await this.ingestDeliveries(fresh);
        await this.recoverUnprocessed(DEFAULT_BATCH_SIZE);
        consecutiveRedisErrors = 0;
      } catch (error: unknown) {
        if (signal.aborted) break;
        consecutiveRedisErrors += 1;
        this.onError(error);
        await abortableDelay(
          redisLoopRetryDelay(consecutiveRedisErrors),
          signal,
        );
      }
    }
  }

  private async ingestDeliveries(
    deliveries: readonly AgentResponseDelivery[],
  ): Promise<void> {
    const acceptedResponses: AcceptedAgentResponse[] = [];
    for (const delivery of deliveries) {
      if (this.abortController.signal.aborted) return;
      try {
        const accepted = await this.options.repository.acceptResponse(
          delivery.response,
          delivery.streamId,
        );
        // PostgreSQL is now the durable inbox. ACK before slower LLM reasoning
        // so one response cannot block ingestion of concurrent requests.
        await this.options.transport.acknowledgeResponse(delivery.streamId);
        if (!accepted.response.processedAt) acceptedResponses.push(accepted);
      } catch (error: unknown) {
        if (isPermanentCorrelationFailure(error)) {
          this.onError(error);
          await this.options.transport.acknowledgeResponse(delivery.streamId);
          continue;
        }
        this.onError(error);
        // Leave transient persistence failures pending for Redis recovery.
      }
    }
    for (const accepted of acceptedResponses) {
      try {
        await this.processAcceptedResponse(accepted);
      } catch (error: unknown) {
        this.onError(error);
      }
    }
  }

  private async continueRequest(
    accepted: AcceptedAgentResponse,
    claimedAt: Date,
  ): Promise<void> {
    const recent = await this.options.conversationRepository.getRecentMessages(
      accepted.request.conversationId,
      this.options.workingMemoryMessageLimit,
    );
    const sourceMessage = this.options.conversationRepository.getMessageById
      ? await this.options.conversationRepository.getMessageById(
          accepted.request.sourceMessageId,
        )
      : undefined;
    const trigger = scheduledTaskTriggerFromMetadata(
      sourceMessage?.source,
      sourceMessage?.metadata,
    );
    const result = await this.options.orchestrator.run({
      userMessage: accepted.request.originalUserRequest,
      conversationId: accepted.request.conversationId,
      userId: accepted.request.userId,
      userName: this.options.userName,
      timeZone: this.options.timeZone,
      contextMessages: recent.map((message) => ({
        role: message.role,
        content: message.content,
      })),
      delegationContinuation: {
        requestId: accepted.request.id,
        responseId: accepted.response.id,
        originalUserRequest: accepted.request.originalUserRequest,
        executionContext: accepted.request.executionContext,
        latestAgentResponse: accepted.response.message,
      },
      ...(trigger ? { trigger } : {}),
      signal: this.abortController.signal,
    });
    const outcome = continuationOutcome(result);
    const stored = await this.options.repository.finishResponseWithMessage({
      requestId: accepted.request.id,
      responseId: accepted.response.id,
      message: outcome.message,
      complete: outcome.complete,
      claimedAt,
      now: this.now(),
    });
    this.options.updates.publish({
      messageId: stored.id,
      conversationId: accepted.request.conversationId,
      message: stored.content,
      timestamp: stored.createdAt.toISOString(),
    });
  }

  private async finishAfterBoundedFailure(
    accepted: AcceptedAgentResponse,
    claimedAt: Date,
  ): Promise<void> {
    const message =
      "I received the agent's response, but I couldn't safely continue the request after bounded retries. I stopped without assuming that any remaining action succeeded.";
    const stored = await this.options.repository.finishResponseWithMessage({
      requestId: accepted.request.id,
      responseId: accepted.response.id,
      message,
      complete: true,
      claimedAt,
      now: this.now(),
    });
    this.options.updates.publish({
      messageId: stored.id,
      conversationId: accepted.request.conversationId,
      message: stored.content,
      timestamp: stored.createdAt.toISOString(),
    });
  }

  private staleProcessingBoundary(now = this.now()): Date {
    return new Date(now.getTime() - this.options.processingLeaseMs);
  }
}

function continuationOutcome(result: AgentRunResult): {
  readonly message: string;
  readonly complete: boolean;
} {
  if (result.kind === "delegated") {
    return { message: result.response, complete: false };
  }
  if (result.kind === "response") {
    const awaitingConfirmation = result.observations.some(
      (observation) =>
        !observation.result.success &&
        observation.result.error.code === "CONFIRMATION_REQUIRED",
    );
    return { message: result.response, complete: !awaitingConfirmation };
  }
  return {
    message:
      "I received the agent's response, but I couldn't determine a safe next action from the saved execution context.",
    complete: true,
  };
}

function isPermanentCorrelationFailure(error: unknown): boolean {
  return (
    error instanceof OrchestrationRepositoryError &&
    [
      "TASK_NOT_FOUND",
      "TASK_AGENT_MISMATCH",
      "TASK_NOT_ACTIVE",
      "REQUEST_COMPLETED",
      "RESPONSE_REQUEST_MISMATCH",
      "INVALID_INPUT",
    ].includes(error.failure)
  );
}

function assertPositiveInteger(value: number, name: string): void {
  if (!Number.isInteger(value) || value < 1) {
    throw new RangeError(`${name} must be a positive integer.`);
  }
}

function redisLoopRetryDelay(consecutiveErrors: number): number {
  const exponent = Math.min(16, Math.max(0, consecutiveErrors - 1));
  return Math.min(
    REDIS_LOOP_RETRY_MAX_MS,
    REDIS_LOOP_RETRY_BASE_MS * 2 ** exponent,
  );
}

async function abortableDelay(
  milliseconds: number,
  signal: AbortSignal,
): Promise<void> {
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

export function timeoutAgentResponse(
  task: {
    readonly id: string;
    readonly agentId: string;
  },
  now: Date,
): PlainAgentResponseEnvelope {
  return {
    taskId: task.id,
    agentId: task.agentId,
    message: `${task.agentId} did not return a response before the task deadline.`,
    metadata: { transportFailure: "AGENT_RESPONSE_TIMEOUT" },
    timestamp: now.toISOString(),
  };
}
