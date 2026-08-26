import { z } from "zod";

import { defineSkill } from "../define-skill";
import type { SkillContext, SkillResult } from "../types";
import {
  GoogleCalendarClient,
  calendarErrorToFailure,
  type CalendarEvent,
} from "../../tools/calendar/client";

const isoDateSchema = z.iso.datetime({ offset: true });

const inputSchema = z.object({
  timeMin: isoDateSchema,
  timeMax: isoDateSchema,
  query: z.string().trim().max(200).optional(),
  maxResults: z.number().int().min(1).max(50).default(10),
});

export type CalendarReadInput = z.infer<typeof inputSchema>;
export interface CalendarReadOutput {
  readonly events: readonly CalendarEvent[];
}

export function createCalendarReadSkill(client?: GoogleCalendarClient) {
  return defineSkill<CalendarReadInput, CalendarReadOutput>({
    name: "calendar_read",
    description:
      "Lists events on the user's primary Google Calendar within a time range, optionally filtered by a text query.",
    inputDescription:
      '{ "timeMin": ISO-8601 with offset, "timeMax": ISO-8601 with offset, "query"?: string, "maxResults"?: 1-50 (default 10) }',
    inputSchema,
    execution: { mutability: "read", impact: "normal" },
    configured: client !== undefined,
    async execute(
      input: CalendarReadInput,
      context: SkillContext,
    ): Promise<SkillResult<CalendarReadOutput>> {
      if (!client) {
        return {
          success: false,
          error: { code: "CALENDAR_UNAVAILABLE", message: "Google Calendar is not configured." },
        };
      }
      try {
        const events = await client.listEvents({
          timeMin: input.timeMin,
          timeMax: input.timeMax,
          ...(input.query ? { query: input.query } : {}),
          maxResults: input.maxResults,
          ...(context.signal ? { signal: context.signal } : {}),
        });
        return { success: true, data: { events } };
      } catch (error: unknown) {
        if (context.signal?.aborted) throw error;
        return { success: false, error: calendarErrorToFailure(error) };
      }
    },
  });
}
