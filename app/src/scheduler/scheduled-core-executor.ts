import type { CoreUpdatePublisher } from "../core/core-update-hub";
import type { StoredMessage } from "../memory/types";
import type { ShivaChatService } from "../services/chat-service";
import type { SchedulerLogSink } from "./pg-boss";
import type { SchedulerRepositoryPort } from "./scheduler-repository";
import {
  ScheduledExecutionInProgressError,
  ScheduledExecutionRejectedError,
  ScheduledExecutionTerminalError,
  type ScheduledCoreTriggerRequest,
  type ScheduledCoreTriggerResponse,
} from "./scheduler-types";

const MAX_EXECUTION_ERROR_LENGTH = 2_000;

export interface ScheduledCoreExecutorOptions {
  readonly repository: SchedulerRepositoryPort;
  readonly chatService: Pick<ShivaChatService, "startResponseTo">;
  readonly updates: CoreUpdatePublisher;
  readonly configuredUserId: string;
  readonly logger: SchedulerLogSink;
  readonly processingUncertainAfterMs: number;
  readonly now?: () => Date;
}

/**
 * Core's idempotent scheduled-task ingress. Only the unique occurrence insert
 * winner enters normal chat/planner orchestration. A failed or abandoned
 * execution is deliberately not replayed automatically: once Core began,
 * repeating an unknown external write would be less safe than surfacing an
 * outcome-uncertain failure.
 */
export class ScheduledCoreExecutor {
  private readonly now: () => Date;

  constructor(private readonly options: ScheduledCoreExecutorOptions) {
    this.now = options.now ?? (() => new Date());
  }

  async execute(
    request: ScheduledCoreTriggerRequest,
    signal?: AbortSignal,
  ): Promise<ScheduledCoreTriggerResponse> {
    const task = await this.options.repository.getTask(request.scheduledTaskId);
    if (
      !task ||
      task.userId !== this.options.configuredUserId ||
      !task.enabled ||
      task.revision !== request.scheduleRevision
    ) {
      throw new ScheduledExecutionRejectedError(
        "The scheduled task is missing, paused, or stale.",
      );
    }
    const triggeredAt = new Date(request.triggeredAt);
    if (!Number.isFinite(triggeredAt.getTime())) {
      throw new ScheduledExecutionRejectedError("triggeredAt is invalid.");
    }

    const claim = await this.options.repository.claimExecution({
      scheduledTaskId: task.id,
      pgBossJobId: request.jobId,
      occurrenceId: request.occurrenceId,
      scheduleRevision: request.scheduleRevision,
      triggeredAt,
      now: this.now(),
    });
    if (!claim.claimed) {
      if (claim.execution.status === "succeeded") {
        const conversationId = task.conversationId;
        if (!conversationId || claim.execution.response === null) {
          throw new ScheduledExecutionTerminalError(
            "The prior scheduled execution completed without a replayable response.",
          );
        }
        return {
          accepted: true,
          duplicate: true,
          executionId: claim.execution.id,
          conversationId,
          response: claim.execution.response,
        };
      }
      if (claim.execution.status === "failed") {
        throw new ScheduledExecutionTerminalError(
          "The scheduled execution previously failed after Core accepted it; it will not be replayed automatically.",
        );
      }
      const age = this.now().getTime() - claim.execution.startedAt.getTime();
      if (age >= this.options.processingUncertainAfterMs) {
        throw new ScheduledExecutionTerminalError(
          "The scheduled execution outcome is uncertain after an interrupted Core run; it will not be replayed automatically.",
        );
      }
      throw new ScheduledExecutionInProgressError(
        "The scheduled occurrence is already being processed.",
      );
    }

    const trigger = {
      source: "scheduled_task" as const,
      scheduledTaskId: task.id,
      scheduleRevision: task.revision,
      occurrenceId: request.occurrenceId,
      jobId: request.jobId,
      triggeredAt: triggeredAt.toISOString(),
    };
    let sourceMessage: StoredMessage | undefined;
    let assistantMessage: StoredMessage | undefined;
    try {
      const prepared = await this.options.chatService.startResponseTo(
        task.instruction,
        task.conversationId ?? undefined,
        signal,
        {
          mode: "text",
          trigger,
          onUserPersisted: (message) => {
            sourceMessage = message;
          },
          onAssistantPersisted: (message) => {
            assistantMessage = message;
          },
        },
      );
      if (!task.conversationId) {
        await this.options.repository.setTaskConversation(
          task.id,
          prepared.conversationId,
          this.now(),
        );
      }
      let response = "";
      for await (const chunk of prepared.chunks) response += chunk.content;
      if (!sourceMessage || !assistantMessage || response.trim().length === 0) {
        throw new Error("Core did not persist a complete scheduled response.");
      }
      await this.options.repository.attachExecutionMessages(
        claim.execution.id,
        sourceMessage.id,
        assistantMessage.id,
      );
      await this.options.repository.finishExecution(
        claim.execution.id,
        "succeeded",
        response,
        null,
        assistantMessage.id,
        this.now(),
      );
      this.options.updates.publish({
        messageId: assistantMessage.id,
        conversationId: prepared.conversationId,
        message: assistantMessage.content,
        timestamp: assistantMessage.createdAt.toISOString(),
      });
      this.options.logger.info(
        {
          scheduledTaskId: task.id,
          jobId: request.jobId,
          occurrenceId: request.occurrenceId,
          executionId: claim.execution.id,
        },
        "scheduler core trigger completed",
      );
      return {
        accepted: true,
        duplicate: false,
        executionId: claim.execution.id,
        conversationId: prepared.conversationId,
        response,
      };
    } catch (error: unknown) {
      if (sourceMessage) {
        await this.options.repository.attachExecutionMessages(
          claim.execution.id,
          sourceMessage.id,
          assistantMessage?.id ?? null,
        );
      }
      const message = safeExecutionError(error);
      await this.options.repository.finishExecution(
        claim.execution.id,
        "failed",
        null,
        message,
        assistantMessage?.id ?? null,
        this.now(),
      );
      this.options.logger.error(
        {
          scheduledTaskId: task.id,
          jobId: request.jobId,
          occurrenceId: request.occurrenceId,
          executionId: claim.execution.id,
          error: message,
        },
        "scheduler core trigger failed",
      );
      throw error;
    }
  }
}

function safeExecutionError(error: unknown): string {
  const message = error instanceof Error ? error.message : "Unknown Core error";
  return message.slice(0, MAX_EXECUTION_ERROR_LENGTH);
}
