import { z } from "zod";

import { defineSkill } from "../define-skill";
import type { SkillContext, SkillResult } from "../types";
import {
  GoogleDriveClient,
  driveErrorToFailure,
  type DriveFile,
} from "../../tools/drive/client";

const inputSchema = z.object({
  query: z.string().trim().min(1).max(200).optional(),
  maxResults: z.number().int().min(1).max(100).default(25),
  pageToken: z.string().trim().min(1).max(2_000).optional(),
});

export type DriveListInput = z.infer<typeof inputSchema>;
export interface DriveListOutput {
  readonly files: readonly DriveFile[];
  readonly nextPageToken?: string;
}

export function createDriveListSkill(client?: GoogleDriveClient) {
  return defineSkill<DriveListInput, DriveListOutput>({
    name: "drive_list",
    description:
      "Lists files in the user's Google Drive across all file types (Docs, Sheets, Slides, PDFs, etc.), most recently modified first. Omit query to browse or summarize the Drive as a whole (e.g. \"summarise my Google Drive\"); pass query to narrow to files whose NAME matches it (matches filenames only, not content). Use drive_read with the id to fetch a file's content, and sheets_find instead if you specifically need a spreadsheet. One call returns at most 100 files; if nextPageToken is present in the result, call again with pageToken set to it to see more.",
    inputDescription:
      '{ "query"?: string (matches filenames only; omit to browse everything), "maxResults"?: 1-100 (default 25), "pageToken"?: string (from a previous call\'s nextPageToken) }',
    inputSchema,
    execution: { mutability: "read", impact: "normal" },
    configured: client !== undefined,
    async execute(
      input: DriveListInput,
      context: SkillContext,
    ): Promise<SkillResult<DriveListOutput>> {
      if (!client) {
        return {
          success: false,
          error: { code: "GOOGLE_DRIVE_UNAVAILABLE", message: "Google Drive is not configured." },
        };
      }
      try {
        const result = await client.listFiles({
          ...(input.query ? { query: input.query } : {}),
          maxResults: input.maxResults,
          ...(input.pageToken ? { pageToken: input.pageToken } : {}),
          ...(context.signal ? { signal: context.signal } : {}),
        });
        return { success: true, data: result };
      } catch (error: unknown) {
        if (context.signal?.aborted) throw error;
        return { success: false, error: driveErrorToFailure(error) };
      }
    },
  });
}
