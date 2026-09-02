import assert from "node:assert/strict";
import { test } from "node:test";

import { CoreAuthorizedAgentExecutionPolicy } from "../src/agents/google/core-authorized-execution-policy.js";
import {
  createDeveloperExecuteSkill,
  type DeveloperExecuteOutput,
} from "../src/skills/developer-execute/skill.js";
import { SkillExecutor } from "../src/skills/executor.js";
import { SkillRegistry } from "../src/skills/registry.js";
import type { SkillContext } from "../src/skills/types.js";
import {
  ClaudeCodeRunner,
  type ClaudeCodeRunInput,
  type ClaudeCodeRunResult,
} from "../src/tools/developer/claude-code-runner.js";

const context: SkillContext = {
  agentRunId: "10000000-0000-4000-8000-000000000001",
  conversationId: "20000000-0000-4000-8000-000000000002",
  userId: "30000000-0000-4000-8000-000000000003",
  userName: "Yash",
  timeZone: "Asia/Kolkata",
  now: () => new Date("2026-09-02T00:00:00Z"),
};

class FakeClaudeCodeRunner extends ClaudeCodeRunner {
  calls: ClaudeCodeRunInput[] = [];
  result: ClaudeCodeRunResult = {
    sessionId: "sess-1",
    result: "explained the architecture",
    isError: false,
    exitCode: 0,
    durationMs: 42,
    truncated: false,
  };

  constructor() {
    super({ timeoutMs: 1_000, maxTurns: 5, env: process.env });
  }

  override async run(input: ClaudeCodeRunInput): Promise<ClaudeCodeRunResult> {
    this.calls.push(input);
    return this.result;
  }
}

test("developer_execute resolves the repo key to its configured path and reports write/sensitive", async () => {
  const runner = new FakeClaudeCodeRunner();
  const registry = new SkillRegistry();
  registry.register(
    createDeveloperExecuteSkill({ shiva: "/repos/shiva" }, runner),
  );
  const executor = new SkillExecutor(registry, new CoreAuthorizedAgentExecutionPolicy());

  const result = await executor.execute(
    "developer_execute",
    { repo: "shiva", instruction: "Explain this repository's architecture." },
    context,
    { userAuthorized: true },
  );

  assert.deepEqual(result, {
    success: true,
    data: {
      repo: "shiva",
      sessionId: "sess-1",
      result: "explained the architecture",
      isError: false,
      exitCode: 0,
      durationMs: 42,
      truncated: false,
    },
  });
  assert.deepEqual(runner.calls[0], {
    repoPath: "/repos/shiva",
    instruction: "Explain this repository's architecture.",
  });
  const summary = registry.list().find((skill) => skill.name === "developer_execute");
  assert.equal(summary?.configured, true);
  assert.equal(summary?.execution.mutability, "write");
  assert.equal(summary?.execution.impact, "sensitive");
});

test("developer_execute's repo input is a fixed enum — an unconfigured repo name is rejected before any run", async () => {
  const runner = new FakeClaudeCodeRunner();
  const registry = new SkillRegistry();
  registry.register(
    createDeveloperExecuteSkill({ shiva: "/repos/shiva" }, runner),
  );
  const executor = new SkillExecutor(registry, new CoreAuthorizedAgentExecutionPolicy());

  const result = await executor.execute(
    "developer_execute",
    { repo: "some-other-repo", instruction: "Do something." },
    context,
    { userAuthorized: true },
  );

  assert.equal(result.success, false);
  assert.equal(runner.calls.length, 0);
});

test("developer_execute reports unavailable and configured=false when no repo is set up", async () => {
  const registry = new SkillRegistry();
  registry.register(createDeveloperExecuteSkill({}, undefined));
  const executor = new SkillExecutor(registry, new CoreAuthorizedAgentExecutionPolicy());

  const summary = registry.list().find((entry) => entry.name === "developer_execute");
  assert.equal(summary?.configured, false);

  const result = await executor.execute(
    "developer_execute",
    { repo: "anything", instruction: "Do something." },
    context,
    { userAuthorized: true },
  );
  assert.equal(result.success, false);
  if (!result.success) {
    assert.equal(result.error.code, "DEVELOPER_AGENT_UNAVAILABLE");
  }
});

test("developer_execute surfaces isError:true from a completed-but-failed session without failing the skill call", async () => {
  const runner = new FakeClaudeCodeRunner();
  runner.result = {
    result: "could not find the requested file",
    isError: true,
    exitCode: 0,
    durationMs: 10,
    truncated: false,
  };
  const registry = new SkillRegistry();
  registry.register(
    createDeveloperExecuteSkill({ shiva: "/repos/shiva" }, runner),
  );
  const executor = new SkillExecutor(registry, new CoreAuthorizedAgentExecutionPolicy());

  const result = await executor.execute(
    "developer_execute",
    { repo: "shiva", instruction: "Do the impossible." },
    context,
    { userAuthorized: true },
  );

  assert.equal(result.success, true);
  if (result.success) {
    assert.equal((result.data as DeveloperExecuteOutput).isError, true);
  }
});
