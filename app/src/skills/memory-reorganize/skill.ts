import { z } from "zod";

import type { EmbeddingProvider } from "../../brain/embedding-provider";
import type { MemoryRecord, MemoryRepositoryPort } from "../../memory/types";
import { defineSkill } from "../define-skill";

const inputSchema = z.object({}).strict();

/** Near-exact duplicates only, so a merely related fact is never mistaken for a copy. */
const SIMILARITY_THRESHOLD = 0.95;
const MAX_MEMORIES_CONSIDERED = 500;
/** Caps concurrent calls to the embedding provider during one reorganize pass. */
const EMBED_CONCURRENCY = 10;

export interface MemoryReorganizeSummary {
  readonly memoryType: "semantic" | "episodic";
  readonly semanticType: string | null;
  readonly count: number;
  readonly memories: readonly { readonly id: string; readonly content: string }[];
}

export function createMemoryReorganizeSkill(
  repository: MemoryRepositoryPort,
  embeddingProvider: EmbeddingProvider,
) {
  return defineSkill({
    name: "memory_reorganize",
    description:
      "Reviews every one of Shiva's stored active memories for this user, re-embeds each one with the current embedding model, finds near-duplicate or redundant ones from those fresh embeddings, and archives the redundant copies — keeping the most important and complete memory from each duplicate group. Also re-syncs the stored vector of every surviving memory so future searches stay accurate even if the embedding model changed since it was saved. Use this when the user asks to clean up, deduplicate, tidy up, or \"properly configure\" memory. Returns which memories were archived and a grouped summary of what remains.",
    inputDescription: "{}",
    inputSchema,
    execution: {
      mutability: "write",
      impact: "sensitive",
      confirmationReason:
        "This can archive multiple stored memories at once based on similarity, and archiving cannot be undone from chat.",
    },
    configured: true,
    async execute(_input, context) {
      const active = await repository.listActiveMemories(
        context.userId,
        MAX_MEMORIES_CONSIDERED,
      );
      if (active.length === 0) {
        return {
          success: true,
          data: {
            reviewedCount: 0,
            duplicateGroupsFound: 0,
            archivedCount: 0,
            archived: [],
            embeddingsRefreshed: 0,
            remainingCount: 0,
            memoryTree: [],
          },
        };
      }

      const embeddings = await mapWithConcurrency(
        active,
        EMBED_CONCURRENCY,
        (memory) =>
          embeddingProvider.embed(
            context.signal
              ? { text: memory.content, signal: context.signal }
              : { text: memory.content },
          ),
      );
      const embeddingById = new Map<string, readonly number[]>();
      active.forEach((memory, index) => {
        const embedding = embeddings[index];
        if (embedding) embeddingById.set(memory.id, embedding);
      });

      const byId = new Map(active.map((memory) => [memory.id, memory]));
      const pairs = findDuplicatePairs(active, embeddingById, SIMILARITY_THRESHOLD);
      const clusters = clusterDuplicates(pairs);

      const archived: { id: string; content: string }[] = [];
      let duplicateGroupsFound = 0;
      for (const memberIds of clusters.values()) {
        const members = memberIds
          .map((id) => byId.get(id))
          .filter((memory): memory is MemoryRecord => Boolean(memory));
        if (members.length < 2) continue;
        duplicateGroupsFound += 1;

        const keeper = members.reduce((best, candidate) =>
          isBetterKeeper(candidate, best) ? candidate : best,
        );
        for (const member of members) {
          if (member.id === keeper.id) continue;
          const ok = await repository.archiveMemory(context.userId, member.id);
          if (ok) archived.push({ id: member.id, content: member.content });
        }
      }

      const archivedIds = new Set(archived.map((entry) => entry.id));
      const remaining = active.filter((memory) => !archivedIds.has(memory.id));

      let embeddingsRefreshed = 0;
      for (const memory of remaining) {
        const embedding = embeddingById.get(memory.id);
        if (!embedding) continue;
        const ok = await repository.updateMemoryEmbedding(
          context.userId,
          memory.id,
          embedding,
        );
        if (ok) embeddingsRefreshed += 1;
      }

      return {
        success: true,
        data: {
          reviewedCount: active.length,
          duplicateGroupsFound,
          archivedCount: archived.length,
          archived,
          embeddingsRefreshed,
          remainingCount: remaining.length,
          memoryTree: groupMemories(remaining),
        },
      };
    },
  });
}

