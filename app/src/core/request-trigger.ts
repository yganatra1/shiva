export interface ScheduledTaskTrigger {
  readonly source: "scheduled_task";
  readonly scheduledTaskId: string;
  readonly scheduleRevision: number;
  readonly occurrenceId: string;
  readonly jobId: string;
  readonly triggeredAt: string;
}

export type RequestTrigger = ScheduledTaskTrigger;

export function scheduledTaskTriggerFromMetadata(
  source: string | undefined,
  metadata: Readonly<Record<string, unknown>> | undefined,
): ScheduledTaskTrigger | undefined {
  if (source !== "scheduled_task" || !metadata) return undefined;
  const scheduledTaskId = metadata.scheduledTaskId;
  const scheduleRevision = metadata.scheduleRevision;
  const occurrenceId = metadata.occurrenceId;
  const jobId = metadata.jobId;
  const triggeredAt = metadata.triggeredAt;
  if (
    typeof scheduledTaskId !== "string" ||
    !Number.isInteger(scheduleRevision) ||
    typeof occurrenceId !== "string" ||
    typeof jobId !== "string" ||
    typeof triggeredAt !== "string"
  ) {
    return undefined;
  }
  return {
    source: "scheduled_task",
    scheduledTaskId,
    scheduleRevision: scheduleRevision as number,
    occurrenceId,
    jobId,
    triggeredAt,
  };
}
