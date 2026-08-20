import assert from "node:assert/strict";
import { test } from "node:test";

import type {
  AIProvider,
  ChatInput,
} from "../src/brain/ai-provider.js";
import {
  MAX_EXTRACTED_MEMORIES,
  MemoryExtractionError,
  MemoryExtractor,
} from "../src/memory/memory-extractor.js";
import type { MemoryRecord } from "../src/memory/types.js";

test("explicit extraction audits a compound statement for omitted atomic meanings", async () => {
  const inputs: ChatInput[] = [];
  const responses = [
    {
      memories: [
        {
          shouldRemember: true,
          memoryType: "semantic",
          semanticType: "relationship",
          content: "Charmi is Yash's wife.",
          importance: 0.9,
          confidence: 0.98,
        },
      ],
    },
    {
      memories: [
        {
          shouldRemember: true,
          memoryType: "semantic",
          semanticType: "preference",
          content: "Yash loves travelling with his wife Charmi.",
          importance: 0.9,
          confidence: 0.97,
        },
      ],
    },
  ];
  const provider: AIProvider = {
    async chat(input) {
      inputs.push(input);
      const response = responses.shift();
      assert.ok(response);
      return { content: JSON.stringify(response) };
    },
    async *streamChat() {
      throw new Error("Extraction must use non-streaming structured output.");
    },
  };
  const extractor = new MemoryExtractor(provider);

  const memories = await extractor.extract({
    userMessage: "Remember that I love travelling with my Wife Charmi",
    assistantResponse: "",
    recentMessages: [],
    explicitRequest: true,
  });

  assert.deepEqual(
    memories.map((memory) => [memory.semanticType, memory.content]),
    [
      ["relationship", "Charmi is Yash's wife."],
      ["preference", "Yash loves travelling with his wife Charmi."],
    ],
  );
  assert.equal(inputs.length, 2);
  assert.equal(typeof inputs[0]?.responseFormat, "object");
  assert.equal(typeof inputs[1]?.responseFormat, "object");
  assert.doesNotMatch(
    JSON.stringify(inputs[0]?.responseFormat),
    /\$schema|pattern|oneOf|anyOf|const|minimum|maximum/,
  );
  assert.match(inputs[1]?.messages[0]?.content ?? "", /omitted durable meanings/i);
  assert.match(
    inputs[1]?.messages[1]?.content ?? "",
    /Remember that I love travelling with my Wife Charmi/,
  );
});

test("correction audit replaces a merged old preference with only the current value", async () => {
  const inputs: ChatInput[] = [];
  const responses = [
    {
      memories: [
        {
          shouldRemember: true,
          memoryType: "semantic",
          semanticType: "preference",
          content: "The user's favorite colors are blue and black.",
          importance: 1,
          confidence: 1,
        },
      ],
    },
    {
      memories: [
        {
          shouldRemember: true,
          memoryType: "semantic",
          semanticType: "preference",
          content: "Yash's favourite colour is only blue.",
          importance: 1,
          confidence: 1,
        },
      ],
    },
  ];
  const provider: AIProvider = {
    async chat(input) {
      inputs.push(input);
      const response = responses.shift();
      assert.ok(response);
      return { content: JSON.stringify(response) };
    },
    async *streamChat() {
      throw new Error("Extraction must use non-streaming structured output.");
    },
  };
  const extractor = new MemoryExtractor(provider);

  const memories = await extractor.extract({
    userMessage:
      "Now I am thinking my favourite color is Blue Actually only Blue",
    assistantResponse: "",
    recentMessages: [],
  });

  assert.deepEqual(
    memories.map((memory) => memory.content),
    ["Yash's favourite colour is only blue."],
  );
  assert.equal(inputs.length, 2);
  assert.equal(typeof inputs[0]?.responseFormat, "object");
  assert.equal(typeof inputs[1]?.responseFormat, "object");
  assert.doesNotMatch(
    JSON.stringify(inputs[1]?.responseFormat),
    /\$schema|pattern|oneOf|anyOf|const|minimum|maximum/,
  );
  assert.match(inputs[1]?.messages[0]?.content ?? "", /authoritative/i);
  assert.doesNotMatch(memories[0]?.content ?? "", /black/i);
});

test("invalid optional temporal values do not discard an extracted memory batch", async () => {
  const extractor = new MemoryExtractor(
    extractionProvider({
      memories: [
        {
          shouldRemember: true,
          memoryType: "semantic",
          semanticType: "relationship",
          content: "Charmi is Yash's wife.",
          importance: 0.9,
          confidence: 0.98,
          occurredAt: "2026-02-30T00:00:00Z",
          validFrom: "2026-08-19",
          validUntil: 42,
        },
        {
          shouldRemember: true,
          memoryType: "semantic",
          semanticType: "preference",
          content: "Yash loves travelling with his wife Charmi.",
          importance: 0.9,
          confidence: 0.97,
          validFrom: "now",
        },
      ],
    }),
  );

  const memories = await extractor.extract({
    userMessage: "I love travelling with my wife Charmi.",
    assistantResponse: "That sounds meaningful.",
    recentMessages: [],
  });

  assert.equal(memories.length, 2);
  assert.deepEqual(
    memories.map((memory) => memory.validFrom),
    [null, null],
  );
  assert.equal(memories[0]?.occurredAt, null);
  assert.equal(memories[0]?.validUntil, null);
});

