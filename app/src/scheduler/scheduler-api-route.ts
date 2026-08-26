import { timingSafeEqual } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { z } from "zod";

import { ApiError } from "../api/api-error";
import type { ScheduledCoreExecutor } from "./scheduled-core-executor";
import {
  ScheduledExecutionInProgressError,
  ScheduledExecutionRejectedError,
  ScheduledExecutionTerminalError,
} from "./scheduler-types";

const requestSchema = z
  .object({
    source: z.literal("scheduled_task"),
    scheduledTaskId: z.string().uuid(),
    scheduleRevision: z.number().int().positive(),
    jobId: z.string().uuid(),
    occurrenceId: z.string().trim().min(1).max(512),
    triggeredAt: z.iso.datetime({ offset: true }),
  })
  .strict();

export function registerSchedulerInternalRoute(
  app: FastifyInstance,
  executor: Pick<ScheduledCoreExecutor, "execute">,
  token: string,
): void {
  app.post<{ Body: unknown }>(
    "/internal/scheduler/execute",
    async (request, reply) => {
      if (!authorized(request.headers.authorization, token)) {
        throw new ApiError(
          401,
          "SCHEDULER_UNAUTHORIZED",
          "Valid scheduler authentication is required.",
        );
      }
      const parsed = requestSchema.safeParse(request.body);
      if (!parsed.success) {
        throw new ApiError(
          400,
          "INVALID_SCHEDULER_TRIGGER",
          "The scheduler trigger payload is invalid.",
        );
      }
      request.log.info(
        {
          scheduledTaskId: parsed.data.scheduledTaskId,
          jobId: parsed.data.jobId,
          occurrenceId: parsed.data.occurrenceId,
          revision: parsed.data.scheduleRevision,
        },
        "scheduler core trigger started",
      );
      try {
        const result = await executor.execute(parsed.data);
        return reply.send(result);
      } catch (error: unknown) {
        if (error instanceof ScheduledExecutionRejectedError) {
          throw new ApiError(410, "SCHEDULE_TRIGGER_REJECTED", error.message);
        }
        if (error instanceof ScheduledExecutionTerminalError) {
          throw new ApiError(
            422,
            "SCHEDULE_EXECUTION_OUTCOME_UNCERTAIN",
            error.message,
          );
        }
        if (error instanceof ScheduledExecutionInProgressError) {
          throw new ApiError(
            409,
            "SCHEDULE_EXECUTION_IN_PROGRESS",
            error.message,
          );
        }
        throw error;
      }
    },
  );
}

function authorized(header: string | undefined, expectedToken: string): boolean {
  if (!header?.startsWith("Bearer ")) return false;
  const supplied = Buffer.from(header.slice("Bearer ".length), "utf8");
  const expected = Buffer.from(expectedToken, "utf8");
  return supplied.length === expected.length && timingSafeEqual(supplied, expected);
}
