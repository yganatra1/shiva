import { z } from "zod";

import { defineSkill } from "../define-skill";
import type { SkillContext, SkillResult } from "../types";
import {
  GoogleDriveClient,
  driveErrorToFailure,
  type DriveFileContent,
} from "../../tools/drive/client";

const inputSchema = z.object({
  fileId: z.string().trim().min(1).max(256),
});

export type DriveReadInput = z.infer<typeof inputSchema>;
export interface DriveReadOutput {
  readonly file: DriveFileContent;
}

export function createDriveReadSkill(client?: GoogleDriveClient) {
  return defineSkill<DriveReadInput, DriveReadOutput>({
    name: "drive_read",
    description:
      "Reads a Google Drive file's text content by id (from drive_list). Google Docs/Slides are returned as plain text and Google Sheets as CSV; other file types are returned as their raw decoded text.",
    inputDescription: '{ "fileId": Google Drive file id }',
    inputSchema,
    execution: { mutability: "read", impact: "normal" },
    configured: client !== undefined,
    async execute(
      input: DriveReadInput,
      context: SkillContext,
    ): Promise<SkillResult<DriveReadOutput>> {
      if (!client) {
        return {
          success: false,
          error: { code: "GOOGLE_DRIVE_UNAVAILABLE", message: "Google Drive is not configured." },
        };
      }
      try {
        const file = await client.readFile({
          fileId: input.fileId,
          ...(context.signal ? { signal: context.signal } : {}),
        });
        return { success: true, data: { file } };
      } catch (error: unknown) {
        if (context.signal?.aborted) throw error;
        return { success: false, error: driveErrorToFailure(error) };
      }
    },
  });
}
