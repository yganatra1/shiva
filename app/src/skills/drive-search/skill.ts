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

export type DriveSearchInput = z.infer<typeof inputSchema>;
export interface DriveSearchOutput {
  readonly matches: readonly DriveFile[];
}

export function createDriveSearchSkill(client?: GoogleDriveClient) {
  return defineSkill<DriveSearchInput, DriveSearchOutput>({
    name: "drive_search",
    description:
      "Searches the user's Google Drive by NAME across all file types (Docs, Sheets, Slides, PDFs, etc.) — query is matched against filenames only, not file content or Drive as a whole. Only useful when you already know (or can guess) a distinctive word from the file's name. Use drive_list instead for browsing or summarizing the Drive in general (e.g. \"summarise my Google Drive\", \"what's in my Drive\") — calling drive_search with a query like \"Google Drive\" or \"my files\" will find nothing, since no file is actually named that. Use drive_read with the id to fetch a file's content. Use sheets_find instead if you specifically need a spreadsheet.",
    inputDescription: '{ "query": string, "maxResults"?: 1-25 (default 10) }',
    inputSchema,
    execution: { mutability: "read", impact: "normal" },
    configured: client !== undefined,
    async execute(
      input: DriveSearchInput,
      context: SkillContext,
    ): Promise<SkillResult<DriveSearchOutput>> {
      if (!client) {
        return {
          success: false,
          error: { code: "GOOGLE_DRIVE_UNAVAILABLE", message: "Google Drive search is not configured." },
        };
      }
      try {
        const matches = await client.findFiles({
          query: input.query,
          maxResults: input.maxResults,
          ...(context.signal ? { signal: context.signal } : {}),
        });
        console.log('matches', matches);
        return { success: true, data: { matches } };
      } catch (error: unknown) {
        console.error(error);
        if (context.signal?.aborted) throw error;
        return { success: false, error: driveErrorToFailure(error) };
      }
    },
  });
}
