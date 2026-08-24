import { z } from "zod";

import type { MemoryRepositoryPort } from "../../memory/types";
import { defineSkill } from "../define-skill";

const inputSchema = z
  .object({
    memoryId: z.string().uuid(),
  })
  .strict();

export function createMemoryForgetSkill(repository: MemoryRepositoryPort) {
  return defineSkill({
    name: "memory_forget",
    description:
      "Archives one active memory by id so it is no longer retrieved or surfaced. Use memory_search first to find the memory id, and only archive when the user explicitly asks Shiva to forget something.",
    inputDescription: '{"memoryId":"uuid of the memory to archive"}',
    inputSchema,
    execution: {
      mutability: "write",
      impact: "sensitive",
      confirmationReason: "This archives a stored memory and cannot be undone from chat.",
    },
    configured: true,
    async execute(input, context) {
      const archived = await repository.archiveMemory(
        context.userId,
        input.memoryId,
      );
      if (!archived) {
        return {
          success: false,
          error: {
            code: "MEMORY_NOT_FOUND",
            message: "No active memory with that id was found for this user.",
          },
        };
      }
      return { success: true, data: { archived: true } };
    },
  });
}
