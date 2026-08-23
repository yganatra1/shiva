import { z } from "zod";

import { defineSkill } from "../define-skill";
import type { SkillContext, SkillResult } from "../types";
import {
  GoogleDriveClient,
  driveErrorToFailure,
  type DriveFile,
} from "../../tools/drive/client";

const inputSchema = z.object({
  query: z.string().trim().min(1).max(200),
  maxResults: z.number().int().min(1).max(25).default(10),
});

export type SheetsFindInput = z.infer<typeof inputSchema>;
export interface SheetsFindOutput {
  readonly matches: readonly DriveFile[];
}

export function createSheetsFindSkill(client?: GoogleDriveClient) {
  return defineSkill<SheetsFindInput, SheetsFindOutput>({
    name: "sheets_find",
    description:
      "Searches the user's Google Drive by name for spreadsheets matching a query (e.g. \"expenses 2026\"), returning each match's spreadsheetId, name, URL, and last-modified time, most recently modified first. Use this before sheets_read/sheets_update/sheets_add_tab when you don't already know a sheet's exact spreadsheetId — never guess one.",
    inputDescription: '{ "query": string, "maxResults"?: 1-25 (default 10) }',
    pack: "google",
    inputSchema,
    execution: { mutability: "read", impact: "normal" },
    configured: client !== undefined,
    async execute(
      input: SheetsFindInput,
      context: SkillContext,
    ): Promise<SkillResult<SheetsFindOutput>> {
      if (!client) {
        return {
          success: false,
          error: {
            code: "GOOGLE_DRIVE_UNAVAILABLE",
            message: "Google Drive search is not configured.",
          },
        };
      }
      try {
        const matches = await client.findSpreadsheets({
          query: input.query,
          maxResults: input.maxResults,
          ...(context.signal ? { signal: context.signal } : {}),
        });
        return { success: true, data: { matches } };
      } catch (error: unknown) {
        if (context.signal?.aborted) throw error;
        return { success: false, error: driveErrorToFailure(error) };
      }
    },
  });
}
