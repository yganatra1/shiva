import { z } from "zod";

import type { EmbeddingProvider } from "../../brain/embedding-provider";
import { MemoryRanker } from "../../memory/memory-ranker";
import type { MemoryRepositoryPort, RankedMemory } from "../../memory/types";
import { defineSkill } from "../define-skill";

const MAX_RESULTS = 20;
const DEFAULT_RESULTS = 5;

const inputSchema = z
  .object({
    query: z.string().trim().min(1).max(500),
    limit: z.number().int().min(1).max(MAX_RESULTS).default(DEFAULT_RESULTS),
    memoryType: z.enum(["semantic", "episodic", "all"]).default("all"),
  })
  .strict();

const ranker = new MemoryRanker();

export function createMemorySearchSkill(
  repository: MemoryRepositoryPort,
  embeddingProvider: EmbeddingProvider,
) {
  return defineSkill({
    name: "memory_search",
    description:
      "Searches Shiva's stored semantic and episodic memory for facts, preferences, relationships, project facts, profile details, and past events relevant to a query. Returns only the most relevant matches, ranked by similarity, importance, and recency — never a full memory dump.",
    inputDescription:
      '{"query":"text to search memory for","limit"?:1..20 (default 5),"memoryType"?:"semantic"|"episodic"|"all" (default "all")}',
    inputSchema,
    execution: { mutability: "read", impact: "normal" },
    configured: true,
    async execute(input, context) {
      const embedding = await embeddingProvider.embed(
        context.signal
          ? { text: input.query, signal: context.signal }
          : { text: input.query },
      );
      const candidateLimit = Math.max(input.limit * 2, 10);
      const types =
        input.memoryType === "all"
          ? (["semantic", "episodic"] as const)
          : ([input.memoryType] as const);
      const results = await Promise.all(
        types.map((memoryType) =>
          repository.searchMemories(
            context.userId,
            memoryType,
            embedding,
            candidateLimit,
          ),
        ),
      );
      const ranked = ranker.rank(results.flat(), input.limit, context.now());

      if (ranked.length > 0) {
        await repository.touchMemories(ranked.map((memory) => memory.id));
      }

      return {
        success: true,
        data: {
          memories: ranked.map(skillMemory),
          count: ranked.length,
        },
      };
    },
  });
}

function skillMemory(memory: RankedMemory) {
  return {
    id: memory.id,
    memoryType: memory.memoryType,
    semanticType: memory.semanticType,
    content: memory.content,
    importance: memory.importance,
    occurredAt: memory.occurredAt?.toISOString() ?? null,
    similarity: memory.similarity,
  };
}
