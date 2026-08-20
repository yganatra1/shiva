import assert from "node:assert/strict";
import { test } from "node:test";
import { z } from "zod";

import { PermissionPolicyEngine } from "../src/security/policy-engine.js";
import { SkillExecutor } from "../src/skills/executor.js";
import { SkillRegistry } from "../src/skills/registry.js";
import type { ShivaSkill, SkillContext } from "../src/skills/types.js";

const context: SkillContext = {
  agentRunId: "10000000-0000-4000-8000-000000000001",
  conversationId: "20000000-0000-4000-8000-000000000002",
  userId: "30000000-0000-4000-8000-000000000003",
  userName: "Yash",
  timeZone: "Asia/Kolkata",
  now: () => new Date("2026-08-20T00:00:00Z"),
};

test("permission policy allows only declared automatic permissions", () => {
  const policy = new PermissionPolicyEngine({ "expenses.write": "confirm" });

  assert.deepEqual(policy.evaluate("web.read"), {
    allowed: true,
    permission: "web.read",
    reason: "auto",
  });
  assert.deepEqual(policy.evaluate("expenses.write"), {
    allowed: false,
    permission: "expenses.write",
    reason: "confirmation_required",
  });
  assert.deepEqual(policy.evaluate("system.execute"), {
    allowed: false,
    permission: "system.execute",
    reason: "unknown",
  });
});

test("skill executor denies permission before validation or execution", async () => {
  let executionCount = 0;
  const skill: ShivaSkill<{ amount: number }, { stored: true }> = {
    name: "write_example",
    description: "Writes an example record.",
    inputDescription: '{ "amount": "positive number" }',
    inputSchema: z.object({ amount: z.number().positive() }).strict(),
    permissions: ["expenses.write"],
    async execute() {
      executionCount += 1;
      return { success: true, data: { stored: true } };
    },
  };
  const registry = new SkillRegistry();
  registry.register(skill);
  const executor = new SkillExecutor(
    registry,
    new PermissionPolicyEngine({ "expenses.write": "confirm" }),
  );

  const result = await executor.execute(
    "write_example",
    { amount: "not a number" },
    context,
  );

  assert.deepEqual(result, {
    success: false,
    error: {
      code: "CONFIRMATION_REQUIRED",
      message: "This action requires confirmation, which is not available yet.",
    },
  });
  assert.equal(executionCount, 0);
});

test("skill executor validates input and sanitizes thrown failures", async () => {
  const registry = new SkillRegistry();
  registry.register({
    name: "read_example",
    description: "Reads an example record.",
    inputDescription: '{ "query": "non-empty string" }',
    inputSchema: z.object({ query: z.string().min(1) }).strict(),
    permissions: ["expenses.read"],
    async execute() {
      throw new Error("private database address");
    },
  });
  const executor = new SkillExecutor(registry, new PermissionPolicyEngine());

  assert.equal(
    (await executor.execute("read_example", { query: "" }, context)).success,
    false,
  );
  assert.deepEqual(
    await executor.execute("read_example", { query: "today" }, context),
    {
      success: false,
      error: {
        code: "SKILL_EXECUTION_FAILED",
        message: "The skill could not complete its operation.",
      },
    },
  );
  assert.equal(
    (await executor.execute("missing", {}, context)).success,
    false,
  );
});

test("skill executor refuses a registered skill outside the request scope", async () => {
  let executions = 0;
  const registry = new SkillRegistry();
  registry.register({
    name: "write_example",
    description: "Writes an example record.",
    inputDescription: '{ "amount": number }',
    inputSchema: z.object({ amount: z.number().positive() }).strict(),
    permissions: ["expenses.write"],
    async execute() {
      executions += 1;
      return { success: true, data: { stored: true } };
    },
  });
  const executor = new SkillExecutor(registry, new PermissionPolicyEngine());

  const result = await executor.execute(
    "write_example",
    { amount: 10 },
    { ...context, allowedSkills: ["read_example"] },
  );

  assert.deepEqual(result, {
    success: false,
    error: {
      code: "SKILL_NOT_AUTHORIZED_FOR_REQUEST",
      message: "The skill is outside the capabilities authorized by this request.",
    },
  });
  assert.equal(executions, 0);
});
