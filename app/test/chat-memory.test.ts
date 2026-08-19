import assert from "node:assert/strict";
import { test } from "node:test";

import { createApp } from "../src/app.js";
import type {
  AIProvider,
  ChatInput,
} from "../src/brain/ai-provider.js";
import {
  createTestOverrides,
  FakeExtractionEngine,
  InMemoryRepository,
  memoryResult,
  testConfig,
} from "./test-support.js";

test("working memory continues when a client reuses the conversation ID", async (context) => {
  const inputs: ChatInput[] = [];
  const provider = recordingProvider(inputs);
  const repository = new InMemoryRepository();
  const app = createApp(
    testConfig,
    createTestOverrides(provider, repository),
  );
  context.after(() => app.close());

  const first = await app.inject({
    method: "POST",
    url: "/chat",
    headers: { "content-type": "application/json" },
    payload: { message: "I'm considering Singapore." },
  });
  const conversationId = String(first.headers["x-shiva-conversation-id"] ?? "");
  assert.equal(first.statusCode, 200);
  assert.match(conversationId ?? "", /^[0-9a-f-]{36}$/);

  const second = await app.inject({
    method: "POST",
    url: "/chat",
    headers: { "content-type": "application/json" },
    payload: {
      message: "How long should I stay there?",
      conversationId,
    },
  });

  assert.equal(second.statusCode, 200);
  assert.equal(second.headers["x-shiva-conversation-id"], conversationId);
  const secondPrompt = inputs[1]?.messages.map((message) => message.content);
  assert.ok(secondPrompt?.includes("I'm considering Singapore."));
  assert.ok(secondPrompt?.includes("How long should I stay there?"));
});

test("an unknown valid conversation ID returns a safe 404", async (context) => {
  const provider = recordingProvider([]);
  const app = createApp(testConfig, createTestOverrides(provider));
  context.after(() => app.close());

  const response = await app.inject({
    method: "POST",
    url: "/chat",
    headers: { "content-type": "application/json" },
    payload: {
      message: "Continue our conversation.",
      conversationId: "90000000-0000-4000-8000-000000000009",
    },
  });

  assert.equal(response.statusCode, 404);
  assert.deepEqual(response.json(), {
    error: {
      code: "CONVERSATION_NOT_FOUND",
      message: "The requested conversation does not exist.",
    },
  });
});

test("a malformed conversation ID is rejected before chat starts", async (context) => {
  const inputs: ChatInput[] = [];
  const provider = recordingProvider(inputs);
  const app = createApp(testConfig, createTestOverrides(provider));
  context.after(() => app.close());

  const response = await app.inject({
    method: "POST",
    url: "/chat",
    headers: { "content-type": "application/json" },
    payload: {
      message: "Continue our conversation.",
      conversationId: "not-a-uuid",
    },
  });

  assert.equal(response.statusCode, 400);
  assert.equal(response.json().error.code, "INVALID_REQUEST");
  assert.equal(inputs.length, 0);
});

test("automatic memory extraction failure does not break the streamed chat", async (context) => {
  const provider = recordingProvider([]);
  const extraction = new FakeExtractionEngine();
  extraction.failure = new Error("synthetic extraction failure");
  const overrides = createTestOverrides(
    provider,
    new InMemoryRepository(),
    undefined,
    extraction,
  );
  const app = createApp(testConfig, overrides);
  context.after(() => app.close());

  const response = await app.inject({
    method: "POST",
    url: "/chat",
    headers: { "content-type": "application/json" },
    payload: { message: "I prefer aisle seats." },
  });

  assert.equal(response.statusCode, 200);
  assert.equal(response.body, "Test response");
  await new Promise<void>((resolve) => setImmediate(resolve));
});

