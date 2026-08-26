import { z } from "zod";

import { defineSkill } from "../define-skill";
import type { SkillContext, SkillResult } from "../types";
import {
  GoogleDriveClient,
  driveErrorToFailure,
  type DriveFile,
} from "../../tools/drive/client";

const inputSchema = z.object({
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
      "Lists files in the user's Google Drive, most recently modified first, with no name filter — use this to browse or summarize the Drive as a whole (e.g. \"summarise my Google Drive\"). Use drive_search instead when looking for a specific file by name. One call returns at most 100 files; if nextPageToken is present in the result, call again with pageToken set to it to see more.",
    inputDescription:
      '{ "maxResults"?: 1-100 (default 25), "pageToken"?: string (from a previous call\'s nextPageToken) }',
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
