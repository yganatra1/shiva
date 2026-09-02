import assert from "node:assert/strict";
import { test } from "node:test";

import type {
  AgentOrchestratorPort,
  AgentRequest,
} from "../../../src/agent/types.js";
import { createGoogleAgentTaskHandler } from "../../../src/agents/google/google-agent-task-handler.js";
import type { AgentTask } from "../../../src/agents/shared/protocol.js";

const task: AgentTask = {
  id: "task-google-1",
  conversationId: "conversation-1",
  agentId: "google-agent",
  instruction: "Add ₹500 to the expense sheet and report the result.",
  createdAt: "2026-08-24T12:00:00.000Z",
};

test("Google task handler passes only Core's minimal instruction and returns plain text", async () => {
  let received: AgentRequest | undefined;
  const loop: AgentOrchestratorPort = {
    async run(request) {
      received = request;
      return {
        kind: "response",
        runId: "run-1",
        response: "₹500 has been added to the expense sheet successfully.",
        steps: 2,
        observations: [],
      };
    },
  };
  const handler = createGoogleAgentTaskHandler({
    loop,
    userId: "primary-user",
    userName: "Himaxi",
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
    "₹500 has been added to the expense sheet successfully.",
  );
  assert.equal(received?.userMessage, task.instruction);
  assert.equal(received?.conversationId, task.conversationId);
  assert.deepEqual(received?.contextMessages, []);
  assert.equal(received?.allowedSkills, undefined);
  assert.equal(received?.signal, signal);
  assert.equal(received?.delegationContinuation, undefined);
  assert.equal(received?.sourceMessageId, undefined);
});

test("Google task handler reports a grounded no-change message if its loop cannot act", async () => {
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
  const handler = createGoogleAgentTaskHandler({
    loop,
    userId: "primary-user",
    userName: "Himaxi",
    timeZone: "Asia/Kolkata",
  });

  assert.equal(
    await handler(task, {
      attempt: 1,
      recovered: false,
      signal: new AbortController().signal,
    }),
    "Google Agent could not select a configured Google operation for this task, so it made no change.",
  );
});
