import { z } from "zod";

import { defineSkill } from "../define-skill";
import type { SkillContext, SkillResult } from "../types";
import {
  GoogleGmailClient,
  gmailErrorToFailure,
  type GmailMessage,
} from "../../tools/gmail/client";

const inputSchema = z.object({
  messageId: z.string().trim().min(1).max(50),
});

export type GmailReadInput = z.infer<typeof inputSchema>;
export interface GmailReadOutput {
  readonly message: GmailMessage;
}

export function createGmailReadSkill(client?: GoogleGmailClient) {
  return defineSkill<GmailReadInput, GmailReadOutput>({
    name: "gmail_read",
    description:
      "Reads one Gmail message's full content (from, to, subject, date, plain-text body, and threadId/messageIdHeader needed to reply). Use gmail_search first to find the messageId.",
    inputDescription: '{ "messageId": Gmail message id, from gmail_search }',
    inputSchema,
    execution: { mutability: "read", impact: "normal" },
    configured: client !== undefined,
    async execute(
      input: GmailReadInput,
      context: SkillContext,
    ): Promise<SkillResult<GmailReadOutput>> {
      if (!client) {
        return {
          success: false,
          error: { code: "GMAIL_UNAVAILABLE", message: "Gmail is not configured." },
        };
      }
      try {
        const message = await client.getMessage({
          messageId: input.messageId,
          ...(context.signal ? { signal: context.signal } : {}),
        });
        return { success: true, data: { message } };
      } catch (error: unknown) {
        if (context.signal?.aborted) throw error;
        return { success: false, error: gmailErrorToFailure(error) };
      }
    },
  });
}
