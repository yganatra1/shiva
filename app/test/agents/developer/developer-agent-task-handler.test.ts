import assert from "node:assert/strict";
import { test } from "node:test";

import type {
  AgentOrchestratorPort,
  AgentRequest,
} from "../../../src/agent/types.js";
import { createDeveloperAgentTaskHandler } from "../../../src/agents/developer/developer-agent-task-handler.js";
import type { AgentTask } from "../../../src/agents/shared/protocol.js";

const task: AgentTask = {
  id: "task-developer-1",
  conversationId: "conversation-1",
  agentId: "developer-agent",
  instruction: "In the shiva repo, explain the agent architecture.",
  createdAt: "2026-09-02T12:00:00.000Z",
};

test("Developer task handler passes only Core's minimal instruction and returns plain text", async () => {
  let received: AgentRequest | undefined;
  const loop: AgentOrchestratorPort = {
    async run(request) {
      received = request;
      return {
        kind: "response",
        runId: "run-1",
        response: "The agent architecture uses a Redis-backed task queue.",
        steps: 2,
        observations: [],
      };
    },
  };
  const handler = createDeveloperAgentTaskHandler({
    loop,
    userId: "primary-user",
    userName: "Yash",
    timeZone: "Asia/Kolkata",
  });
  const signal = new AbortController().signal;

  const result = await handler(task, {
    attempt: 1,
    recovered: false,
    signal,
  });

  assert.equal(
    result,
    "The agent architecture uses a Redis-backed task queue.",
  );
  assert.equal(received?.userMessage, task.instruction);
  assert.equal(received?.conversationId, task.conversationId);
  assert.deepEqual(received?.contextMessages, []);
  assert.equal(received?.allowedSkills, undefined);
  assert.equal(received?.signal, signal);
  assert.equal(received?.delegationContinuation, undefined);
  assert.equal(received?.sourceMessageId, undefined);
});

test("Developer task handler reports a grounded no-change message if its loop cannot act", async () => {
  const loop: AgentOrchestratorPort = {
    async run() {
      return {
        kind: "direct_chat",
        runId: "run-2",
        response: undefined,
        steps: 1,
        observations: [],
        plannerFallback: "INVALID_SCOPE",
      };
    },
  };
  const handler = createDeveloperAgentTaskHandler({
    loop,
    userId: "primary-user",
    userName: "Yash",
    timeZone: "Asia/Kolkata",
  });

  assert.equal(
    await handler(task, {
      attempt: 1,
      recovered: false,
      signal: new AbortController().signal,
    }),
    "Developer Agent could not select a configured repository for this task, so it made no change.",
  );
});
