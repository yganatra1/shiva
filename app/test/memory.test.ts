import assert from "node:assert/strict";
import { test } from "node:test";

import { MemoryRanker } from "../src/memory/memory-ranker.js";
import { MemoryRetriever } from "../src/memory/memory-retriever.js";
import {
  containsSecret,
  isExplicitMemoryRequest,
  isFillerMessage,
  MemoryService,
} from "../src/memory/memory-service.js";
import type { ExtractedMemory, StoredMessage } from "../src/memory/types.js";
import {
  FakeEmbeddingProvider,
  FakeExtractionEngine,
  InMemoryRepository,
  memoryResult,
  testConfig,
} from "./test-support.js";

const conversationId = "00000000-0000-4000-8000-000000000010";
const sourceMessage: StoredMessage = {
  id: "00000000-0000-4000-8000-000000000011",
  conversationId,
  role: "user",
  content: "Remember that I prefer aisle seats.",
  createdAt: new Date("2026-08-19T08:00:00.000Z"),
};

test("semantic memory persistence stores a typed durable fact", async () => {
  const { service, repository, extractor } = createMemoryHarness();
  extractor.extracted = [semanticCandidate()];

  const stored = await service.rememberInteraction(interaction(sourceMessage));

  assert.equal(stored.length, 1);
  assert.equal(stored[0]?.memoryType, "semantic");
  assert.equal(stored[0]?.semanticType, "preference");
  assert.equal(repository.memories[0]?.content, "Yash prefers aisle seats.");
});

test("episodic memory persistence retains temporal event data", async () => {
  const { service, repository, extractor } = createMemoryHarness();
  const occurredAt = new Date("2026-08-18T10:30:00.000Z");
  extractor.extracted = [
    {
      memoryType: "episodic",
      semanticType: null,
      content: "Yash selected an RTX 3090 for Shiva development.",
      importance: 0.9,
      confidence: 0.95,
      occurredAt,
      validFrom: null,
      validUntil: null,
      metadata: {},
    },
  ];

  await service.rememberInteraction(
    interaction({ ...sourceMessage, content: "We chose an RTX 3090 today." }),
  );

  assert.equal(repository.memories[0]?.memoryType, "episodic");
  assert.deepEqual(repository.memories[0]?.occurredAt, occurredAt);
});

test("filler messages are ignored before extraction", async () => {
  const { service, repository, extractor, embedding } = createMemoryHarness();
  extractor.extracted = [semanticCandidate()];

  await service.rememberInteraction(
    interaction({ ...sourceMessage, content: "thanks!" }),
  );

  assert.equal(repository.memories.length, 0);
  assert.equal(embedding.texts.length, 0);
  assert.equal(isFillerMessage("  OK. "), true);
});

test("explicit remember requests receive strong priority", async () => {
  const { service, repository, extractor } = createMemoryHarness();
  extractor.extracted = [{ ...semanticCandidate(), importance: 0.2 }];

  await service.rememberInteraction(interaction(sourceMessage));

  assert.equal(isExplicitMemoryRequest(sourceMessage.content), true);
  assert.equal(repository.memories[0]?.importance, 0.85);
  assert.equal(repository.memories[0]?.metadata.explicitMemoryRequest, true);
});

test("a compound explicit request persists every atomic relationship and preference", async () => {
  const { service, repository, extractor } = createMemoryHarness();
  const compoundMessage = {
    ...sourceMessage,
    content: "Remember that I love travelling with my Wife Charmi",
  };
  extractor.extracted = [
    {
      ...semanticCandidate(),
      semanticType: "relationship",
      content: "Charmi is Yash's wife.",
    },
    {
      ...semanticCandidate(),
      semanticType: "preference",
      content: "Yash loves travelling with his wife Charmi.",
    },
  ];

  const result = await service.rememberExplicitInteraction(
    interaction(compoundMessage),
  );

  assert.equal(result.stored.length, 2);
  assert.deepEqual(
    repository.memories.map((memory) => [memory.semanticType, memory.content]),
    [
      ["relationship", "Charmi is Yash's wife."],
      ["preference", "Yash loves travelling with his wife Charmi."],
    ],
  );
  assert.ok(repository.memories.every((memory) => memory.importance >= 0.85));
});

