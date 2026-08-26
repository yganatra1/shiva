import { z } from "zod";

import { defineSkill } from "../define-skill";
import type { SkillContext, SkillResult } from "../types";
import {
  GoogleCalendarClient,
  calendarErrorToFailure,
  type CalendarEvent,
  type CalendarEventTime,
} from "../../tools/calendar/client";

const isoDateSchema = z.iso.datetime({ offset: true });
const eventTimeSchema = z.object({
  dateTime: isoDateSchema,
  timeZone: z.string().trim().min(1).max(255).optional(),
});

const inputSchema = z
  .object({
    eventId: z.string().trim().min(1).max(1024),
    summary: z.string().trim().min(1).max(500).optional(),
    start: eventTimeSchema.optional(),
    end: eventTimeSchema.optional(),
    description: z.string().trim().max(8_000).optional(),
    attendees: z.array(z.string().trim().email()).max(50).optional(),
  })
  .strict()
  .refine(
    (input) => Object.keys(input).some((key) => key !== "eventId"),
    "At least one event field must be updated.",
  );

export type CalendarUpdateInput = z.infer<typeof inputSchema>;
export interface CalendarUpdateOutput {
  readonly event: CalendarEvent;
}

function toEventTime(input: { dateTime: string; timeZone?: string | undefined }): CalendarEventTime {
  return {
    dateTime: input.dateTime,
    ...(input.timeZone !== undefined ? { timeZone: input.timeZone } : {}),
  };
}

export function createCalendarUpdateSkill(client?: GoogleCalendarClient) {
  return defineSkill<CalendarUpdateInput, CalendarUpdateOutput>({
    name: "calendar_update",
    description:
      "Updates fields on an existing event on the user's primary Google Calendar. Use calendar_read first to resolve the eventId. Only supplied fields change.",
    inputDescription:
      '{ "eventId": string, "summary"?: string, "start"?: {"dateTime":ISO-8601 with offset,"timeZone"?:IANA}, "end"?: {same shape}, "description"?: string, "attendees"?: [email] }',
    inputSchema,
    execution: { mutability: "write", impact: "normal" },
    configured: client !== undefined,
    async execute(
      input: CalendarUpdateInput,
      context: SkillContext,
    ): Promise<SkillResult<CalendarUpdateOutput>> {
      if (!client) {
        return {
          success: false,
          error: { code: "CALENDAR_UNAVAILABLE", message: "Google Calendar is not configured." },
        };
      }
      try {
        const event = await client.updateEvent({
          eventId: input.eventId,
          ...(input.summary !== undefined ? { summary: input.summary } : {}),
          ...(input.start ? { start: toEventTime(input.start) } : {}),
          ...(input.end ? { end: toEventTime(input.end) } : {}),
          ...(input.description !== undefined ? { description: input.description } : {}),
          ...(input.attendees ? { attendees: input.attendees } : {}),
          ...(context.signal ? { signal: context.signal } : {}),
        });
        return { success: true, data: { event } };
      } catch (error: unknown) {
        if (context.signal?.aborted) throw error;
        return { success: false, error: calendarErrorToFailure(error) };
      }
    },
  });
}
