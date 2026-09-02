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

export type DocsFindInput = z.infer<typeof inputSchema>;
export interface DocsFindOutput {
  readonly matches: readonly DriveFile[];
}

export function createDocsFindSkill(client?: GoogleDriveClient) {
  return defineSkill<DocsFindInput, DocsFindOutput>({
    name: "docs_find",
    description:
      "Searches the user's Google Drive by name for Google Docs matching a query (e.g. \"meeting notes\"), returning each match's documentId, name, URL, and last-modified time, most recently modified first. Use this before docs_update when you don't already know a document's exact documentId — never guess one.",
    inputDescription: '{ "query": string, "maxResults"?: 1-25 (default 10) }',
    inputSchema,
    execution: { mutability: "read", impact: "normal" },
    configured: client !== undefined,
    async execute(
      input: DocsFindInput,
      context: SkillContext,
    ): Promise<SkillResult<DocsFindOutput>> {
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
        const matches = await client.findDocuments({
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