test("semantic and episodic retrieval injects only ranked results", async () => {
  const repository = new InMemoryRepository();
  const embedding = new FakeEmbeddingProvider();
  const semantic = memoryResult({ content: "Yash prefers aisle seats." });
  const episodic = memoryResult({
    id: "10000000-0000-4000-8000-000000000002",
    memoryType: "episodic",
    semanticType: null,
    content: "Yash selected an RTX 3090.",
    similarity: 0.85,
  });
  repository.semanticSearchResults = [semantic];
  repository.episodicSearchResults = [episodic];
  const retriever = new MemoryRetriever(
    repository,
    embedding,
    new MemoryRanker(),
    2,
  );

  const result = await retriever.retrieve(
    testConfig.userId,
    "Which seat and GPU?",
  );

  assert.equal(result.memories.length, 2);
  assert.match(result.systemMessage?.content ?? "", /aisle seats/);
  assert.match(result.systemMessage?.content ?? "", /RTX 3090/);
  assert.deepEqual(repository.touchedMemoryIds, [semantic.id, episodic.id]);
});

test("retrieval ranking combines similarity, importance, and recency", () => {
  const now = new Date("2026-08-19T00:00:00.000Z");
  const highSimilarity = memoryResult({
    id: "10000000-0000-4000-8000-000000000003",
    similarity: 0.95,
    importance: 0.4,
    createdAt: new Date("2026-01-01T00:00:00.000Z"),
  });
  const lowSimilarity = memoryResult({
    id: "10000000-0000-4000-8000-000000000004",
    similarity: 0.6,
    importance: 1,
    createdAt: now,
  });

  const ranked = new MemoryRanker().rank(
    [lowSimilarity, highSimilarity],
    2,
    now,
  );

  assert.equal(ranked[0]?.id, highSimilarity.id);
  assert.ok((ranked[0]?.score ?? 0) > (ranked[1]?.score ?? 0));
});

test("duplicate semantic memories are not inserted", async () => {
  const { service, repository, extractor } = createMemoryHarness();
  extractor.extracted = [semanticCandidate()];
  extractor.relationship = { relationship: "duplicate", confidence: 0.98 };
  repository.similarSemanticResults = [memoryResult()];

  const stored = await service.rememberInteraction(interaction(sourceMessage));

  assert.deepEqual(stored, []);
  assert.equal(repository.memories.length, 0);
});

test("contradictory preferences supersede rather than delete history", async () => {
  const { service, repository, extractor } = createMemoryHarness();
  const old = memoryResult({
    content: "Yash's favourite colour is black.",
    semanticType: "preference",
  });
  repository.memories.push(old);
  repository.similarSemanticResults = [old];
  extractor.extracted = [
    {
      ...semanticCandidate(),
      content: "Yash's favourite colour is dark green.",
    },
  ];
  extractor.relationship = {
    relationship: "contradiction",
    confidence: 0.96,
  };

  const [replacement] = await service.rememberInteraction(
    interaction({
      ...sourceMessage,
      content: "Actually my favourite colour is dark green now.",
    }),
  );

  assert.equal(repository.memories[0]?.status, "superseded");
  assert.equal(repository.memories[0]?.supersededBy, replacement?.id);
  assert.equal(replacement?.status, "active");
});

test("obvious secrets are rejected from ordinary memory", async () => {
  const { service, repository, extractor } = createMemoryHarness();
  extractor.extracted = [semanticCandidate()];
  const secretMessage = {
    ...sourceMessage,
    content: "Remember that my API key is sk-abcdefghijklmnopqrstuvwxyz",
  };

  await service.rememberInteraction(interaction(secretMessage));

  assert.equal(containsSecret(secretMessage.content), true);
  assert.equal(repository.memories.length, 0);
});

function createMemoryHarness() {
  const repository = new InMemoryRepository();
  const embedding = new FakeEmbeddingProvider();
  const extractor = new FakeExtractionEngine();
  return {
    repository,
    embedding,
    extractor,
    service: new MemoryService(repository, embedding, extractor),
  };
}

function semanticCandidate(): ExtractedMemory {
  return {
    memoryType: "semantic",
    semanticType: "preference",
    content: "Yash prefers aisle seats.",
    importance: 0.8,
    confidence: 0.95,
    occurredAt: null,
    validFrom: null,
    validUntil: null,
    metadata: {},
  };
}

function interaction(userMessage: StoredMessage) {
  return {
    userId: testConfig.userId,
    conversationId,
    userMessage,
    assistantResponse: "Understood.",
    recentMessages: [userMessage],
  };
}
