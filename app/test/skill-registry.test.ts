import assert from "node:assert/strict";
import { test } from "node:test";
import { z } from "zod";

import {
  DuplicateSkillError,
  InvalidSkillDefinitionError,
  SkillRegistry,
  UnknownSkillError,
} from "../src/skills/registry.js";
import type { ShivaSkill } from "../src/skills/types.js";

const exampleSkill: ShivaSkill<{ value: string }, { echoed: string }> = {
  name: "echo_value",
  description: "Echoes a validated value.",
  inputDescription: '{ "value": "non-empty string" }',
  inputSchema: z.object({ value: z.string().min(1) }).strict(),
  permissions: ["example.read"],
  async execute(input) {
    return { success: true, data: { echoed: input.value } };
  },
};

test("skill registry stores type-erased skills and exposes safe summaries", async () => {
  const registry = new SkillRegistry();
  registry.register(exampleSkill);

  assert.equal(registry.has("echo_value"), true);
  assert.deepEqual(registry.list(), [
    {
      name: "echo_value",
      description: "Echoes a validated value.",
      inputDescription: '{ "value": "non-empty string" }',
      permissions: ["example.read"],
    },
  ]);

  const registered = registry.get("echo_value");
  const parsed = registered.inputSchema.parse({ value: "hello" });
  const result = await registered.execute(parsed, {
    agentRunId: "10000000-0000-4000-8000-000000000001",
    conversationId: "20000000-0000-4000-8000-000000000002",
    userId: "30000000-0000-4000-8000-000000000003",
    userName: "Yash",
    timeZone: "Asia/Kolkata",
    now: () => new Date("2026-08-20T00:00:00Z"),
  });
  assert.deepEqual(result, { success: true, data: { echoed: "hello" } });
});

test("skill registry rejects duplicate, malformed, and unknown skill names", () => {
  const registry = new SkillRegistry();
  registry.register(exampleSkill);

  assert.throws(() => registry.register(exampleSkill), DuplicateSkillError);
  assert.throws(() => registry.get("missing_skill"), UnknownSkillError);
  assert.throws(
    () =>
      registry.register({
        ...exampleSkill,
        name: "Invalid Skill",
      }),
    InvalidSkillDefinitionError,
  );
  assert.throws(
    () =>
      registry.register({
        ...exampleSkill,
        name: "duplicate_permissions",
        permissions: ["example.read", "example.read"],
      }),
    InvalidSkillDefinitionError,
  );
  assert.throws(
    () =>
      registry.register({
        ...exampleSkill,
        name: "missing_permission",
        permissions: [],
      }),
    InvalidSkillDefinitionError,
  );
});
