import { z } from "zod";

import type { MemoryRepositoryPort, StoredMessage } from "../../memory/types";
import { defineSkill } from "../define-skill";

const MAX_RESULTS = 20;
const DEFAULT_RESULTS = 5;

const inputSchema = z
  .object({
    query: z.string().trim().min(1).max(500),
    limit: z.number().int().min(1).max(MAX_RESULTS).default(DEFAULT_RESULTS),
  })
  .strict();

export function createConversationSearchSkill(repository: MemoryRepositoryPort) {
  return defineSkill({
    name: "conversation_search",
    description:
      "Searches the raw text of the user's past conversation messages (not extracted memory) for a keyword or phrase. Use this to find something specific that was literally said, when memory_search's distilled facts aren't enough.",
    inputDescription:
      '{"query":"text to search past messages for","limit"?:1..20 (default 5)}',
    inputSchema,
    execution: { mutability: "read", impact: "normal" },
    configured: true,
    async execute(input, context) {
      const matches = await repository.searchConversationMessages(
        context.userId,
        input.query,
        input.limit,
      );
      return {
        success: true,
        data: { messages: matches.map(publicMessage), count: matches.length },
      };
    },
  });
}

function publicMessage(message: StoredMessage) {
  return {
    id: message.id,
    conversationId: message.conversationId,
    role: message.role,
    content: message.content,
    createdAt: message.createdAt.toISOString(),
  };
}
