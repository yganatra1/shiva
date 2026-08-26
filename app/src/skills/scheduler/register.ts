import { z } from "zod";

import type { SchedulerService } from "../../scheduler/scheduler-service";
import {
  ScheduledTaskConflictError,
  ScheduledTaskNotFoundError,
  SchedulerValidationError,
  type ScheduledTask,
} from "../../scheduler/scheduler-types";
import { defineSkill } from "../define-skill";
import type { SkillRegistry } from "../registry";
import type { SkillFailure } from "../types";

const taskIdSchema = z.string().uuid();
const timezoneSchema = z.string().trim().min(1).max(255).optional();
const isoDateSchema = z.iso.datetime({ offset: true });
const createBase = {
  name: z.string().trim().min(1).max(200),
  instruction: z.string().trim().min(1).max(8_000),
  timezone: timezoneSchema,
};
const createSchema = z.discriminatedUnion("scheduleType", [
  z
    .object({
      ...createBase,
      scheduleType: z.literal("once"),
      runAt: isoDateSchema,
    })
    .strict(),
  z
    .object({
      ...createBase,
      scheduleType: z.literal("cron"),
      scheduleExpression: z.string().trim().min(1).max(255),
    })
    .strict(),
  z
    .object({
      ...createBase,
      scheduleType: z.literal("interval"),
      intervalSeconds: z.number().int().positive().max(31_536_000),
    })
    .strict(),
]);
const updateSchema = z
  .object({
    taskId: taskIdSchema,
    name: z.string().trim().min(1).max(200).optional(),
    instruction: z.string().trim().min(1).max(8_000).optional(),
    scheduleType: z.enum(["once", "cron", "interval"]).optional(),
    scheduleExpression: z.string().trim().min(1).max(255).nullable().optional(),
    runAt: isoDateSchema.nullable().optional(),
    intervalSeconds: z
      .number()
      .int()
      .positive()
      .max(31_536_000)
      .nullable()
      .optional(),
    timezone: z.string().trim().min(1).max(255).optional(),
  })
  .strict()
  .refine(
    (input) => Object.keys(input).some((key) => key !== "taskId"),
    "At least one task field must be updated.",
  );

