import assert from "node:assert/strict";
import { test } from "node:test";

import type {
  AgentOrchestratorPort,
  AgentRequest,
} from "../../../src/agent/types.js";
import { createFinanceManagerAgentTaskHandler } from "../../../src/agents/finance-manager/finance-manager-agent-task-handler.js";
import type { AgentTask } from "../../../src/agents/shared/protocol.js";

const task: AgentTask = {
  id: "task-finance-1",
  conversationId: "conversation-1",
  agentId: "finance-manager-agent",
  instruction: "Analyze Axis ELSS Direct Growth and report 5Y CAGR.",
  createdAt: "2026-09-03T12:00:00.000Z",
};

test("Finance Manager handler passes only Core's instruction and returns plain text", async () => {
  let received: AgentRequest | undefined;
  const loop: AgentOrchestratorPort = {
    async run(request) {
      received = request;
      return {
        kind: "response",
        runId: "run-1",
        response:
          "Axis ELSS Direct Growth has a NAV-derived 5Y CAGR of 12.4% in the tool snapshot.",
        steps: 2,
        observations: [],
      };
    },
  };
  const handler = createFinanceManagerAgentTaskHandler({
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
  assert.match(String(result), /12\.4%/);
  assert.equal(received?.userMessage, task.instruction);
  assert.deepEqual(received?.contextMessages, []);
});
