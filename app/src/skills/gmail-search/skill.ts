import { z } from "zod";

import { defineSkill } from "../define-skill";
import type { SkillContext, SkillResult } from "../types";
import {
  GoogleGmailClient,
  gmailErrorToFailure,
  type GmailMessageSummary,
} from "../../tools/gmail/client";

const inputSchema = z.object({
  query: z.string().trim().min(1).max(300),
  maxResults: z.number().int().min(1).max(10).default(5),
});

export type GmailSearchInput = z.infer<typeof inputSchema>;
export interface GmailSearchOutput {
  readonly messages: readonly GmailMessageSummary[];
}

export function createGmailSearchSkill(client?: GoogleGmailClient) {
  return defineSkill<GmailSearchInput, GmailSearchOutput>({
    name: "gmail_search",
    description:
      'Searches the user\'s Gmail using Gmail search syntax (e.g. "from:alice subject:invoice is:unread"), returning each match\'s id, threadId, subject, from, date, and snippet. Use gmail_read with the id to get the full body before replying.',
    inputDescription: '{ "query": Gmail search string, "maxResults"?: 1-10 (default 5) }',
    inputSchema,
    execution: { mutability: "read", impact: "normal" },
    configured: client !== undefined,
    async execute(
      input: GmailSearchInput,
      context: SkillContext,
    ): Promise<SkillResult<GmailSearchOutput>> {
      if (!client) {
        return {
          success: false,
          error: { code: "GMAIL_UNAVAILABLE", message: "Gmail is not configured." },
        };
      }
      try {
        const messages = await client.searchMessages({
          query: input.query,
          maxResults: input.maxResults,
          ...(context.signal ? { signal: context.signal } : {}),
        });
        return { success: true, data: { messages } };
      } catch (error: unknown) {
        if (context.signal?.aborted) throw error;
        return { success: false, error: gmailErrorToFailure(error) };
      }
    },
  });
}
