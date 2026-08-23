import type { MemorySearchResult, RankedMemory } from "./types";

const MILLISECONDS_PER_DAY = 86_400_000;

export class MemoryRanker {
  rank(
    candidates: readonly MemorySearchResult[],
    limit: number,
    now = new Date(),
  ): readonly RankedMemory[] {
    return candidates
      .map((memory) => ({
        ...memory,
        score: calculateScore(memory, now),
      }))
      .sort((left, right) => right.score - left.score)
      .slice(0, limit);
  }
}

function calculateScore(memory: MemorySearchResult, now: Date): number {
  const similarity = clamp(memory.similarity);
  const importance = clamp(memory.importance);
  const memoryDate = memory.occurredAt ?? memory.createdAt;
  const ageDays = Math.max(
    0,
    (now.getTime() - memoryDate.getTime()) / MILLISECONDS_PER_DAY,
  );
  const recency = 1 / (1 + ageDays / 90);

  return similarity * 0.7 + importance * 0.2 + recency * 0.1;
}

function clamp(value: number): number {
  return Math.min(1, Math.max(0, value));
}
