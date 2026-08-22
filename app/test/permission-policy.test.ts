import assert from "node:assert/strict";
import { test } from "node:test";
import { z } from "zod";

import {
  NOOP_AGENT_AUDIT,
  type AgentAuditPort,
  type FinishAgentRunInput,
  type FinishSkillRunInput,
  type StartAgentRunInput,
  type StartSkillRunInput,
} from "../src/agent/audit.js";
import {
  ConfirmationService,
  InMemoryConfirmationStore,
} from "../src/security/confirmation.js";
import {
  compareExecutionModes,
  effectiveExecutionMode,
  minExecutionMode,
  type ExecutionMode,
} from "../src/security/execution-mode.js";
import { ExecutionPolicyEngine } from "../src/security/policy-engine.js";
import {
  ExecutionStateService,
  InMemoryExecutionStateStore,
} from "../src/security/execution-state.js";
import {
  SetExecutionModeSkill,
  SetLockdownSkill,
} from "../src/skills/execution-control/skills.js";
import { SkillExecutor } from "../src/skills/executor.js";
import { SkillRegistry } from "../src/skills/registry.js";
import type {
  ShivaSkill,
  SkillContext,
  SkillExecutionMetadata,
  SkillResult,
} from "../src/skills/types.js";

const NOW = new Date("2026-08-20T00:00:00.000Z");
const USER_ID = "30000000-0000-4000-8000-000000000003";
const CONVERSATION_ID = "20000000-0000-4000-8000-000000000002";

test("execution modes have an explicit ordering and the configured ceiling clamps effective mode", () => {
  assert.ok(compareExecutionModes("SAFE", "AUTO") < 0);
  assert.ok(compareExecutionModes("AUTO", "FULL_ACCESS") < 0);
  assert.ok(compareExecutionModes("FULL_ACCESS", "SAFE") > 0);
  assert.equal(compareExecutionModes("AUTO", "AUTO"), 0);
  assert.equal(minExecutionMode("FULL_ACCESS", "AUTO"), "AUTO");
  assert.equal(
    effectiveExecutionMode("FULL_ACCESS", "AUTO", false),
    "AUTO",
  );
  assert.equal(
    effectiveExecutionMode("FULL_ACCESS", "FULL_ACCESS", true),
    "SAFE",
  );
});

test("FULL_ACCESS executes normal reads and authorized ordinary writes", async () => {
  const registry = new SkillRegistry();
  const executed: string[] = [];
  registerValueSkill(
    registry,
    "read_example",
    { mutability: "read", impact: "normal" },
    (value) => executed.push(`read:${value}`),
  );
  registerValueSkill(
    registry,
    "write_example",
    { mutability: "write", impact: "normal" },
    (value) => executed.push(`write:${value}`),
  );
  const { executor } = createHarness(registry, { mode: "FULL_ACCESS" });

  const read = await executor.execute(
    "read_example",
    { value: "status" },
    context(),
  );
  const write = await executor.execute(
    "write_example",
    { value: "saved" },
    context(),
    { userAuthorized: true },
  );

  assert.equal(read.success, true);
  assert.equal(write.success, true);
  assert.deepEqual(executed, ["read:status", "write:saved"]);
});

test("FULL_ACCESS still requires confirmation for a sensitive action", async () => {
  const registry = new SkillRegistry();
  let executions = 0;
  registerValueSkill(
    registry,
    "destroy_example",
    {
      mutability: "write",
      impact: "sensitive",
      confirmationReason: "This permanently destroys the example.",
    },
    () => {
      executions += 1;
    },
  );
  const { executor } = createHarness(registry, { mode: "FULL_ACCESS" });

  const result = await executor.execute(
    "destroy_example",
    { value: "all" },
    context(),
    { userAuthorized: true },
  );

  assert.equal(result.success, false);
  if (result.success) return;
  assert.equal(result.error.code, "CONFIRMATION_REQUIRED");
  assert.match(result.error.message, /permanently destroys/i);
  assert.match(result.error.confirmation?.id ?? "", /^[0-9a-f-]{36}$/);
  assert.equal(executions, 0);
  assert.deepEqual(
    await executor.getPendingConfirmation(USER_ID, CONVERSATION_ID, NOW),
    {
      id: result.error.confirmation?.id,
      skill: "destroy_example",
      sanitizedArguments: { value: "all" },
      reason: "This permanently destroys the example.",
      expiresAt: "2026-08-20T00:05:00.000Z",
      mutability: "write",
      impact: "sensitive",
    },
  );
});

