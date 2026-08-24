import assert from "node:assert/strict";
import { test } from "node:test";

import {
  AgentProtocolError,
  agentHeartbeatKey,
  agentResponsePublicationKey,
  agentTaskPublicationKey,
  decodeAgentResponse,
  decodeAgentTask,
  encodeAgentResponse,
  encodeAgentTask,
  taskConsumerGroup,
  type AgentResponse,
  type AgentTask,
} from "../../../src/agents/shared/protocol.js";

const task: AgentTask = {
  id: "task-123",
  conversationId: "conversation-456",
  agentId: "device-agent",
  instruction: "Call Mom at +91XXXXXXXXXX. Report whether the call was answered.",
  createdAt: "2026-08-24T10:00:00.000Z",
};

test("task envelopes contain only routing/correlation fields and natural-language instruction", () => {
  const fields = encodeAgentTask(task);

  assert.deepEqual(fields, task);
  assert.deepEqual(decodeAgentTask(fields), task);
  assert.equal("context" in fields, false);
  assert.equal("steps" in fields, false);
  assert.equal("status" in fields, false);
});

test("agent responses round-trip a plain message without a semantic response enum", () => {
  const response: AgentResponse = {
    taskId: task.id,
    agentId: task.agentId,
    message: "Mom did not answer the call.",
    metadata: { callId: "call-789" },
    timestamp: "2026-08-24T10:01:00.000Z",
  };

  const fields = encodeAgentResponse(response);

  assert.deepEqual(decodeAgentResponse(fields), response);
  assert.equal("status" in fields, false);
  assert.equal("eventType" in fields, false);
  assert.equal(fields.metadata, '{"callId":"call-789"}');
});

test("malformed timestamps and metadata fail closed without echoing payload values", () => {
  assert.throws(
    () => encodeAgentTask({ ...task, createdAt: "sometime tomorrow" }),
    (error: unknown) =>
      error instanceof AgentProtocolError &&
      error.message === "Invalid agent task transport envelope.",
  );
  assert.throws(
    () =>
      decodeAgentResponse({
        taskId: "task-123",
        agentId: "device-agent",
        message: "Done.",
        metadata: "not-json-secret-content",
        timestamp: "2026-08-24T10:01:00.000Z",
      }),
    (error: unknown) =>
      error instanceof AgentProtocolError &&
      !error.message.includes("secret-content"),
  );
});

test("agent groups and heartbeat keys are deterministic per agent", () => {
  assert.equal(taskConsumerGroup("device-agent"), "shiva-agent:device-agent");
  assert.equal(
    agentHeartbeatKey("device-agent"),
    "shiva:agent:heartbeat:device-agent",
  );
  assert.notEqual(
    taskConsumerGroup("device-agent"),
    taskConsumerGroup("google-agent"),
  );
  assert.equal(
    agentTaskPublicationKey("task/123"),
    "shiva:agent:published:task:task%2F123",
  );
  assert.equal(
    agentResponsePublicationKey("task/123"),
    "shiva:agent:published:response:task%2F123",
  );
});
