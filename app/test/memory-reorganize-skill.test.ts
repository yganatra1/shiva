import assert from "node:assert/strict";
import { test } from "node:test";

import type { EmbeddingProvider } from "../src/brain/embedding-provider.js";
import { createMemoryReorganizeSkill } from "../src/skills/memory-reorganize/skill.js";
import type { SkillContext } from "../src/skills/types.js";
import { InMemoryRepository } from "./test-support.js";
import type { MemoryRecord } from "../src/memory/types.js";

const USER_ID = "10000000-0000-4000-8000-000000000001";

const context: SkillContext = {
  agentRunId: "20000000-0000-4000-8000-000000000002",
  conversationId: "30000000-0000-4000-8000-000000000003",
  userId: USER_ID,
  userName: "Yash",
  timeZone: "Asia/Kolkata",
  now: () => new Date("2026-08-27T00:00:00Z"),
};

/** Maps memory content to an explicit vector, so tests control similarity precisely. */
class ScriptedEmbeddingProvider implements EmbeddingProvider {
  readonly requestedTexts: string[] = [];
  constructor(private readonly vectors: ReadonlyMap<string, readonly number[]>) {}

  async embed(input: { readonly text: string }): Promise<readonly number[]> {
    this.requestedTexts.push(input.text);
    const vector = this.vectors.get(input.text);
    assert.ok(vector, `No scripted embedding for text: ${input.text}`);
    return vector;
  }
}

let sequence = 0;
function memory(overrides: Partial<MemoryRecord> = {}): MemoryRecord {
  sequence += 1;
  const id = `40000000-0000-4000-8000-${String(sequence).padStart(12, "0")}`;
  const now = new Date(`2026-08-2${sequence}T00:00:00Z`);
  return {
    id,
    userId: USER_ID,
    memoryType: "semantic",
    semanticType: "fact",
    content: `Memory ${sequence}`,
    importance: 0.7,
    confidence: 0.9,
    occurredAt: now,
    validFrom: null,
    validUntil: null,
    status: "active",
    supersededBy: null,
    sourceConversationId: null,
    sourceMessageId: null,
    metadata: {},
    createdAt: now,
    updatedAt: now,
    lastAccessedAt: null,
    accessCount: 0,
    ...overrides,
  };
}

test("re-embeds each memory's current content, archives the lower-importance member of a duplicate pair, and refreshes surviving embeddings", async () => {
  const repository = new InMemoryRepository();
  const keep = memory({ content: "User's favorite color is blue.", importance: 0.9 });
  const drop = memory({ content: "Favorite color: blue", importance: 0.4 });
  repository.memories.push(keep, drop);
  const embeddingProvider = new ScriptedEmbeddingProvider(
    new Map([
      [keep.content, [1, 0, 0]],
      [drop.content, [0.99, 0.05, 0]],
    ]),
  );
  const skill = createMemoryReorganizeSkill(repository, embeddingProvider);

  const result = await skill.execute({}, context);

  assert.equal(result.success, true);
  if (!result.success) return;
  assert.deepEqual(embeddingProvider.requestedTexts.sort(), [drop.content, keep.content].sort());
  assert.equal(result.data.duplicateGroupsFound, 1);
  assert.equal(result.data.archivedCount, 1);
  assert.deepEqual(
    result.data.archived.map((entry) => entry.id),
    [drop.id],
  );
  assert.equal(result.data.remainingCount, 1);
  assert.equal(
    repository.memories.find((entry) => entry.id === drop.id)?.status,
    "archived",
  );
  assert.equal(
    repository.memories.find((entry) => entry.id === keep.id)?.status,
    "active",
  );
  assert.equal(result.data.embeddingsRefreshed, 1);
  assert.deepEqual(repository.refreshedEmbeddingIds, [keep.id]);
});

test("groups three transitively-duplicate memories into one cluster and keeps only one", async () => {
  const repository = new InMemoryRepository();
  const a = memory({ content: "Lives in Mumbai.", importance: 0.5 });
  const b = memory({ content: "Currently lives in Mumbai.", importance: 0.6 });
  const c = memory({ content: "Home city: Mumbai.", importance: 0.8 });
  repository.memories.push(a, b, c);
  const embeddingProvider = new ScriptedEmbeddingProvider(
    new Map([
      [a.content, [1, 0, 0]],
      [b.content, [0.99, 0.02, 0]],
      [c.content, [0.98, 0.04, 0]],
    ]),
  );
  const skill = createMemoryReorganizeSkill(repository, embeddingProvider);

  const result = await skill.execute({}, context);

  assert.equal(result.success, true);
  if (!result.success) return;
  assert.equal(result.data.duplicateGroupsFound, 1);
  assert.equal(result.data.archivedCount, 2);
  assert.equal(result.data.remainingCount, 1);
  assert.equal(
    repository.memories.find((entry) => entry.id === c.id)?.status,
    "active",
    "the most important member of the cluster must be the one kept",
  );
});

test("leaves unrelated memories alone, refreshes their embeddings, and reports a clean grouped summary", async () => {
  const repository = new InMemoryRepository();
  const fact = memory({ memoryType: "semantic", semanticType: "fact", content: "Owns a car." });
  const preference = memory({
    memoryType: "semantic",
    semanticType: "preference",
    content: "Prefers tea over coffee.",
  });
  repository.memories.push(fact, preference);
  const embeddingProvider = new ScriptedEmbeddingProvider(
    new Map([
      [fact.content, [1, 0, 0]],
      [preference.content, [0, 1, 0]],
    ]),
  );
  const skill = createMemoryReorganizeSkill(repository, embeddingProvider);

  const result = await skill.execute({}, context);

  assert.equal(result.success, true);
  if (!result.success) return;
  assert.equal(result.data.duplicateGroupsFound, 0);
  assert.equal(result.data.archivedCount, 0);
  assert.equal(result.data.remainingCount, 2);
  assert.equal(result.data.embeddingsRefreshed, 2);
  assert.deepEqual(
    result.data.memoryTree.map((group) => group.semanticType).sort(),
    ["fact", "preference"],
  );
});

test("requires confirmation, since it can archive several memories at once", () => {
  const skill = createMemoryReorganizeSkill(
    new InMemoryRepository(),
    new ScriptedEmbeddingProvider(new Map()),
  );
  assert.deepEqual(skill.execution, {
    mutability: "write",
    impact: "sensitive",
    confirmationReason:
      "This can archive multiple stored memories at once based on similarity, and archiving cannot be undone from chat.",
  });
});