test("explicit compound memory is persisted before acknowledgment and retrieved in a fresh conversation", async (context) => {
  const repository = new InMemoryRepository();
  const extraction = new FakeExtractionEngine();
  extraction.extracted = [
    {
      memoryType: "semantic",
      semanticType: "relationship",
      content: "Charmi is Yash's wife.",
      importance: 0.8,
      confidence: 0.98,
      occurredAt: null,
      validFrom: null,
      validUntil: null,
      metadata: {},
    },
    {
      memoryType: "semantic",
      semanticType: "preference",
      content: "Yash loves travelling with his wife Charmi.",
      importance: 0.9,
      confidence: 0.97,
      occurredAt: null,
      validFrom: null,
      validUntil: null,
      metadata: {},
    },
  ];
  let streamCount = 0;
  const provider: AIProvider = {
    async chat() {
      throw new Error("The fake extraction engine should handle extraction.");
    },
    async *streamChat(input) {
      streamCount += 1;
      if (streamCount === 1) {
        assert.equal(repository.memories.length, 2);
        assert.match(
          input.messages.map((message) => message.content).join("\n"),
          /persisted before this response/,
        );
        assert.match(
          input.messages.map((message) => message.content).join("\n"),
          /Never claim information has been stored or will be remembered unless the memory subsystem confirms persistence/,
        );
        yield { content: "I have remembered that." };
        return;
      }

      const prompt = input.messages.map((message) => message.content).join("\n");
      assert.match(prompt, /Yash loves travelling with his wife Charmi/);
      yield {
        content:
          "You generally enjoy travelling with your wife Charmi, so with a partner rather than solo.",
      };
    },
  };
  const app = createApp(
    testConfig,
    createTestOverrides(provider, repository, undefined, extraction),
  );
  context.after(() => app.close());

  const remembered = await app.inject({
    method: "POST",
    url: "/chat",
    headers: { "content-type": "application/json" },
    payload: {
      message: "Remember that I love travelling with my Wife Charmi",
    },
  });

  assert.equal(remembered.statusCode, 200);
  assert.equal(remembered.body, "I have remembered that.");
  assert.deepEqual(
    repository.memories.map((memory) => memory.semanticType),
    ["relationship", "preference"],
  );

  repository.semanticSearchResults = repository.memories.map((memory) =>
    memoryResult({ ...memory, similarity: 0.94 }),
  );
  extraction.extracted = [];
  const recalled = await app.inject({
    method: "POST",
    url: "/chat",
    headers: { "content-type": "application/json" },
    payload: {
      message: "Do I generally travel solo or with a partner?",
    },
  });

  assert.equal(recalled.statusCode, 200);
  assert.match(recalled.body, /wife Charmi.*partner rather than solo/i);
  assert.notEqual(
    recalled.headers["x-shiva-conversation-id"],
    remembered.headers["x-shiva-conversation-id"],
  );
});

test("explicit persistence failure prevents a remembered acknowledgment", async (context) => {
  class FailingRepository extends InMemoryRepository {
    override async saveMemory(): Promise<never> {
      throw new Error("synthetic persistence failure");
    }
  }

  const extraction = new FakeExtractionEngine();
  extraction.extracted = [
    {
      memoryType: "semantic",
      semanticType: "preference",
      content: "Yash loves travelling with his wife Charmi.",
      importance: 0.9,
      confidence: 0.97,
      occurredAt: null,
      validFrom: null,
      validUntil: null,
      metadata: {},
    },
  ];
  let streamStarted = false;
  const provider: AIProvider = {
    async chat() {
      throw new Error("The fake extraction engine should handle extraction.");
    },
    async *streamChat() {
      streamStarted = true;
      yield { content: "I'll remember that." };
    },
  };
  const app = createApp(
    testConfig,
    createTestOverrides(
      provider,
      new FailingRepository(),
      undefined,
      extraction,
    ),
  );
  context.after(() => app.close());

  const response = await app.inject({
    method: "POST",
    url: "/chat",
    headers: { "content-type": "application/json" },
    payload: {
      message: "Remember that I love travelling with my Wife Charmi",
    },
  });

  assert.equal(response.statusCode, 500);
  assert.equal(streamStarted, false);
  assert.doesNotMatch(response.body, /remember that/i);
});

function recordingProvider(inputs: ChatInput[]): AIProvider {
  return {
    async chat() {
      return { content: '{"memories":[]}' };
    },
    async *streamChat(input) {
      inputs.push(input);
      yield { content: "Test " };
      yield { content: "response" };
    },
  };
}
