import { z } from "zod";

import { defineSkill } from "../define-skill";
import type { SkillContext, SkillResult } from "../types";
import {
  GoogleGmailClient,
  gmailErrorToFailure,
  type SentMessage,
} from "../../tools/gmail/client";

const inputSchema = z.object({
  threadId: z.string().trim().min(1).max(50),
  to: z.string().trim().min(1).max(500),
  subject: z.string().trim().max(500).default(""),
  body: z.string().trim().min(1).max(50_000),
  inReplyTo: z.string().trim().max(998).optional(),
});

export type GmailReplyInput = z.infer<typeof inputSchema>;
export interface GmailReplyOutput {
  readonly sent: SentMessage;
}

export function createGmailReplySkill(client?: GoogleGmailClient) {
  return defineSkill<GmailReplyInput, GmailReplyOutput>({
    name: "gmail_reply",
    description:
      "Replies within an existing Gmail thread. Get threadId and inReplyTo (the original message's messageIdHeader) from gmail_read first, so the reply threads correctly.",
    inputDescription:
      '{ "threadId": string, "to": recipient email(s), "subject"?: string, "body": string, "inReplyTo"?: original Message-ID header }',
    inputSchema,
    execution: { mutability: "write", impact: "normal" },
    configured: client !== undefined,
    async execute(
      input: GmailReplyInput,
      context: SkillContext,
    ): Promise<SkillResult<GmailReplyOutput>> {
      if (!client) {
        return {
          success: false,
          error: { code: "GMAIL_UNAVAILABLE", message: "Gmail is not configured." },
        };
      }
      try {
        const sent = await client.reply({
          threadId: input.threadId,
          to: input.to,
          subject: input.subject,
          body: input.body,
          ...(input.inReplyTo ? { inReplyTo: input.inReplyTo } : {}),
          ...(context.signal ? { signal: context.signal } : {}),
        });
        return { success: true, data: { sent } };
      } catch (error: unknown) {
        if (context.signal?.aborted) throw error;
        return { success: false, error: gmailErrorToFailure(error) };
      }
    },
  });
}
