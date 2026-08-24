import { z } from "zod";

import type { MemoryService } from "../../memory/memory-service";
import { defineSkill } from "../define-skill";

const inputSchema = z
  .object({
    content: z.string().trim().min(1).max(2000),
    memoryType: z.enum(["semantic", "episodic"]).default("semantic"),
    semanticType: z
      .enum(["fact", "preference", "relationship", "project_fact", "profile"])
      .optional(),
    importance: z.number().min(0).max(1).default(0.7),
  })
  .strict();

export function createMemoryRememberSkill(memoryService: MemoryService) {
  return defineSkill({
    name: "memory_remember",
    description:
      "Explicitly stores one atomic fact, preference, relationship, project fact, profile detail, or event in Shiva's durable memory. A near-duplicate of an existing active memory is recognized and skipped; a conflicting one is superseded automatically. Use this only for information worth remembering across conversations, not for the current request itself.",
    inputDescription:
      '{"content":"one atomic statement to remember","memoryType"?:"semantic"|"episodic" (default "semantic"),"semanticType"?:"fact"|"preference"|"relationship"|"project_fact"|"profile" (semantic only, default "fact"),"importance"?:0..1 (default 0.7)}',
    inputSchema,
    execution: { mutability: "write", impact: "normal" },
    configured: true,
    async execute(input, context) {
      const result = await memoryService.rememberFact({
        userId: context.userId,
        content: input.content,
        memoryType: input.memoryType,
        semanticType:
          input.memoryType === "semantic" ? (input.semanticType ?? "fact") : null,
        importance: input.importance,
        confidence: 1,
        sourceConversationId: context.conversationId,
        sourceMessageId: context.sourceMessageId ?? null,
        ...(context.signal ? { signal: context.signal } : {}),
      });

      if (result.outcome === "rejected") {
        return {
          success: false,
          error: {
            code: "MEMORY_REJECTED",
            message:
              "This content looks like a credential or secret and was not stored in memory.",
          },
        };
      }

      return {
        success: true,
        data: {
          outcome: result.outcome,
          memory: result.memory
            ? {
                id: result.memory.id,
                memoryType: result.memory.memoryType,
                semanticType: result.memory.semanticType,
                content: result.memory.content,
              }
            : undefined,
        },
      };
    },
  });
}