export function registerSchedulerSkills(
  registry: SkillRegistry,
  scheduler: Pick<
    SchedulerService,
    "create" | "update" | "delete" | "pause" | "resume" | "list" | "get"
  >,
): void {
  registry.register(
    defineSkill({
      name: "schedule_create",
      description:
        "Creates one durable Shiva wake-up. Interpret the user's timing into exactly one once, five-field cron, or fixed-interval schedule, but keep instruction as natural-language intent rather than a tool call. Cron is evaluated by pg-boss in the supplied IANA timezone.",
      inputDescription:
        '{"name":string,"instruction":string,"scheduleType":"once","runAt":ISO-8601 with offset,"timezone"?:IANA} | {"name":string,"instruction":string,"scheduleType":"cron","scheduleExpression":five-field cron,"timezone"?:IANA} | {"name":string,"instruction":string,"scheduleType":"interval","intervalSeconds":positive integer,"timezone"?:IANA}',
      inputSchema: createSchema,
      execution: { mutability: "write", impact: "normal" },
      async execute(input, context) {
        try {
          const task = await scheduler.create({
            userId: context.userId,
            conversationId: context.conversationId,
            name: input.name,
            instruction: input.instruction,
            scheduleType: input.scheduleType,
            timezone: input.timezone ?? context.timeZone,
            ...(input.scheduleType === "once"
              ? { runAt: new Date(input.runAt) }
              : input.scheduleType === "cron"
                ? { scheduleExpression: input.scheduleExpression }
                : { intervalSeconds: input.intervalSeconds }),
          });
          return { success: true, data: publicTask(task) };
        } catch (error: unknown) {
          return schedulerFailure(error);
        }
      },
    }),
  );

  registry.register(
    defineSkill({
      name: "schedule_update",
      description:
        "Updates a durable scheduled task by its taskId. Use schedule_list first when the user referred to a reminder by name. When changing scheduleType, also provide the one field required by the new type and clear obsolete schedule fields with null.",
      inputDescription:
        '{"taskId":UUID,"name"?:string,"instruction"?:natural-language string,"scheduleType"?:"once"|"cron"|"interval","runAt"?:ISO-8601 with offset|null,"scheduleExpression"?:five-field cron|null,"intervalSeconds"?:positive integer|null,"timezone"?:IANA}',
      inputSchema: updateSchema,
      execution: { mutability: "write", impact: "normal" },
      async execute(input, context) {
        try {
          const task = await scheduler.update(context.userId, input.taskId, {
            ...(input.name !== undefined ? { name: input.name } : {}),
            ...(input.instruction !== undefined
              ? { instruction: input.instruction }
              : {}),
            ...(input.scheduleType !== undefined
              ? { scheduleType: input.scheduleType }
              : {}),
            ...(input.scheduleExpression !== undefined
              ? { scheduleExpression: input.scheduleExpression }
              : {}),
            ...(input.runAt !== undefined
              ? { runAt: input.runAt === null ? null : new Date(input.runAt) }
              : {}),
            ...(input.intervalSeconds !== undefined
              ? { intervalSeconds: input.intervalSeconds }
              : {}),
            ...(input.timezone !== undefined
              ? { timezone: input.timezone }
              : {}),
          });
          return { success: true, data: publicTask(task) };
        } catch (error: unknown) {
          return schedulerFailure(error);
        }
      },
    }),
  );

  registry.register(
    defineSkill({
      name: "schedule_delete",
      description:
        "Permanently deletes a scheduled task by taskId. Use schedule_list first to resolve a reminder name without guessing.",
      inputDescription: '{"taskId":UUID}',
      inputSchema: z.object({ taskId: taskIdSchema }).strict(),
      execution: { mutability: "write", impact: "normal" },
      async execute(input, context) {
        try {
          const deleted = await scheduler.delete(context.userId, input.taskId);
          return deleted
            ? { success: true, data: { taskId: input.taskId, deleted: true } }
            : {
                success: false,
                error: {
                  code: "SCHEDULE_NOT_FOUND",
                  message: "The scheduled task does not exist.",
                },
              };
        } catch (error: unknown) {
          return schedulerFailure(error);
        }
      },
    }),
  );

  for (const operation of ["pause", "resume"] as const) {
    registry.register(
      defineSkill({
        name: `schedule_${operation}`,
        description: `${operation === "pause" ? "Pauses" : "Resumes"} a durable scheduled task by taskId without deleting its natural-language intent. Use schedule_list first to resolve a name without guessing.`,
        inputDescription: '{"taskId":UUID}',
        inputSchema: z.object({ taskId: taskIdSchema }).strict(),
        execution: { mutability: "write", impact: "normal" },
        async execute(input, context) {
          try {
            const task = await scheduler[operation](
              context.userId,
              input.taskId,
            );
            return { success: true, data: publicTask(task) };
          } catch (error: unknown) {
            return schedulerFailure(error);
          }
        },
      }),
    );
  }

  registry.register(
    defineSkill({
      name: "schedule_list",
      description:
        "Lists the configured user's scheduled tasks, including IDs, names, timing, enabled state, next run, and last outcome. Use this to resolve conversational references before update, pause, resume, or delete.",
      inputDescription: '{"enabled"?:boolean}',
      inputSchema: z.object({ enabled: z.boolean().optional() }).strict(),
      execution: { mutability: "read", impact: "normal" },
      async execute(input, context) {
        try {
          const tasks = await scheduler.list(context.userId, input.enabled);
          return {
            success: true,
            data: { tasks: tasks.map(publicTask), count: tasks.length },
          };
        } catch (error: unknown) {
          return schedulerFailure(error);
        }
      },
    }),
  );

  registry.register(
    defineSkill({
      name: "schedule_get",
      description: "Gets one scheduled task owned by the configured user.",
      inputDescription: '{"taskId":UUID}',
      inputSchema: z.object({ taskId: taskIdSchema }).strict(),
      execution: { mutability: "read", impact: "normal" },
      async execute(input, context) {
        try {
          const task = await scheduler.get(context.userId, input.taskId);
          return task
            ? { success: true, data: publicTask(task) }
            : {
                success: false,
                error: {
                  code: "SCHEDULE_NOT_FOUND",
                  message: "The scheduled task does not exist.",
                },
              };
        } catch (error: unknown) {
          return schedulerFailure(error);
        }
      },
    }),
  );
}

function publicTask(task: ScheduledTask) {
  return {
    id: task.id,
    name: task.name,
    instruction: task.instruction,
    scheduleType: task.scheduleType,
    scheduleExpression: task.scheduleExpression,
    runAt: task.runAt?.toISOString() ?? null,
    intervalSeconds: task.intervalSeconds,
    timezone: task.timezone,
    enabled: task.enabled,
    nextRunAt: task.nextRunAt?.toISOString() ?? null,
    lastRunAt: task.lastRunAt?.toISOString() ?? null,
    lastStatus: task.lastStatus,
    lastError: task.lastError,
    revision: task.revision,
    createdAt: task.createdAt.toISOString(),
    updatedAt: task.updatedAt.toISOString(),
  };
}

function schedulerFailure(error: unknown): SkillFailure {
  if (error instanceof SchedulerValidationError) {
    return {
      success: false,
      error: { code: "INVALID_SCHEDULE", message: error.message },
    };
  }
  if (error instanceof ScheduledTaskNotFoundError) {
    return {
      success: false,
      error: { code: "SCHEDULE_NOT_FOUND", message: error.message },
    };
  }
  if (error instanceof ScheduledTaskConflictError) {
    return {
      success: false,
      error: { code: "SCHEDULE_CONFLICT", message: error.message },
    };
  }
  return {
    success: false,
    error: {
      code: "SCHEDULER_UNAVAILABLE",
      message: "The scheduler could not complete the operation right now.",
    },
  };
}
