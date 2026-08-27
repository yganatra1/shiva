import { z } from "zod";

import { formatIsoWithOffset } from "../../types/time";
import { defineSkill } from "../define-skill";

const inputSchema = z
  .object({
    timezone: z.string().trim().min(1).max(100).optional(),
  })
  .strict();

export function createCurrentTimeSkill() {
  return defineSkill({
    name: "current_time",
    description:
      "Returns the current date and time. Defaults to the user's configured timezone; pass an IANA timezone (e.g. \"America/New_York\") to get the time somewhere else.",
    inputDescription:
      '{"timezone"?:IANA timezone string, defaults to the user\'s configured timezone}',
    inputSchema,
    execution: { mutability: "read", impact: "normal" },
    configured: true,
    async execute(input, context) {
      const timezone = input.timezone ?? context.timeZone;
      const now = context.now();
      let formatted: string;
      let iso: string;
      try {
        formatted = new Intl.DateTimeFormat("en-US", {
          timeZone: timezone,
          dateStyle: "full",
          timeStyle: "long",
        }).format(now);
        iso = formatIsoWithOffset(now, timezone);
      } catch {
        return {
          success: false,
          error: {
            code: "INVALID_TIMEZONE",
            message: `"${timezone}" is not a recognized IANA timezone.`,
          },
        };
      }
      return {
        success: true,
        data: { iso, timezone, formatted },
      };
    },
  });
}
