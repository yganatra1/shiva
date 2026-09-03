import assert from "node:assert/strict";
import { test } from "node:test";

import { CoreAuthorizedAgentExecutionPolicy } from "../src/agents/google/core-authorized-execution-policy.js";
import { createDeveloperPm2StatusSkill } from "../src/skills/developer-pm2-status/skill.js";
import { SkillExecutor } from "../src/skills/executor.js";
import { SkillRegistry } from "../src/skills/registry.js";
import type { SkillContext } from "../src/skills/types.js";
import {
  BuildRestartRunner,
  type Pm2ListResult,
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
  calls: { serviceNames: readonly string[] }[] = [];
  result: Pm2ListResult = {
    services: [
      {
        name: "shiva-api",
        pm2Id: 0,
        status: "online",
        pid: 4242,
        restarts: 2,
        uptimeMs: 60_000,
      },
    ],
    raw: "[]",
    truncated: false,
  };

  constructor() {
    super({ buildTimeoutMs: 1_000, restartTimeoutMs: 1_000, env: process.env });
  }

  override async listStatus(serviceNames: readonly string[]): Promise<Pm2ListResult> {
    this.calls.push({ serviceNames });
    return this.result;
  }
}

test("developer_pm2_status only offers repos present in both maps, resolves the pm2 service, and reports read/normal", async () => {
  const runner = new FakeBuildRestartRunner();
  const registry = new SkillRegistry();
  registry.register(
    createDeveloperPm2StatusSkill(
      { shiva: "/repos/shiva", other: "/repos/other" },
      { shiva: "shiva-api" },
      runner,
    ),
  );
  const executor = new SkillExecutor(registry, new CoreAuthorizedAgentExecutionPolicy());

  const result = await executor.execute(
    "developer_pm2_status",
    { repo: "shiva" },
    context,
    { userAuthorized: true },
  );

  assert.deepEqual(result, {
    success: true,
    data: {
      repo: "shiva",
      pm2Service: "shiva-api",
      status: "online",
      pid: 4242,
      restarts: 2,
      uptimeMs: 60_000,
      truncated: false,
    },
  });
  assert.deepEqual(runner.calls[0], { serviceNames: ["shiva-api"] });
  const summary = registry
    .list()
    .find((skill) => skill.name === "developer_pm2_status");
  assert.equal(summary?.configured, true);
  assert.equal(summary?.execution.mutability, "read");
  assert.equal(summary?.execution.impact, "normal");
});

test("developer_pm2_status's repo input is limited to the DEVELOPER_AGENT_REPOS/DEVELOPER_AGENT_PM2_SERVICES intersection", async () => {
  const runner = new FakeBuildRestartRunner();
  const registry = new SkillRegistry();
  registry.register(
    createDeveloperPm2StatusSkill(
      { shiva: "/repos/shiva", other: "/repos/other" },
      { shiva: "shiva-api" },
      runner,
    ),
  );
  const executor = new SkillExecutor(registry, new CoreAuthorizedAgentExecutionPolicy());

  const result = await executor.execute(
    "developer_pm2_status",
    { repo: "other" },
    context,
    { userAuthorized: true },
  );

  assert.equal(result.success, false);
  assert.equal(runner.calls.length, 0);
});

test("developer_pm2_status reports not-found when pm2 doesn't report the configured service", async () => {
  const runner = new FakeBuildRestartRunner();
  runner.result = { services: [], raw: "[]", truncated: false };
  const registry = new SkillRegistry();
  registry.register(
    createDeveloperPm2StatusSkill(
      { shiva: "/repos/shiva" },
      { shiva: "shiva-api" },
      runner,
    ),
  );
  const executor = new SkillExecutor(registry, new CoreAuthorizedAgentExecutionPolicy());

  const result = await executor.execute(
    "developer_pm2_status",
    { repo: "shiva" },
    context,
    { userAuthorized: true },
  );

  assert.equal(result.success, false);
  if (!result.success) {
    assert.equal(result.error.code, "DEVELOPER_PM2_STATUS_NOT_FOUND");
  }
});

test("developer_pm2_status reports unavailable and configured=false when no repo has both a path and a pm2 service", async () => {
  const registry = new SkillRegistry();
  registry.register(
    createDeveloperPm2StatusSkill({ shiva: "/repos/shiva" }, {}, undefined),
  );
  const executor = new SkillExecutor(registry, new CoreAuthorizedAgentExecutionPolicy());

  const summary = registry
    .list()
    .find((entry) => entry.name === "developer_pm2_status");
  assert.equal(summary?.configured, false);

  const result = await executor.execute(
    "developer_pm2_status",
    { repo: "anything" },
    context,
    { userAuthorized: true },
  );
  assert.equal(result.success, false);
  if (!result.success) {
    assert.equal(result.error.code, "DEVELOPER_PM2_STATUS_UNAVAILABLE");
  }
});
