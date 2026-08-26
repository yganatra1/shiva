import { z } from "zod";

import { defineSkill } from "../define-skill";
import type { SkillContext, SkillResult } from "../types";
import {
  GoogleGmailClient,
  gmailErrorToFailure,
  type SentMessage,
} from "../../tools/gmail/client";

const inputSchema = z.object({
  to: z.string().trim().min(1).max(500),
  subject: z.string().trim().max(500).default(""),
  body: z.string().trim().min(1).max(50_000),
});

export type GmailSendInput = z.infer<typeof inputSchema>;
export interface GmailSendOutput {
  readonly sent: SentMessage;
}

export function createGmailSendSkill(client?: GoogleGmailClient) {
  return defineSkill<GmailSendInput, GmailSendOutput>({
    name: "gmail_send",
    description:
      "Sends a new Gmail message from the configured account. Use gmail_reply instead when continuing an existing thread.",
    inputDescription: '{ "to": recipient email(s), "subject"?: string, "body": string }',
    inputSchema,
    execution: { mutability: "write", impact: "normal" },
    configured: client !== undefined,
    async execute(
      input: GmailSendInput,
      context: SkillContext,
    ): Promise<SkillResult<GmailSendOutput>> {
      if (!client) {
        return {
          success: false,
          error: { code: "GMAIL_UNAVAILABLE", message: "Gmail is not configured." },
        };
      }
      try {
        const sent = await client.send({
          to: input.to,
          subject: input.subject,
          body: input.body,
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