test("AUTO executes an explicitly authorized ordinary write and confirms an unrequested one", async () => {
  const registry = new SkillRegistry();
  const executed: string[] = [];
  registerValueSkill(
    registry,
    "write_example",
    { mutability: "write", impact: "normal" },
    (value) => executed.push(value),
  );
  const { executor } = createHarness(registry, { mode: "AUTO" });

  const authorized = await executor.execute(
    "write_example",
    { value: "requested" },
    context(),
    { userAuthorized: true },
  );
  const unrequested = await executor.execute(
    "write_example",
    { value: "inferred" },
    context(),
    { userAuthorized: false },
  );

  assert.equal(authorized.success, true);
  assert.equal(unrequested.success, false);
  if (!unrequested.success) {
    assert.equal(unrequested.error.code, "CONFIRMATION_REQUIRED");
    assert.match(unrequested.error.message, /not clearly authorized/i);
  }
  assert.deepEqual(executed, ["requested"]);
});

test("SAFE requires an exact confirmation before a normal write", async () => {
  const registry = new SkillRegistry();
  let executions = 0;
  registerValueSkill(
    registry,
    "write_example",
    { mutability: "write", impact: "normal" },
    () => {
      executions += 1;
    },
  );
  const { executor } = createHarness(registry, { mode: "SAFE" });

  const result = await executor.execute(
    "write_example",
    { value: "change" },
    context(),
    { userAuthorized: true },
  );

  assert.equal(result.success, false);
  if (!result.success) {
    assert.equal(result.error.code, "CONFIRMATION_REQUIRED");
    assert.match(result.error.message, /Safe mode/i);
  }
  assert.equal(executions, 0);
});

test("lowering execution authority is immediate while raising it requires confirmation", async () => {
  const registry = new SkillRegistry();
  const harness = createHarness(registry, { mode: "FULL_ACCESS" });
  registry.register(new SetExecutionModeSkill(harness.state));

  const lowered = await harness.executor.execute(
    "set_execution_mode",
    { mode: "SAFE" },
    context(),
    { userAuthorized: true },
  );
  assert.equal(lowered.success, true);
  assert.equal((await harness.state.getState()).executionMode, "SAFE");

  const raised = await harness.executor.execute(
    "set_execution_mode",
    { mode: "FULL_ACCESS" },
    context(),
    { userAuthorized: true },
  );
  assert.equal(raised.success, false);
  if (!raised.success) {
    assert.equal(raised.error.code, "CONFIRMATION_REQUIRED");
    assert.match(raised.error.message, /Safe.*Full Access/i);
  }
  assert.equal((await harness.state.getState()).executionMode, "SAFE");
});

test("the configured maximum rejects an unavailable execution mode", async () => {
  const registry = new SkillRegistry();
  const harness = createHarness(registry, {
    mode: "SAFE",
    max: "AUTO",
  });
  registry.register(new SetExecutionModeSkill(harness.state));

  const result = await harness.executor.execute(
    "set_execution_mode",
    { mode: "FULL_ACCESS" },
    context(),
    { userAuthorized: true },
  );

  assert.deepEqual(result, {
    success: false,
    error: {
      code: "EXECUTION_MODE_EXCEEDS_MAX",
      message:
        "Full Access is disabled by the host configuration. Maximum available mode is Auto.",
    },
  });
  assert.equal((await harness.state.getState()).executionMode, "SAFE");
  assert.equal(
    await harness.executor.getPendingConfirmation(
      USER_ID,
      CONVERSATION_ID,
      NOW,
    ),
    undefined,
  );
});

test("lockdown enters immediately, blocks writes, and requires confirmation to exit", async () => {
  const registry = new SkillRegistry();
  const harness = createHarness(registry, { mode: "AUTO" });
  registry.register(new SetLockdownSkill(harness.state, harness.confirmations));
  let writes = 0;
  registerValueSkill(
    registry,
    "write_example",
    { mutability: "write", impact: "normal" },
    () => {
      writes += 1;
    },
  );

  const entered = await harness.executor.execute(
    "set_lockdown",
    { enabled: true },
    context(),
    { userAuthorized: true },
  );
  assert.equal(entered.success, true);
  assert.equal((await harness.state.getState()).lockdown, true);
  assert.equal((await harness.state.getState()).effectiveExecutionMode, "SAFE");

  const blocked = await harness.executor.execute(
    "write_example",
    { value: "blocked" },
    context(),
    { userAuthorized: true },
  );
  assert.equal(blocked.success, false);
  if (!blocked.success) {
    assert.equal(blocked.error.code, "LOCKDOWN_ACTIVE");
    assert.equal(blocked.error.confirmation, undefined);
  }
  assert.equal(writes, 0);

  const exit = await harness.executor.execute(
    "set_lockdown",
    { enabled: false, executionMode: "AUTO" },
    context(),
    { userAuthorized: true },
  );
  assert.equal(exit.success, false);
  if (!exit.success) {
    assert.equal(exit.error.code, "CONFIRMATION_REQUIRED");
    assert.match(exit.error.message, /Disable lockdown.*Auto/i);
  }
  assert.equal((await harness.state.getState()).lockdown, true);
});

