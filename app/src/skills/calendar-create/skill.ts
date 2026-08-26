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

const inputSchema = z.object({
  summary: z.string().trim().min(1).max(500),
  start: eventTimeSchema,
  end: eventTimeSchema,
  description: z.string().trim().max(8_000).optional(),
  attendees: z.array(z.string().trim().email()).max(50).optional(),
});

export type CalendarCreateInput = z.infer<typeof inputSchema>;
export interface CalendarCreateOutput {
  readonly event: CalendarEvent;
}

function toEventTime(input: { dateTime: string; timeZone?: string | undefined }): CalendarEventTime {
  return {
    dateTime: input.dateTime,
    ...(input.timeZone !== undefined ? { timeZone: input.timeZone } : {}),
  };
}

export function createCalendarCreateSkill(client?: GoogleCalendarClient) {
  return defineSkill<CalendarCreateInput, CalendarCreateOutput>({
    name: "calendar_create",
    description:
      "Creates a new event on the user's primary Google Calendar.",
    inputDescription:
      '{ "summary": string, "start": {"dateTime":ISO-8601 with offset,"timeZone"?:IANA}, "end": {same shape}, "description"?: string, "attendees"?: [email] }',
    inputSchema,
    execution: { mutability: "write", impact: "normal" },
    configured: client !== undefined,
    async execute(
      input: CalendarCreateInput,
      context: SkillContext,
    ): Promise<SkillResult<CalendarCreateOutput>> {
      if (!client) {
        return {
          success: false,
          error: { code: "CALENDAR_UNAVAILABLE", message: "Google Calendar is not configured." },
        };
      }
      try {
        const event = await client.createEvent({
          summary: input.summary,
          start: toEventTime(input.start),
          end: toEventTime(input.end),
          ...(input.description ? { description: input.description } : {}),
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
