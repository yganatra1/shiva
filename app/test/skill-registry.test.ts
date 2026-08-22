import assert from "node:assert/strict";
import { test } from "node:test";
import { z } from "zod";

import {
  DuplicatePackError,
  InvalidPackDefinitionError,
  PackRegistry,
} from "../src/skills/pack-registry.js";
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
  pack: "test_pack",
  inputSchema: z.object({ value: z.string().min(1) }).strict(),
  execution: {
    mutability: "read",
    impact: "normal",
    confirmationReason: "Echoing this value is sensitive in this fixture.",
  },
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
      pack: "test_pack",
      configured: true,
      execution: {
        mutability: "read",
        impact: "normal",
        confirmationReason: "Echoing this value is sensitive in this fixture.",
      },
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
        name: "invalid_mutability",
        execution: { mutability: "execute", impact: "normal" } as never,
      }),
    InvalidSkillDefinitionError,
  );
  assert.throws(
    () =>
      registry.register({
        ...exampleSkill,
        name: "invalid_impact",
        execution: { mutability: "read", impact: "catastrophic" } as never,
      }),
    InvalidSkillDefinitionError,
  );
  assert.throws(
    () =>
      registry.register({
        ...exampleSkill,
        name: "empty_confirmation_reason",
        execution: {
          mutability: "write",
          impact: "sensitive",
          confirmationReason: "   ",
        },
      }),
    InvalidSkillDefinitionError,
  );
  assert.throws(
    () =>
      registry.register({
        ...exampleSkill,
        name: "invalid_control",
        execution: {
          mutability: "write",
          impact: "normal",
          control: "credentials",
        } as never,
      }),
    InvalidSkillDefinitionError,
  );
  assert.throws(
    () =>
      registry.register({
        ...exampleSkill,
        name: "invalid_pack_name",
        pack: "Not A Pack",
      }),
    InvalidSkillDefinitionError,
  );
});

test("skill registry enforces pack existence only when a PackRegistry is supplied", () => {
  const withoutPacks = new SkillRegistry();
  withoutPacks.register({ ...exampleSkill, pack: "anything_snake_case" });
  assert.equal(withoutPacks.hasPack("anything_snake_case"), false);

  const packs = new PackRegistry();
  packs.register({ name: "test_pack", description: "A pack used in tests." });
  const withPacks = new SkillRegistry(packs);
  withPacks.register(exampleSkill);
  assert.equal(withPacks.hasPack("test_pack"), true);

  assert.throws(
    () =>
      withPacks.register({
        ...exampleSkill,
        name: "unknown_pack_skill",
        pack: "nonexistent_pack",
      }),
    InvalidSkillDefinitionError,
  );
});

test("skill registry groups skills into a pack-level catalog", () => {
  const packs = new PackRegistry();
  packs.register({ name: "test_pack", description: "A pack used in tests." });
  packs.register({ name: "empty_pack", description: "Has no skills yet." });
  const registry = new SkillRegistry(packs);
  registry.register(exampleSkill);
  registry.register({
    ...exampleSkill,
    name: "echo_value_two",
    configured: false,
  });

  assert.deepEqual(registry.listPacks(), [
    {
      name: "test_pack",
      description: "A pack used in tests.",
      skillCount: 2,
      configured: true,
    },
  ]);
});

test("PackRegistry rejects duplicate and malformed pack names", () => {
  const packs = new PackRegistry();
  packs.register({ name: "test_pack", description: "A pack used in tests." });

  assert.equal(packs.has("test_pack"), true);
  assert.equal(packs.has("missing_pack"), false);
  assert.throws(
    () => packs.register({ name: "test_pack", description: "Duplicate." }),
    DuplicatePackError,
  );
  assert.throws(
    () => packs.register({ name: "Not Snake Case", description: "Bad name." }),
    InvalidPackDefinitionError,
  );
  assert.throws(
    () => packs.register({ name: "empty_description", description: "  " }),
    InvalidPackDefinitionError,
  );
});