test("approving the exact pending action executes it once", async () => {
  const registry = new SkillRegistry();
  const executed: string[] = [];
  registerValueSkill(
    registry,
    "write_example",
    { mutability: "write", impact: "normal" },
    (value) => executed.push(value),
  );
  const harness = createHarness(registry, { mode: "SAFE" });
  const pending = await harness.executor.execute(
    "write_example",
    { value: "exact" },
    context(),
  );
  const confirmationId = requiredConfirmationId(pending);

  const resolved = await harness.executor.resolveConfirmation({
    id: confirmationId,
    approved: true,
    skill: "write_example",
    arguments: { value: "exact" },
    context: context(),
  });

  assert.equal(resolved.result.success, true);
  assert.deepEqual(executed, ["exact"]);
  assert.equal(
    (await harness.confirmationStore.findById(confirmationId))?.status,
    "EXECUTED",
  );

  const replay = await harness.executor.resolveConfirmation({
    id: confirmationId,
    approved: true,
    skill: "write_example",
    arguments: { value: "exact" },
    context: context(),
  });
  assert.equal(replay.result.success, false);
  if (!replay.result.success) {
    assert.equal(
      replay.result.error.code,
      "CONFIRMATION_ALREADY_RESOLVED",
    );
  }
  assert.deepEqual(executed, ["exact"]);
});

test("an approved action is claimed as EXECUTING and finalized as EXECUTED", async () => {
  const registry = new SkillRegistry();
  let signalStarted!: () => void;
  let releaseExecution!: () => void;
  const started = new Promise<void>((resolve) => {
    signalStarted = resolve;
  });
  const executionGate = new Promise<void>((resolve) => {
    releaseExecution = resolve;
  });
  registry.register({
    name: "gated_write",
    description: "Waits inside a confirmed write for lifecycle inspection.",
    inputDescription: '{ "value": string }',
    inputSchema: z.object({ value: z.string() }).strict(),
    execution: { mutability: "write", impact: "normal" },
    async execute(input) {
      signalStarted();
      await executionGate;
      return { success: true, data: input };
    },
  });
  const harness = createHarness(registry, { mode: "SAFE" });
  const pending = await harness.executor.execute(
    "gated_write",
    { value: "exact" },
    context(),
    { userAuthorized: true },
  );
  const confirmationId = requiredConfirmationId(pending);

  const resolving = harness.executor.resolveConfirmation({
    id: confirmationId,
    approved: true,
    skill: "gated_write",
    arguments: { value: "exact" },
    context: context(),
  });
  await started;
  assert.equal(
    (await harness.confirmationStore.findById(confirmationId))?.status,
    "EXECUTING",
  );

  releaseExecution();
  const resolved = await resolving;
  assert.equal(resolved.result.success, true);
  assert.equal(
    (await harness.confirmationStore.findById(confirmationId))?.status,
    "EXECUTED",
  );
});

test("a confirmed action that fails is finalized as FAILED, not EXECUTED", async () => {
  const registry = new SkillRegistry();
  registry.register({
    name: "failing_write",
    description: "Returns a controlled failure after confirmation.",
    inputDescription: '{ "value": string }',
    inputSchema: z.object({ value: z.string() }).strict(),
    execution: { mutability: "write", impact: "normal" },
    async execute() {
      return {
        success: false,
        error: { code: "FIXTURE_FAILED", message: "The fixture failed." },
      };
    },
  });
  const harness = createHarness(registry, { mode: "SAFE" });
  const pending = await harness.executor.execute(
    "failing_write",
    { value: "exact" },
    context(),
    { userAuthorized: true },
  );
  const confirmationId = requiredConfirmationId(pending);

  const resolved = await harness.executor.resolveConfirmation({
    id: confirmationId,
    approved: true,
    skill: "failing_write",
    arguments: { value: "exact" },
    context: context(),
  });

  assert.equal(resolved.result.success, false);
  assert.equal(
    (await harness.confirmationStore.findById(confirmationId))?.status,
    "FAILED",
  );
});