async function mapWithConcurrency<T, R>(
  items: readonly T[],
  concurrency: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let nextIndex = 0;
  async function worker(): Promise<void> {
    while (true) {
      const index = nextIndex;
      nextIndex += 1;
      if (index >= items.length) return;
      const item = items[index];
      if (item === undefined) continue;
      results[index] = await fn(item);
    }
  }
  await Promise.all(
    Array.from({ length: Math.min(concurrency, items.length) }, () => worker()),
  );
  return results;
}

/** Pairwise cosine similarity over freshly computed embeddings, restricted to same-type memories. */
function findDuplicatePairs(
  active: readonly MemoryRecord[],
  embeddingById: ReadonlyMap<string, readonly number[]>,
  minimumSimilarity: number,
): { readonly firstId: string; readonly secondId: string }[] {
  const pairs: { firstId: string; secondId: string }[] = [];
  for (let i = 0; i < active.length; i += 1) {
    const first = active[i];
    if (!first) continue;
    const firstEmbedding = embeddingById.get(first.id);
    if (!firstEmbedding) continue;
    for (let j = i + 1; j < active.length; j += 1) {
      const second = active[j];
      if (!second) continue;
      if (first.memoryType !== second.memoryType) continue;
      const secondEmbedding = embeddingById.get(second.id);
      if (!secondEmbedding) continue;
      const similarity = cosineSimilarity(firstEmbedding, secondEmbedding);
      if (similarity >= minimumSimilarity) {
        pairs.push({ firstId: first.id, secondId: second.id });
      }
    }
  }
  return pairs;
}

function cosineSimilarity(left: readonly number[], right: readonly number[]): number {
  let dot = 0;
  let leftMagnitude = 0;
  let rightMagnitude = 0;
  for (let index = 0; index < left.length; index += 1) {
    const leftValue = left[index] ?? 0;
    const rightValue = right[index] ?? 0;
    dot += leftValue * rightValue;
    leftMagnitude += leftValue * leftValue;
    rightMagnitude += rightValue * rightValue;
  }
  const denominator = Math.sqrt(leftMagnitude) * Math.sqrt(rightMagnitude);
  return denominator === 0 ? 0 : dot / denominator;
}

/** Union-find over the near-duplicate pairs so transitive duplicates (A~B, B~C) land in one group. */
function clusterDuplicates(
  pairs: readonly { readonly firstId: string; readonly secondId: string }[],
): Map<string, string[]> {
  const parent = new Map<string, string>();
  const find = (id: string): string => {
    let root = id;
    while (parent.get(root) && parent.get(root) !== root) {
      root = parent.get(root) as string;
    }
    parent.set(id, root);
    return root;
  };
  const union = (a: string, b: string): void => {
    const rootA = find(a);
    const rootB = find(b);
    if (rootA !== rootB) parent.set(rootA, rootB);
  };

  for (const pair of pairs) {
    if (!parent.has(pair.firstId)) parent.set(pair.firstId, pair.firstId);
    if (!parent.has(pair.secondId)) parent.set(pair.secondId, pair.secondId);
    union(pair.firstId, pair.secondId);
  }

  const clusters = new Map<string, string[]>();
  for (const id of parent.keys()) {
    const root = find(id);
    const members = clusters.get(root) ?? [];
    members.push(id);
    clusters.set(root, members);
  }
  return clusters;
}

/** Prefers higher importance, then the most recent memory, then the more complete (longer) content. */
function isBetterKeeper(candidate: MemoryRecord, current: MemoryRecord): boolean {
  if (candidate.importance !== current.importance) {
    return candidate.importance > current.importance;
  }
  const candidateTime = (candidate.occurredAt ?? candidate.createdAt).getTime();
  const currentTime = (current.occurredAt ?? current.createdAt).getTime();
  if (candidateTime !== currentTime) return candidateTime > currentTime;
  return candidate.content.length > current.content.length;
}

function groupMemories(records: readonly MemoryRecord[]): MemoryReorganizeSummary[] {
  const groups = new Map<string, MemoryReorganizeSummary>();
  for (const record of records) {
    const key = `${record.memoryType}:${record.semanticType ?? ""}`;
    const existing = groups.get(key);
    const entry = { id: record.id, content: record.content };
    if (existing) {
      (existing.memories as { id: string; content: string }[]).push(entry);
    } else {
      groups.set(key, {
        memoryType: record.memoryType,
        semanticType: record.semanticType,
        count: 0,
        memories: [entry],
      });
    }
  }
  return [...groups.values()]
    .map((group) => ({ ...group, count: group.memories.length }))
    .sort((left, right) => right.count - left.count);
}
