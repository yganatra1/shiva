import assert from "node:assert/strict";
import { test } from "node:test";

import { AgentDelegationError } from "../src/agents/agent-client.js";
import { AgentRegistry } from "../src/agents/agent-registry.js";
import { createDelegateToAgentSkill } from "../src/skills/delegate-to-agent/skill.js";
import type { SkillContext } from "../src/skills/types.js";

const context: SkillContext = {
  agentRunId: "10000000-0000-4000-8000-000000000001",
  conversationId: "20000000-0000-4000-8000-000000000002",
  userId: "30000000-0000-4000-8000-000000000003",
  userName: "Yash",
  timeZone: "Asia/Kolkata",
  now: () => new Date("2026-08-22T00:00:00Z"),
};

class FakeAgentClient {
  readonly calls: { agent: string; goal: string }[] = [];
  next: { success: boolean; summary: string; steps?: number } | Error = {
    success: true,
    summary: "done",
  };

  async delegate(agent: string, goal: string) {
    this.calls.push({ agent, goal });
    if (this.next instanceof Error) throw this.next;
    return this.next;
  }
}

function registryWithDevice(): AgentRegistry {
  const registry = new AgentRegistry();
  registry.register({
    name: "device",
    description: "Controls the connected Android phone.",
    baseUrl: "http://127.0.0.1:3002",
  });
  return registry;
}

test("delegates to the named agent and returns its summary on success", async () => {
  const client = new FakeAgentClient();
  client.next = { success: true, summary: "Opened Zepto and added tomatoes.", steps: 4 };
  const skill = createDelegateToAgentSkill(client, registryWithDevice());

  const result = await skill.execute({ agent: "device", goal: "order tomato from zepto" }, context);

  assert.deepEqual(result, {
    success: true,
    data: { summary: "Opened Zepto and added tomatoes.", steps: 4 },
  });
  assert.deepEqual(client.calls, [{ agent: "device", goal: "order tomato from zepto" }]);
});

test("the main-agent contract routes every phone task through sensitive delegation", () => {
  const skill = createDelegateToAgentSkill(
    new FakeAgentClient(),
    registryWithDevice(),
  );

  assert.match(skill.description, /every Android-phone task/i);
  assert.match(skill.description, /single-step contact searches/i);
  assert.deepEqual(skill.execution, {
    mutability: "write",
    impact: "sensitive",
    confirmationReason:
      "This delegates a goal to an autonomous agent that can take real actions (placing calls, sending messages, opening apps, etc.) without further confirmation on each individual step.",
  });
});

test("a business-level agent failure (success=false) maps to a skill failure, not a thrown error", async () => {
  const client = new FakeAgentClient();
  client.next = { success: false, summary: "Zepto did not have tomatoes in stock." };
  const skill = createDelegateToAgentSkill(client, registryWithDevice());

  const result = await skill.execute({ agent: "device", goal: "order tomato from zepto" }, context);

  assert.equal(result.success, false);
  if (!result.success) {
    assert.equal(result.error.code, "AGENT_GOAL_FAILED");
    assert.equal(result.error.message, "Zepto did not have tomatoes in stock.");
  }
});

test("an unreachable agent process maps to a skill failure", async () => {
  const client = new FakeAgentClient();
  client.next = new AgentDelegationError("AGENT_UNREACHABLE", "The 'device' agent could not be reached.");
  const skill = createDelegateToAgentSkill(client, registryWithDevice());

  const result = await skill.execute({ agent: "device", goal: "anything" }, context);

  assert.equal(result.success, false);
  if (!result.success) assert.equal(result.error.code, "AGENT_UNREACHABLE");
});

test("the input schema only accepts registered agent names", () => {
  const skill = createDelegateToAgentSkill(new FakeAgentClient(), registryWithDevice());
  assert.equal(skill.inputSchema.safeParse({ agent: "device", goal: "x" }).success, true);
  assert.equal(skill.inputSchema.safeParse({ agent: "nonexistent", goal: "x" }).success, false);
});

test("configured is false and the skill fails closed when no agents are registered", async () => {
  const skill = createDelegateToAgentSkill(new FakeAgentClient(), new AgentRegistry());
  assert.equal(skill.configured, false);
  const result = await skill.execute({ agent: "device", goal: "anything" }, context);
  assert.equal(result.success, false);
  if (!result.success) assert.equal(result.error.code, "AGENT_UNAVAILABLE");
});