test("a settings revision change invalidates an approved action before execution", async () => {
  const registry = new SkillRegistry();
  let executions = 0;
  registerValueSkill(
    registry,
    "write_example",
    { mutability: "write", impact: "normal" },
    () => {
      executions += 1;
    },
  );
  const harness = createHarness(registry, { mode: "SAFE" });
  const pending = await harness.executor.execute(
    "write_example",
    { value: "stale" },
    context(),
    { userAuthorized: true },
  );
  const confirmationId = requiredConfirmationId(pending);
  await harness.state.setExecutionMode("SAFE", USER_ID, NOW, 0);

  const resolved = await harness.executor.resolveConfirmation({
    id: confirmationId,
    approved: true,
    skill: "write_example",
    arguments: { value: "stale" },
    context: context(),
  });

  assert.equal(resolved.result.success, false);
  if (!resolved.result.success) {
    assert.equal(resolved.result.error.code, "CONFIRMATION_STALE");
  }
  assert.equal(executions, 0);
  assert.equal(
    (await harness.confirmationStore.findById(confirmationId))?.status,
    "FAILED",
  );
});

test("changed arguments reject a previous confirmation without executing", async () => {
  const registry = new SkillRegistry();
  let executions = 0;
  registerValueSkill(
    registry,
    "write_example",
    { mutability: "write", impact: "normal" },
    () => {
      executions += 1;
    },
  );
  const harness = createHarness(registry, { mode: "SAFE" });
  const pending = await harness.executor.execute(
    "write_example",
    { value: "original" },
    context(),
  );
  const confirmationId = requiredConfirmationId(pending);

  const resolved = await harness.executor.resolveConfirmation({
    id: confirmationId,
    approved: true,
    skill: "write_example",
    arguments: { value: "changed" },
    context: context(),
  });

  assert.equal(resolved.result.success, false);
  if (!resolved.result.success) {
    assert.equal(resolved.result.error.code, "CONFIRMATION_MISMATCH");
  }
  assert.equal(executions, 0);
  assert.equal(
    (await harness.confirmationStore.findById(confirmationId))?.status,
    "DENIED",
  );
});

test("an expired confirmation cannot execute", async () => {
  const registry = new SkillRegistry();
  let executions = 0;
  registerValueSkill(
    registry,
    "write_example",
    { mutability: "write", impact: "normal" },
    () => {
      executions += 1;
    },
  );
  const harness = createHarness(registry, { mode: "SAFE", ttlMs: 1_000 });
  let now = NOW;
  const currentContext = context(() => now);
  const pending = await harness.executor.execute(
    "write_example",
    { value: "expires" },
    currentContext,
  );
  const confirmationId = requiredConfirmationId(pending);
  now = new Date(NOW.getTime() + 1_001);

  const resolved = await harness.executor.resolveConfirmation({
    id: confirmationId,
    approved: true,
    skill: "write_example",
    arguments: { value: "expires" },
    context: currentContext,
  });

  assert.equal(resolved.result.success, false);
  if (!resolved.result.success) {
    assert.equal(resolved.result.error.code, "CONFIRMATION_EXPIRED");
  }
  assert.equal(executions, 0);
  assert.equal(
    (await harness.confirmationStore.findById(confirmationId))?.status,
    "EXPIRED",
  );
});

