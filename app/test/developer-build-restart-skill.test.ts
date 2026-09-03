import assert from "node:assert/strict";
import { test } from "node:test";

import { CoreAuthorizedAgentExecutionPolicy } from "../src/agents/google/core-authorized-execution-policy.js";
import { createDeveloperBuildRestartSkill } from "../src/skills/developer-build-restart/skill.js";
import { SkillExecutor } from "../src/skills/executor.js";
import { SkillRegistry } from "../src/skills/registry.js";
import type { SkillContext } from "../src/skills/types.js";
import {
  BuildRestartRunner,
  type BuildRestartInput,
  type BuildRestartResult,
} from "../src/tools/developer/build-restart-runner.js";

const context: SkillContext = {
  agentRunId: "10000000-0000-4000-8000-000000000001",
  conversationId: "20000000-0000-4000-8000-000000000002",
  userId: "30000000-0000-4000-8000-000000000003",
  userName: "Yash",
  timeZone: "Asia/Kolkata",
  now: () => new Date("2026-09-02T00:00:00Z"),
};

class FakeBuildRestartRunner extends BuildRestartRunner {
  calls: BuildRestartInput[] = [];
  result: BuildRestartResult = {
    buildDir: "/repos/shiva/app",
    buildOutput: "build ok",
    buildDurationMs: 10,
    buildTruncated: false,
    restarted: true,
    restartOutput: "restart ok",
    restartDurationMs: 5,
    restartTruncated: false,
  };

  constructor() {
    super({ buildTimeoutMs: 1_000, restartTimeoutMs: 1_000, env: process.env });
  }

  override async run(input: BuildRestartInput): Promise<BuildRestartResult> {
    this.calls.push(input);
    return this.result;
  }
}

test("developer_build_restart only offers repos present in both maps, resolves the pm2 service, and reports write/sensitive", async () => {
  const runner = new FakeBuildRestartRunner();
  const registry = new SkillRegistry();
  registry.register(
    createDeveloperBuildRestartSkill(
      { shiva: "/repos/shiva", other: "/repos/other" },
      { shiva: "shiva-api" },
      runner,
    ),
  );
  const executor = new SkillExecutor(registry, new CoreAuthorizedAgentExecutionPolicy());

  const result = await executor.execute(
    "developer_build_restart",
    { repo: "shiva" },
    context,
    { userAuthorized: true },
  );

  assert.deepEqual(result, {
    success: true,
    data: {
      repo: "shiva",
      buildDir: "/repos/shiva/app",
      buildOutput: "build ok",
      buildDurationMs: 10,
      buildTruncated: false,
      pm2Service: "shiva-api",
      restarted: true,
      restartOutput: "restart ok",
      restartDurationMs: 5,
      restartTruncated: false,
    },
  });
  assert.deepEqual(runner.calls[0], {
    repoPath: "/repos/shiva",
    pm2ServiceName: "shiva-api",
  });
  const summary = registry
    .list()
    .find((skill) => skill.name === "developer_build_restart");
  assert.equal(summary?.configured, true);
  assert.equal(summary?.execution.mutability, "write");
  assert.equal(summary?.execution.impact, "sensitive");
});

test("developer_build_restart's repo input is limited to the DEVELOPER_AGENT_REPOS/DEVELOPER_AGENT_PM2_SERVICES intersection", async () => {
  const runner = new FakeBuildRestartRunner();
  const registry = new SkillRegistry();
  registry.register(
    createDeveloperBuildRestartSkill(
      { shiva: "/repos/shiva", other: "/repos/other" },
      { shiva: "shiva-api" },
      runner,
    ),
  );
  const executor = new SkillExecutor(registry, new CoreAuthorizedAgentExecutionPolicy());

  const result = await executor.execute(
    "developer_build_restart",
    { repo: "other" },
    context,
    { userAuthorized: true },
  );

  assert.equal(result.success, false);
  assert.equal(runner.calls.length, 0);
});

test("developer_build_restart reports unavailable and configured=false when no repo has both a path and a pm2 service", async () => {
  const registry = new SkillRegistry();
  registry.register(
    createDeveloperBuildRestartSkill({ shiva: "/repos/shiva" }, {}, undefined),
  );
  const executor = new SkillExecutor(registry, new CoreAuthorizedAgentExecutionPolicy());

  const summary = registry
    .list()
    .find((entry) => entry.name === "developer_build_restart");
  assert.equal(summary?.configured, false);

  const result = await executor.execute(
    "developer_build_restart",
    { repo: "anything" },
    context,
    { userAuthorized: true },
  );
  assert.equal(result.success, false);
  if (!result.success) {
    assert.equal(result.error.code, "DEVELOPER_BUILD_RESTART_UNAVAILABLE");
  }
});
