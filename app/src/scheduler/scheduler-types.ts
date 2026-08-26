export const SCHEDULER_QUEUE = "shiva-scheduled-task";

export type ScheduleType = "once" | "cron" | "interval";
export type ScheduledTaskLastStatus =
  | "pending"
  | "running"
  | "succeeded"
  | "failed"
  | "skipped";
export type ScheduledTaskExecutionStatus =
  | "processing"
  | "succeeded"
  | "failed";

export interface ScheduledTask {
  readonly id: string;
  readonly userId: string;
  readonly conversationId: string | null;
  readonly name: string;
  readonly instruction: string;
  readonly scheduleType: ScheduleType;
  readonly scheduleExpression: string | null;
  readonly runAt: Date | null;
  readonly intervalSeconds: number | null;
  readonly timezone: string;
  readonly enabled: boolean;
  readonly revision: number;
  readonly currentJobId: string | null;
  readonly scheduleKey: string | null;
  readonly nextRunAt: Date | null;
  readonly lastRunAt: Date | null;
  readonly lastStatus: ScheduledTaskLastStatus | null;
  readonly lastError: string | null;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

export interface CreateScheduledTaskInput {
  readonly userId: string;
  readonly conversationId: string;
  readonly name: string;
  readonly instruction: string;
  readonly scheduleType: ScheduleType;
  readonly scheduleExpression?: string;
  readonly runAt?: Date;
  readonly intervalSeconds?: number;
  readonly timezone: string;
}

export interface UpdateScheduledTaskInput {
  readonly name?: string;
  readonly instruction?: string;
  readonly scheduleType?: ScheduleType;
  readonly scheduleExpression?: string | null;
  readonly runAt?: Date | null;
  readonly intervalSeconds?: number | null;
  readonly timezone?: string;
}

export interface SchedulerJobPayload {
  readonly scheduledTaskId: string;
  readonly scheduleType: ScheduleType;
  readonly scheduleRevision: number;
  readonly scheduledFor?: string;
}

export interface ScheduledTaskExecution {
  readonly id: string;
  readonly scheduledTaskId: string;
  readonly pgBossJobId: string;
  readonly occurrenceId: string;
  readonly scheduleRevision: number;
  readonly status: ScheduledTaskExecutionStatus;
  readonly triggeredAt: Date;
  readonly startedAt: Date;
  readonly finishedAt: Date | null;
  readonly sourceMessageId: string | null;
  readonly assistantMessageId: string | null;
  readonly response: string | null;
  readonly lastError: string | null;
}

export interface ScheduledCoreTriggerRequest {
  readonly source: "scheduled_task";
  readonly scheduledTaskId: string;
  readonly scheduleRevision: number;
  readonly jobId: string;
  readonly occurrenceId: string;
  readonly triggeredAt: string;
}

export interface ScheduledCoreTriggerResponse {
  readonly accepted: true;
  readonly duplicate: boolean;
  readonly executionId: string;
  readonly conversationId: string;
  readonly response: string;
}

export class SchedulerValidationError extends Error {
  override readonly name = "SchedulerValidationError";
}

export class ScheduledTaskNotFoundError extends Error {
  override readonly name = "ScheduledTaskNotFoundError";
}

export class ScheduledTaskConflictError extends Error {
  override readonly name = "ScheduledTaskConflictError";
}

export class ScheduledExecutionInProgressError extends Error {
  override readonly name = "ScheduledExecutionInProgressError";
}

export class ScheduledExecutionTerminalError extends Error {
  override readonly name = "ScheduledExecutionTerminalError";
}

export class ScheduledExecutionRejectedError extends Error {
  override readonly name = "ScheduledExecutionRejectedError";
}
