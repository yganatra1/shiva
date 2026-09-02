import { z } from "zod";

import { defineSkill } from "../define-skill";
import type { SkillContext, SkillResult } from "../types";
import {
  GoogleDocsClient,
  docsErrorToFailure,
} from "../../tools/docs/client";

const inputSchema = z.object({
  title: z.string().trim().max(200).optional(),
  initialText: z.string().max(100_000).optional(),
});

export type DocsCreateInput = z.infer<typeof inputSchema>;
export interface DocsCreateOutput {
  readonly documentId: string;
  readonly title: string;
  readonly url: string;
}

export function createDocsCreateSkill(client?: GoogleDocsClient) {
  return defineSkill<DocsCreateInput, DocsCreateOutput>({
    name: "docs_create",
    description:
      'Creates a brand-new Google Doc. The only thing that ever matters is getting something created — title is optional and defaults to "Untitled Document", so the simplest valid call is {}. Optionally pass initialText to seed the document body immediately; otherwise call docs_update afterward to add content.',
    inputDescription:
      '{ "title"?: string, "initialText"?: string } — everything is optional',
    inputSchema,
    execution: { mutability: "write", impact: "normal" },
    configured: client !== undefined,
    async execute(
      input: DocsCreateInput,
      context: SkillContext,
    ): Promise<SkillResult<DocsCreateOutput>> {
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
        const created = await client.createDocument({
          title: input.title?.trim() || "Untitled Document",
          ...(input.initialText ? { initialText: input.initialText } : {}),
          ...(context.signal ? { signal: context.signal } : {}),
        });
        return { success: true, data: created };
      } catch (error: unknown) {
        if (context.signal?.aborted) throw error;
        return { success: false, error: docsErrorToFailure(error) };
      }
    },
  });
}
