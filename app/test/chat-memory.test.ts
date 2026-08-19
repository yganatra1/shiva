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

test("memory extraction failure does not break the streamed chat", async (context) => {
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
    payload: { message: "Remember that I prefer aisle seats." },
  });

  assert.equal(response.statusCode, 200);
  assert.equal(response.body, "Test response");
  await new Promise<void>((resolve) => setImmediate(resolve));
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