test("credential-shaped values are absent from skill audit input and result", async () => {
  const audit = new RecordingAudit();
  const registry = new SkillRegistry();
  registry.register({
    name: "credential_fixture",
    description: "Exercises generic audit sanitization.",
    inputDescription: '{ "apiKey": string, "nested": object }',
    inputSchema: z
      .object({
        apiKey: z.string(),
        nested: z
          .object({
            refreshToken: z.string(),
            authorization: z.string(),
            note: z.string(),
          })
          .strict(),
      })
      .strict(),
    execution: { mutability: "read", impact: "normal" },
    async execute() {
      return {
        success: true,
        data: {
          privateKey: "PRIVATE_KEY_SENTINEL",
          diagnostic:
            "password=PASSWORD_SENTINEL key AKIA1234567890ABCDEF",
          safe: "visible result",
        },
      };
    },
  });
  const { executor } = createHarness(registry, {
    mode: "FULL_ACCESS",
    audit,
  });

  const result = await executor.execute(
    "credential_fixture",
    {
      apiKey: "API_KEY_SENTINEL",
      nested: {
        refreshToken: "REFRESH_TOKEN_SENTINEL",
        authorization: "Bearer AUTHORIZATION_SENTINEL",
        note: "safe note",
      },
    },
    context(),
  );

  assert.equal(result.success, true);
  assert.equal(audit.skillStarts[0]?.executionMode, "FULL_ACCESS");
  assert.equal(audit.skillStarts[0]?.mutability, "read");
  assert.deepEqual(audit.skillStarts[0]?.input, {
    apiKey: "[REDACTED]",
    nested: {
      refreshToken: "[REDACTED]",
      authorization: "[REDACTED]",
      note: "safe note",
    },
  });
  const persisted = JSON.stringify({
    input: audit.skillStarts[0]?.input,
    result: audit.skillFinishes[0]?.result,
  });
  for (const secret of [
    "API_KEY_SENTINEL",
    "REFRESH_TOKEN_SENTINEL",
    "AUTHORIZATION_SENTINEL",
    "PRIVATE_KEY_SENTINEL",
    "PASSWORD_SENTINEL",
    "AKIA1234567890ABCDEF",
  ]) {
    assert.equal(persisted.includes(secret), false);
  }
  assert.match(persisted, /safe note/);
  assert.match(persisted, /visible result/);
});

interface HarnessOptions {
  readonly mode?: ExecutionMode;
  readonly max?: ExecutionMode;
  readonly lockdown?: boolean;
  readonly ttlMs?: number;
  readonly audit?: AgentAuditPort;
}

function createHarness(
  registry: SkillRegistry,
  options: HarnessOptions = {},
) {
  const stateStore = new InMemoryExecutionStateStore({
    executionMode: options.mode ?? "AUTO",
    lockdown: options.lockdown ?? false,
    updatedAt: NOW,
    updatedBy: null,
  });
  const state = new ExecutionStateService(
    stateStore,
    options.max ?? "FULL_ACCESS",
  );
  const confirmationStore = new InMemoryConfirmationStore();
  let confirmationSequence = 1;
  const confirmations = new ConfirmationService(
    confirmationStore,
    options.ttlMs ?? 300_000,
    () => fixtureUuid("4", confirmationSequence++),
  );
  let auditSequence = 1;
  let monotonicTime = 0;
  const executor = new SkillExecutor(
    registry,
    new ExecutionPolicyEngine(state),
    options.audit ?? NOOP_AGENT_AUDIT,
    () => fixtureUuid("5", auditSequence++),
    () => monotonicTime++,
    () => {},
    confirmations,
  );
  return { state, confirmationStore, confirmations, executor };
}

function registerValueSkill(
  registry: SkillRegistry,
  name: string,
  execution: SkillExecutionMetadata,
  onExecute: (value: string) => void,
): void {
  const skill: ShivaSkill<{ value: string }, { value: string }> = {
    name,
    description: `Runs the ${name} fixture.`,
    inputDescription: '{ "value": string }',
    inputSchema: z.object({ value: z.string() }).strict(),
    execution,
    async execute(input) {
      onExecute(input.value);
      return { success: true, data: { value: input.value } };
    },
  };
  registry.register(skill);
}

function requiredConfirmationId(result: SkillResult<unknown>): string {
  assert.equal(result.success, false);
  if (result.success) throw new Error("Expected a confirmation failure.");
  assert.equal(result.error.code, "CONFIRMATION_REQUIRED");
  const id = result.error.confirmation?.id;
  assert.ok(id);
  return id;
}

function context(now: () => Date = () => NOW): SkillContext {
  return {
    agentRunId: "10000000-0000-4000-8000-000000000001",
    conversationId: CONVERSATION_ID,
    userId: USER_ID,
    userName: "Yash",
    timeZone: "Asia/Kolkata",
    now,
  };
}

function fixtureUuid(prefix: string, sequence: number): string {
  return `${prefix}0000000-0000-4000-8000-${String(sequence).padStart(12, "0")}`;
}

class RecordingAudit implements AgentAuditPort {
  readonly skillStarts: StartSkillRunInput[] = [];
  readonly skillFinishes: FinishSkillRunInput[] = [];

  async startAgentRun(_input: StartAgentRunInput): Promise<void> {}
  async finishAgentRun(_input: FinishAgentRunInput): Promise<void> {}

  async startSkillRun(input: StartSkillRunInput): Promise<void> {
    this.skillStarts.push(input);
  }

  async finishSkillRun(input: FinishSkillRunInput): Promise<void> {
    this.skillFinishes.push(input);
  }
}
