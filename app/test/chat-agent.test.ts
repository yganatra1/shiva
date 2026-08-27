import assert from "node:assert/strict";
import { test } from "node:test";

import { createApp } from "../src/app.js";
import { AgentCancelledError } from "../src/agent/agent-loop.js";
import type { AgentOrchestratorPort } from "../src/agent/types.js";
import type { AIProvider } from "../src/brain/ai-provider.js";
import {
  createTestOverrides,
  InMemoryRepository,
  memoryResult,
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
    async run(request) {
      agentRequests.push(request);
      if (!/expense/i.test(request.userMessage)) {
        return {
          kind: "direct_chat",
          runId: "90000000-0000-4000-8000-000000000010",
          response: undefined,
          steps: 1,
          observations: [],
        };
      }
      return {
        kind: "response",
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
    async run(request) {
      sawVoiceGuidance = request.contextMessages.some((message) =>
        /spoken aloud/i.test(message.content),
      );
      return {
        kind: "response",
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

test("retrieved memory reaches both the direct-chat response and the planner, via separate channels", async (context) => {
  const repository = new InMemoryRepository();
  repository.semanticSearchResults = [
    memoryResult({ content: "The user's wife's name is Charmi." }),
  ];
  let plannerRequest: Parameters<AgentOrchestratorPort["run"]>[0] | undefined;
  const agentOrchestrator: AgentOrchestratorPort = {
    async run(request) {
      plannerRequest = request;
      return {
        kind: "direct_chat",
        runId: "90000000-0000-4000-8000-000000000012",
        response: undefined,
        steps: 1,
        observations: [],
      };
    },
  };
  let sawMemoryInDirectChat = false;
  const provider: AIProvider = {
    async chat() {
      return { content: '{"memories":[]}' };
    },
    async *streamChat(input) {
      sawMemoryInDirectChat = input.messages.some((message) =>
        /Charmi/.test(message.content),
      );
      yield { content: "Answer." };
    },
  };
  const app = createApp(testConfig, {
    ...createTestOverrides(provider, repository),
    agentOrchestrator,
  });
  context.after(() => app.close());

  const response = await app.inject({
    method: "POST",
    url: "/chat",
    headers: { "content-type": "application/json" },
    payload: { message: "What is the match rate?" },
  });

  assert.equal(response.statusCode, 200);
  assert.equal(sawMemoryInDirectChat, true);
  assert.equal(
    plannerRequest?.contextMessages.some((message) => /Charmi/.test(message.content)),
    false,
  );
  assert.match(plannerRequest?.relevantMemoryContext ?? "", /Charmi/);
});

test("a corrective follow-up is the sole current task and is not duplicated into reference context", async (context) => {
  const repository = new InMemoryRepository();
  const requests: Parameters<AgentOrchestratorPort["run"]>[0][] = [];
  const provider: AIProvider = {
    async chat() {
      return { content: '{"memories":[]}' };
    },
    async *streamChat() {
      throw new Error("Agent responses should bypass direct chat streaming.");
    },
  };
  const app = createApp(testConfig, {
    ...createTestOverrides(provider, repository),
    agentOrchestrator: {
      async run(request) {
        requests.push(request);
        return {
          kind: "response",
          runId: "90000000-0000-4000-8000-000000000011",
          response: requests.length === 1 ? "No match." : "Found it.",
          steps: 2,
          observations: [],
        };
      },
    },
  });
  context.after(() => app.close());

  const first = await app.inject({
    method: "POST",
    url: "/chat",
    headers: { "content-type": "application/json" },
    payload: { message: "Find Expenses 2026" },
  });
  const conversationId = first.headers["x-shiva-conversation-id"];
  assert.equal(typeof conversationId, "string");

  const second = await app.inject({
    method: "POST",
    url: "/chat",
    headers: { "content-type": "application/json" },
    payload: {
      message: "Expense 2026 sorry",
      conversationId,
    },
  });

  assert.equal(second.statusCode, 200);
  assert.equal(requests[1]?.userMessage, "Expense 2026 sorry");
  assert.ok(
    requests[1]?.contextMessages.some(
      (message) => message.role === "user" && message.content === "Find Expenses 2026",
    ),
  );
  assert.ok(
    requests[1]?.contextMessages.some(
      (message) => message.role === "assistant" && message.content === "No match.",
    ),
  );
  assert.equal(
    requests[1]?.contextMessages.some(
      (message) => message.role === "user" && message.content === "Expense 2026 sorry",
    ),
    false,
  );
});
