import { z } from "zod";

import { defineSkill } from "../define-skill";
import type { SkillContext, SkillResult } from "../types";
import {
  GoogleCalendarClient,
  calendarErrorToFailure,
} from "../../tools/calendar/client";

const inputSchema = z.object({
  eventId: z.string().trim().min(1).max(1024),
});

export type CalendarDeleteInput = z.infer<typeof inputSchema>;
export interface CalendarDeleteOutput {
  readonly eventId: string;
  readonly deleted: true;
}

export function createCalendarDeleteSkill(client?: GoogleCalendarClient) {
  return defineSkill<CalendarDeleteInput, CalendarDeleteOutput>({
    name: "calendar_delete",
    description:
      "Permanently deletes an event from the user's primary Google Calendar. Use calendar_read first to resolve the eventId without guessing.",
    inputDescription: '{ "eventId": string }',
    inputSchema,
    execution: { mutability: "write", impact: "normal" },
    configured: client !== undefined,
    async execute(
      input: CalendarDeleteInput,
      context: SkillContext,
    ): Promise<SkillResult<CalendarDeleteOutput>> {
      if (!client) {
        return {
          success: false,
          error: { code: "CALENDAR_UNAVAILABLE", message: "Google Calendar is not configured." },
        };
      }
      try {
        await client.deleteEvent({
          eventId: input.eventId,
          ...(context.signal ? { signal: context.signal } : {}),
        });
        return { success: true, data: { eventId: input.eventId, deleted: true } };
      } catch (error: unknown) {
        if (context.signal?.aborted) throw error;
        return { success: false, error: calendarErrorToFailure(error) };
      }
    },
  });
}
