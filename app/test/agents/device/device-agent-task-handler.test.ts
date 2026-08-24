import assert from "node:assert/strict";
import { test } from "node:test";

import { createDeviceAgentTaskHandler } from "../../../src/agents/device/device-agent-task-handler.js";
import type { DeviceAgentPlanner } from "../../../src/agents/device/device-agent-types.js";
import { DeviceCommandDispatcher } from "../../../src/agents/device/device-command-dispatcher.js";
import type { AgentTask } from "../../../src/agents/shared/protocol.js";

const task: AgentTask = {
  id: "task-1",
  conversationId: "conversation-1",
  agentId: "device-agent",
  instruction: "Call Mom at +919876543210. Report whether the call was answered.",
  createdAt: "2026-08-24T12:00:00.000Z",
};

const unusedPlanner: DeviceAgentPlanner = {
  async decide() {
    throw new Error("The real device planner must not run in mock mode.");
  },
};

test("explicit call mock returns a plain outcome without requiring a phone", async () => {
  const handler = createDeviceAgentTaskHandler({
    dispatcher: new DeviceCommandDispatcher(),
    planner: unusedPlanner,
    maxSteps: 15,
    mockCallOutcome: "not_answered",
  });

  assert.deepEqual(
    await handler(task, {
      attempt: 1,
      recovered: false,
      signal: new AbortController().signal,
    }),
    {
      message: "Mom did not answer the call.",
      metadata: {
        mock: true,
        simulatedCapability: "phone_call",
      },
    },
  );
});

test("production default never fabricates an outcome without a phone", async () => {
  const handler = createDeviceAgentTaskHandler({
    dispatcher: new DeviceCommandDispatcher(),
    planner: unusedPlanner,
    maxSteps: 15,
  });

  assert.equal(
    await handler(task, {
      attempt: 1,
      recovered: false,
      signal: new AbortController().signal,
    }),
    "Device Agent could not attempt the task because no phone is connected.",
  );
});

test("call mock refuses to simulate unrelated device tasks", async () => {
  const handler = createDeviceAgentTaskHandler({
    dispatcher: new DeviceCommandDispatcher(),
    planner: unusedPlanner,
    maxSteps: 15,
    mockCallOutcome: "not_answered",
  });

  const result = await handler(
    { ...task, instruction: "Open the camera." },
    {
      attempt: 1,
      recovered: false,
      signal: new AbortController().signal,
    },
  );
  assert.equal(
    typeof result === "string" ? result : result.message,
    "Device Agent mock mode supports only delegated phone-call instructions, so it made no change.",
  );
});