test("valid RFC 3339 temporal values survive while unreliable windows are cleared", async () => {
  const extractor = new MemoryExtractor(
    extractionProvider({
      memories: [
        {
          shouldRemember: true,
          memoryType: "episodic",
          semanticType: "none",
          content: "Yash made a project decision.",
          importance: 0.8,
          confidence: 0.9,
          occurredAt: " 2026-08-19T05:30:00+05:30 ",
          validFrom: "2026-12-31T00:00:00Z",
          validUntil: "2026-01-01T00:00:00Z",
        },
        {
          shouldRemember: true,
          memoryType: "semantic",
          semanticType: "project_fact",
          content: "Shiva's current deployment window is scheduled.",
          importance: 0.7,
          confidence: 0.9,
          validFrom: "2026-08-19T00:00:00Z",
          validUntil: "2026-12-31T23:59:59Z",
        },
      ],
    }),
  );

  const memories = await extractor.extract({
    userMessage: "I made a project decision.",
    assistantResponse: "Understood.",
    recentMessages: [],
  });

  assert.equal(
    memories[0]?.occurredAt?.toISOString(),
    "2026-08-19T00:00:00.000Z",
  );
  assert.equal(memories[0]?.validFrom, null);
  assert.equal(memories[0]?.validUntil, null);
  assert.equal(
    memories[1]?.validFrom?.toISOString(),
    "2026-08-19T00:00:00.000Z",
  );
  assert.equal(
    memories[1]?.validUntil?.toISOString(),
    "2026-12-31T23:59:59.000Z",
  );
});

test("an unusable memory is dropped without discarding its siblings", async () => {
  const warnings: string[] = [];
  const extractor = new MemoryExtractor(
    extractionProvider({
      memories: [
        {
          shouldRemember: true,
          memoryType: "semantic",
          semanticType: "preference",
          content: "Yash prefers aisle seats.",
          importance: 0.8,
          confidence: "high",
          validFrom: "not-a-timestamp",
        },
        {
          shouldRemember: true,
          memoryType: "semantic",
          semanticType: "relationship",
          content: "Charmi is Yash's wife.",
          importance: 0.9,
          confidence: 0.95,
        },
      ],
    }),
    (_detail, message) => warnings.push(message),
  );

  const extracted = await extractor.extract({
    userMessage: "I prefer aisle seats.",
    assistantResponse: "Understood.",
    recentMessages: [],
  });

  assert.equal(extracted.length, 1);
  assert.equal(extracted[0]?.content, "Charmi is Yash's wife.");
  assert.equal(warnings.length, 1);
});

test("a mislabelled semantic type is repaired instead of failing the batch", async () => {
  const extractor = new MemoryExtractor(
    extractionProvider({
      memories: [
        {
          shouldRemember: true,
          memoryType: "episodic",
          semanticType: "fact",
          content: "Yash booked a flight to Tokyo.",
          importance: 0.6,
          confidence: 0.8,
        },
        {
          shouldRemember: true,
          memoryType: "semantic",
          semanticType: "none",
          content: "Yash lives in Ahmedabad.",
          importance: 0.7,
          confidence: 0.9,
        },
      ],
    }),
  );

  const extracted = await extractor.extract({
    userMessage: "I booked a flight to Tokyo. I live in Ahmedabad.",
    assistantResponse: "Noted.",
    recentMessages: [],
  });

  assert.deepEqual(
    extracted.map((memory) => [memory.memoryType, memory.semanticType]),
    [
      ["episodic", null],
      ["semantic", "fact"],
    ],
  );
});

test("more memories than the cap are truncated rather than rejected", async () => {
  const extractor = new MemoryExtractor(
    extractionProvider({
      memories: Array.from({ length: MAX_EXTRACTED_MEMORIES + 4 }, (_v, i) => ({
        shouldRemember: true,
        memoryType: "semantic",
        semanticType: "fact",
        content: `Fact number ${i}.`,
        importance: 0.5,
        confidence: 0.5,
      })),
    }),
  );

  const extracted = await extractor.extract({
    userMessage: "Remember all of this.",
    assistantResponse: "Noted.",
    recentMessages: [],
  });

  assert.equal(extracted.length, MAX_EXTRACTED_MEMORIES);
});

test("a malformed relationship classification falls back to unrelated", async () => {
  const extractor = new MemoryExtractor(
    extractionProvider({ relationship: "maybe", confidence: 2 }),
  );

  const result = await extractor.classifyRelationship(
    activeMemory("Yash prefers window seats."),
    {
      memoryType: "semantic",
      semanticType: "preference",
      content: "Yash prefers aisle seats.",
      importance: 0.8,
      confidence: 0.9,
      occurredAt: null,
      validFrom: null,
      validUntil: null,
      metadata: {},
    },
  );

  assert.deepEqual(result, { relationship: "unrelated", confidence: 0 });
});

test("a response that is not JSON at all still surfaces an extraction error", async () => {
  const extractor = new MemoryExtractor({
    async chat() {
      return { content: "I cannot help with that." };
    },
    async *streamChat() {
      throw new Error("Extraction must use non-streaming structured output.");
    },
  });

  await assert.rejects(
    extractor.extract({
      userMessage: "I prefer aisle seats.",
      assistantResponse: "Understood.",
      recentMessages: [],
    }),
    MemoryExtractionError,
  );
});

function activeMemory(content: string): MemoryRecord {
  const now = new Date("2026-08-20T00:00:00Z");
  return {
    id: "11111111-1111-4111-8111-111111111111",
    userId: "22222222-2222-4222-8222-222222222222",
    memoryType: "semantic",
    semanticType: "preference",
    content,
    importance: 0.8,
    confidence: 0.9,
    occurredAt: null,
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
  };
}

function extractionProvider(response: unknown): AIProvider {
  return {
    async chat() {
      return { content: JSON.stringify(response) };
    },
    async *streamChat() {
      throw new Error("Extraction must use non-streaming structured output.");
    },
  };
}
