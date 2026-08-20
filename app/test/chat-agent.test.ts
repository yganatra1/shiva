import assert from "node:assert/strict";
import { test } from "node:test";

import { createApp } from "../src/app.js";
import { AgentCancelledError } from "../src/agent/agent-loop.js";
import type { AgentOrchestratorPort } from "../src/agent/types.js";
import type { AIProvider } from "../src/brain/ai-provider.js";
import {
  createTestOverrides,
  InMemoryRepository,
  testConfig,
} from "./test-support.js";

test("skill turns reuse the shared chat persistence pipeline while ordinary chat still streams", async (context) => {
  const repository = new InMemoryRepository();
  let providerStreams = 0;
  const provider: AIProvider = {
    async chat() {
      return { content: '{"memories":[]}' };
    },
    async *streamChat() {
      providerStreams += 1;
      yield { content: "Normal " };
      yield { content: "stream." };
    },
  };
  const agentRequests: Parameters<AgentOrchestratorPort["run"]>[0][] = [];
  const agentOrchestrator: AgentOrchestratorPort = {
    shouldHandle(message) {
      return /expense/i.test(message);
    },
    async run(request) {
      agentRequests.push(request);
      return {
        runId: "90000000-0000-4000-8000-000000000009",
        response: "Recorded INR 450 for pizza.",
        steps: 2,
        observations: [],
      };
    },
  };
  const app = createApp(testConfig, {
    ...createTestOverrides(provider, repository),
    agentOrchestrator,
  });
  context.after(() => app.close());

  const skillResponse = await app.inject({
    method: "POST",
    url: "/chat",
    headers: { "content-type": "application/json" },
    payload: { message: "Add this expense: INR 450 for pizza." },
  });
  assert.equal(skillResponse.statusCode, 200);
  assert.equal(skillResponse.body, "Recorded INR 450 for pizza.");
  assert.equal(providerStreams, 0);
  assert.equal(agentRequests.length, 1);
  assert.equal(agentRequests[0]?.timeZone, "Asia/Kolkata");
  assert.ok(
    repository.messages.some(
      (message) =>
        message.role === "assistant" &&
        message.content === "Recorded INR 450 for pizza.",
    ),
  );

  const normalResponse = await app.inject({
    method: "POST",
    url: "/chat",
    headers: { "content-type": "application/json" },
    payload: { message: "Explain Newton's third law." },
  });
  assert.equal(normalResponse.statusCode, 200);
  assert.equal(normalResponse.body, "Normal stream.");
  assert.equal(providerStreams, 1);
});

test("voice-styled diagnostic chat enters the same orchestrator with voice guidance", async (context) => {
  let sawVoiceGuidance = false;
  const agentOrchestrator: AgentOrchestratorPort = {
    shouldHandle() {
      return true;
    },
    async run(request) {
      sawVoiceGuidance = request.contextMessages.some((message) =>
        /spoken aloud/i.test(message.content),
      );
      return {
        runId: "90000000-0000-4000-8000-000000000009",
        response: "I recorded the expense.",
        steps: 2,
        observations: [],
      };
    },
  };
  const provider: AIProvider = {
    async chat() {
      return { content: '{"memories":[]}' };
    },
    async *streamChat() {
      throw new Error("Agent response should bypass the direct chat stream.");
    },
  };
  const app = createApp(testConfig, {
    ...createTestOverrides(provider),
    agentOrchestrator,
  });
  context.after(() => app.close());

  const response = await app.inject({
    method: "POST",
    url: "/voice/chat",
    headers: { "content-type": "application/json" },
    payload: { message: "Record INR 20 as an expense." },
  });

  assert.equal(response.statusCode, 200);
  assert.equal(response.body, "I recorded the expense.");
  assert.equal(sawVoiceGuidance, true);
});

test("agent cancellation uses the existing public cancellation contract", async (context) => {
  const provider: AIProvider = {
    async chat() { return { content: '{"memories":[]}' }; },
    async *streamChat() { throw new Error("Direct chat must not run."); },
  };
  const app = createApp(testConfig, {
    ...createTestOverrides(provider),
    agentOrchestrator: {
      shouldHandle() { return true; },
      async run() { throw new AgentCancelledError(); },
    },
  });
  context.after(() => app.close());

  const response = await app.inject({
    method: "POST",
    url: "/chat",
    headers: { "content-type": "application/json" },
    payload: { message: "List my expenses." },
  });

  assert.equal(response.statusCode, 499);
  assert.deepEqual(response.json(), {
    error: { code: "REQUEST_CANCELLED", message: "The request was cancelled." },
  });
});
