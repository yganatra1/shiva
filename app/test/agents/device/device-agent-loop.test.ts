import assert from "node:assert/strict";
import { test } from "node:test";

import { DeviceDispatchError } from "../../../src/agents/device/device-command-dispatcher.js";
import { runDeviceAgentGoal } from "../../../src/agents/device/device-agent-loop.js";
import { DeviceAgentPlannerError } from "../../../src/agents/device/device-agent-planner.js";
import type {
  DeviceAgentDecision,
  DeviceAgentPlanner,
  DeviceAgentPlanningContext,
  DeviceCommandResult,
} from "../../../src/agents/device/device-agent-types.js";

class ScriptedPlanner implements DeviceAgentPlanner {
  readonly contexts: DeviceAgentPlanningContext[] = [];
  private index = 0;

  constructor(
    private readonly next: (
      context: DeviceAgentPlanningContext,
    ) => DeviceAgentDecision | Error,
  ) {}

  async decide(context: DeviceAgentPlanningContext): Promise<DeviceAgentDecision> {
    this.contexts.push(context);
    this.index += 1;
    const decision = this.next(context);
    if (decision instanceof Error) throw decision;
    return decision;
  }
}

class FakeDispatcher {
  readonly calls: { type: string; arguments: Record<string, string> }[] = [];

  constructor(
    private readonly respond: (
      type: string,
      args: Record<string, string>,
    ) => DeviceCommandResult | Error,
  ) {}

  async dispatch(
    type: string,
    args: Readonly<Record<string, string>>,
  ): Promise<DeviceCommandResult> {
    this.calls.push({ type, arguments: { ...args } });
    const outcome = this.respond(type, args as Record<string, string>);
    if (outcome instanceof Error) throw outcome;
    return outcome;
  }
}

test("drives call_tool decisions against the dispatcher and stops on done", async () => {
  const planner = new ScriptedPlanner((context) =>
    context.stepNumber === 1
      ? { type: "call_tool", tool: "device.app.open", arguments: { name: "Zepto" } }
      : { type: "done", success: true, summary: "Opened Zepto." },
  );
  const dispatcher = new FakeDispatcher(() => ({
    commandId: "cmd-1",
    status: "COMPLETED",
    result: { opened: "true" },
  }));

  const result = await runDeviceAgentGoal("open zepto", dispatcher, planner);

  assert.deepEqual(result, { success: true, summary: "Opened Zepto.", steps: 1 });
  assert.deepEqual(dispatcher.calls, [
    { type: "device.app.open", arguments: { name: "Zepto" } },
  ]);
  assert.equal(planner.contexts[1]?.steps[0]?.result.status, "COMPLETED");
});

test("reports failure and stops after reaching the step limit", async () => {
  const planner = new ScriptedPlanner(() => ({
    type: "call_tool",
    tool: "device.app.open",
    arguments: {},
  }));
  const dispatcher = new FakeDispatcher(() => ({ commandId: "x", status: "FAILED" }));

  const result = await runDeviceAgentGoal("click forever", dispatcher, planner, { maxSteps: 3 });

  assert.equal(result.success, false);
  assert.equal(result.steps, 3);
  assert.match(result.summary, /3-step limit/);
  assert.equal(dispatcher.calls.length, 3);
});

test("an unknown tool name is fed back as a correction instead of dispatched", async () => {
  let sawCorrection = false;
  const planner = new ScriptedPlanner((context) => {
    if (context.correctionRequired) {
      sawCorrection = true;
      return { type: "done", success: false, summary: "gave up" };
    }
    return { type: "call_tool", tool: "device.not.real", arguments: {} };
  });
  const dispatcher = new FakeDispatcher(() => {
    throw new Error("must not be called for an unknown tool");
  });

  const result = await runDeviceAgentGoal("do something", dispatcher, planner, { maxSteps: 5 });

  assert.equal(sawCorrection, true);
  assert.equal(result.success, false);
  assert.equal(dispatcher.calls.length, 0);
});

test("a dispatch-level failure becomes a synthetic failed step, not a thrown error", async () => {
  const planner = new ScriptedPlanner((context) =>
    context.steps.length === 0
      ? { type: "call_tool", tool: "device.app.open", arguments: {} }
      : { type: "done", success: false, summary: context.steps[0]?.result.error ?? "unknown" },
  );
  const dispatcher = new FakeDispatcher(() => new DeviceDispatchError("DEVICE_TIMEOUT", "The device did not respond in time."));

  const result = await runDeviceAgentGoal("tap something", dispatcher, planner);

  assert.equal(result.success, false);
  assert.equal(result.summary, "The device did not respond in time.");
  assert.equal(planner.contexts[1]?.steps[0]?.result.status, "FAILED");
});

test("a planner failure ends the goal instead of looping forever", async () => {
  const planner = new ScriptedPlanner(() => new DeviceAgentPlannerError("bad output"));
  const dispatcher = new FakeDispatcher(() => {
    throw new Error("must not be called");
  });

  const result = await runDeviceAgentGoal("anything", dispatcher, planner);

  assert.equal(result.success, false);
  assert.equal(result.steps, 0);
  assert.match(result.summary, /could not produce a valid plan/);
});

test("an AbortSignal stops the loop before the next planner call", async () => {
  const controller = new AbortController();
  const planner = new ScriptedPlanner((context) => {
    assert.equal(context.signal, controller.signal);
    controller.abort();
    return { type: "call_tool", tool: "device.app.open", arguments: {} };
  });
  const dispatcher = new FakeDispatcher(() => ({ commandId: "x", status: "COMPLETED" }));

  await assert.rejects(() =>
    runDeviceAgentGoal("anything", dispatcher, planner, { signal: controller.signal }),
  );
});

test("a caller cancellation during dispatch is propagated instead of becoming a tool result", async () => {
  const controller = new AbortController();
  const planner = new ScriptedPlanner(() => ({
    type: "call_tool",
    tool: "device.app.open",
    arguments: {},
  }));
  const dispatcher = new FakeDispatcher(() => {
    controller.abort();
    return new DeviceDispatchError("CANCELLED", "cancelled");
  });

  await assert.rejects(() =>
    runDeviceAgentGoal("anything", dispatcher, planner, {
      signal: controller.signal,
    }),
  );
  assert.equal(planner.contexts.length, 1);
});
