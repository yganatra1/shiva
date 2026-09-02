import { z } from "zod";

import { defineSkill } from "../define-skill";
import type { SkillContext, SkillResult } from "../types";
import {
  GoogleDocsClient,
  docsErrorToFailure,
} from "../../tools/docs/client";

const inputSchema = z.object({
  documentId: z.string().trim().min(5).max(256),
  text: z.string().min(1).max(100_000),
  mode: z.enum(["append", "replace"]),
});

export type DocsUpdateInput = z.infer<typeof inputSchema>;
export interface DocsUpdateOutput {
  readonly documentId: string;
  readonly mode: "append" | "replace";
}

export function createDocsUpdateSkill(client?: GoogleDocsClient) {
  return defineSkill<DocsUpdateInput, DocsUpdateOutput>({
    name: "docs_update",
    description:
      'Writes text into an existing Google Doc by documentId. mode is required: mode="append" adds text to the end of the document, keeping everything already there; mode="replace" deletes the entire existing body and replaces it with the new text. Use docs_find when the document\'s ID is unknown — never guess one — unless docs_create just returned it in this run.',
    inputDescription:
      '{ "documentId": string, "text": string, "mode": "append"|"replace" (required) }',
    inputSchema,
    execution: { mutability: "write", impact: "normal" },
    configured: client !== undefined,
    async execute(
      input: DocsUpdateInput,
      context: SkillContext,
    ): Promise<SkillResult<DocsUpdateOutput>> {
      if (!client) {
        return {
          success: false,
          error: {
            code: "GOOGLE_DOCS_UNAVAILABLE",
            message: "Google Docs is not configured.",
          },
        };
      }
      try {
        const result = await client.updateDocument({
          documentId: input.documentId,
          text: input.text,
          mode: input.mode,
          ...(context.signal ? { signal: context.signal } : {}),
        });
        return { success: true, data: result };
      } catch (error: unknown) {
        if (context.signal?.aborted) throw error;
        return { success: false, error: docsErrorToFailure(error) };
      }
    },
  });
}
