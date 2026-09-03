import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import {
  BuildRestartError,
  BuildRestartRunner,
  buildRestartRunnerErrorToFailure,
} from "../src/tools/developer/build-restart-runner.js";

const fixtureCommand = fileURLToPath(
  new URL("./fixtures/fake-build-restart-cli.mjs", import.meta.url),
);

async function repoWithPackageJson(options?: {
  readonly nested?: boolean;
}): Promise<string> {
  const repoPath = await mkdtemp(join(tmpdir(), "build-restart-test-"));
  const targetDir = options?.nested ? join(repoPath, "app") : repoPath;
  if (options?.nested) await mkdir(targetDir);
  await writeFile(join(targetDir, "package.json"), "{}");
  return repoPath;
}

function runner(
  overrides: Partial<ConstructorParameters<typeof BuildRestartRunner>[0]> = {},
  env: NodeJS.ProcessEnv = process.env,
) {
  return new BuildRestartRunner({
    buildTimeoutMs: 5_000,
    restartTimeoutMs: 5_000,
    npmCommand: fixtureCommand,
    pm2Command: fixtureCommand,
    env,
    ...overrides,
  });
}

test("run() finds package.json at the repo root", async () => {
  const repoPath = await repoWithPackageJson();
  const result = await runner({}, { ...process.env, BUILD_MODE: "SUCCESS", RESTART_MODE: "SUCCESS" }).run({
    repoPath,
    pm2ServiceName: "shiva-api",
  });
  assert.equal(result.buildDir, repoPath);
  assert.equal(result.restarted, true);
});

test("run() finds package.json one level down (e.g. an `app` subdirectory)", async () => {
  const repoPath = await repoWithPackageJson({ nested: true });
  const result = await runner({}, { ...process.env, BUILD_MODE: "SUCCESS", RESTART_MODE: "SUCCESS" }).run({
    repoPath,
    pm2ServiceName: "shiva-api",
  });
  assert.equal(result.buildDir, join(repoPath, "app"));
});

test("run() rejects with PACKAGE_JSON_NOT_FOUND when no package.json exists anywhere under the repo", async () => {
  const repoPath = await mkdtemp(join(tmpdir(), "build-restart-test-"));
  await assert.rejects(
    () => runner().run({ repoPath, pm2ServiceName: "shiva-api" }),
    (error: unknown) =>
      error instanceof BuildRestartError &&
      error.failure === "PACKAGE_JSON_NOT_FOUND",
  );
});

test("run() rejects with PACKAGE_JSON_NOT_FOUND when more than one subdirectory has a package.json", async () => {
  const repoPath = await mkdtemp(join(tmpdir(), "build-restart-test-"));
  await mkdir(join(repoPath, "app"));
  await mkdir(join(repoPath, "other"));
  await writeFile(join(repoPath, "app", "package.json"), "{}");
  await writeFile(join(repoPath, "other", "package.json"), "{}");
  await assert.rejects(
    () => runner().run({ repoPath, pm2ServiceName: "shiva-api" }),
    (error: unknown) =>
      error instanceof BuildRestartError &&
      error.failure === "PACKAGE_JSON_NOT_FOUND",
  );
});

test("run() never restarts when the build fails", async () => {
  const repoPath = await repoWithPackageJson();
  await assert.rejects(
    () =>
      runner({}, { ...process.env, BUILD_MODE: "FAIL", RESTART_MODE: "SUCCESS" }).run({
        repoPath,
        pm2ServiceName: "shiva-api",
      }),
    (error: unknown) =>
      error instanceof BuildRestartError &&
      error.failure === "BUILD_FAILED" &&
      /boom/.test(error.message),
  );
});

test("run() rejects with RESTART_FAILED when the build succeeds but pm2 restart fails", async () => {
  const repoPath = await repoWithPackageJson();
  await assert.rejects(
    () =>
      runner({}, { ...process.env, BUILD_MODE: "SUCCESS", RESTART_MODE: "FAIL" }).run({
        repoPath,
        pm2ServiceName: "shiva-api",
      }),
    (error: unknown) =>
      error instanceof BuildRestartError && error.failure === "RESTART_FAILED",
  );
});

test("run() enforces its own build timeout, escalating to SIGKILL when the process ignores SIGTERM", async () => {
  const repoPath = await repoWithPackageJson();
  await assert.rejects(
    () =>
      runner(
        { buildTimeoutMs: 1_000 },
        { ...process.env, BUILD_MODE: "HANG" },
      ).run({ repoPath, pm2ServiceName: "shiva-api" }),
    (error: unknown) =>
      error instanceof BuildRestartError && error.failure === "BUILD_TIMEOUT",
  );
});

test("run() terminates and rejects a runaway build that exceeds the output cap", async () => {
  const repoPath = await repoWithPackageJson();
  await assert.rejects(() =>
    runner(
      { buildTimeoutMs: 5_000, maxOutputBytes: 4_096 },
      { ...process.env, BUILD_MODE: "BIG_OUTPUT" },
    ).run({ repoPath, pm2ServiceName: "shiva-api" }),
  );
});

test("run() rejects with UNAVAILABLE when npm cannot be spawned at all", async () => {
  const repoPath = await repoWithPackageJson();
  await assert.rejects(
    () =>
      runner({ npmCommand: "/nonexistent/definitely-not-npm" }).run({
        repoPath,
        pm2ServiceName: "shiva-api",
      }),
    (error: unknown) =>
      error instanceof BuildRestartError && error.failure === "UNAVAILABLE",
  );
});

test("restart() succeeds without running a build", async () => {
  const result = await runner(
    {},
    { ...process.env, RESTART_MODE: "SUCCESS" },
  ).restart("shiva-api");
  assert.equal(result.restartTruncated, false);
  assert.match(result.restartOutput, /restart shiva-api/);
});

test("restart() rejects with RESTART_FAILED when pm2 restart exits non-zero", async () => {
  await assert.rejects(
    () =>
      runner({}, { ...process.env, RESTART_MODE: "FAIL" }).restart("shiva-api"),
    (error: unknown) =>
      error instanceof BuildRestartError && error.failure === "RESTART_FAILED",
  );
});

test("restart() enforces its own timeout, escalating to SIGKILL when the process ignores SIGTERM", async () => {
  await assert.rejects(
    () =>
      runner(
        { restartTimeoutMs: 1_000 },
        { ...process.env, RESTART_MODE: "HANG" },
      ).restart("shiva-api"),
    (error: unknown) =>
      error instanceof BuildRestartError && error.failure === "RESTART_TIMEOUT",
  );
});

test("restart() rejects with UNAVAILABLE when pm2 cannot be spawned at all", async () => {
  await assert.rejects(
    () =>
      runner({ pm2Command: "/nonexistent/definitely-not-pm2" }).restart(
        "shiva-api",
      ),
    (error: unknown) =>
      error instanceof BuildRestartError && error.failure === "UNAVAILABLE",
  );
});

test("listStatus() returns only entries matching the requested service names", async () => {
  const pm2Json = JSON.stringify([
    {
      name: "shiva-api",
      pm_id: 0,
      pid: 4242,
      pm2_env: { status: "online", restart_time: 3, pm_uptime: Date.now() - 5_000 },
    },
    {
      name: "unrelated-tenant-service",
      pm_id: 1,
      pid: 9999,
      pm2_env: { status: "online", restart_time: 0, pm_uptime: Date.now() },
    },
  ]);
  const result = await runner(
    {},
    { ...process.env, LIST_MODE: "JSON", LIST_JSON: pm2Json },
  ).listStatus(["shiva-api"]);
  assert.equal(result.services.length, 1);
  assert.equal(result.services[0]?.name, "shiva-api");
  assert.equal(result.services[0]?.status, "online");
  assert.equal(result.services[0]?.pid, 4242);
  assert.equal(result.services[0]?.restarts, 3);
  assert.ok((result.services[0]?.uptimeMs ?? 0) >= 0);
});

test("listStatus() returns an empty list when the requested service isn't reported by pm2", async () => {
  const result = await runner(
    {},
    { ...process.env, LIST_MODE: "JSON", LIST_JSON: "[]" },
  ).listStatus(["shiva-api"]);
  assert.deepEqual(result.services, []);
});

test("listStatus() rejects with LIST_PARSE_FAILED when pm2 jlist does not return JSON", async () => {
  await assert.rejects(
    () =>
      runner({}, { ...process.env, LIST_MODE: "INVALID_JSON" }).listStatus([
        "shiva-api",
      ]),
    (error: unknown) =>
      error instanceof BuildRestartError && error.failure === "LIST_PARSE_FAILED",
  );
});

test("listStatus() rejects with LIST_FAILED when pm2 jlist exits non-zero", async () => {
  await assert.rejects(
    () =>
      runner({}, { ...process.env, LIST_MODE: "FAIL" }).listStatus(["shiva-api"]),
    (error: unknown) =>
      error instanceof BuildRestartError && error.failure === "LIST_FAILED",
  );
});

test("listStatus() enforces its own timeout", async () => {
  await assert.rejects(
    () =>
      runner(
        { listTimeoutMs: 1_000 },
        { ...process.env, LIST_MODE: "HANG" },
      ).listStatus(["shiva-api"]),
    (error: unknown) =>
      error instanceof BuildRestartError && error.failure === "LIST_TIMEOUT",
  );
});

test("listStatus() rejects with UNAVAILABLE when pm2 cannot be spawned at all", async () => {
  await assert.rejects(
    () =>
      runner({ pm2Command: "/nonexistent/definitely-not-pm2" }).listStatus([
        "shiva-api",
      ]),
    (error: unknown) =>
      error instanceof BuildRestartError && error.failure === "UNAVAILABLE",
  );
});

test("buildRestartRunnerErrorToFailure maps every failure kind and rethrows anything else", () => {
  assert.equal(
    buildRestartRunnerErrorToFailure(
      new BuildRestartError("BUILD_TIMEOUT", "x"),
    ).code,
    "DEVELOPER_BUILD_RESTART_BUILD_TIMEOUT",
  );
  assert.equal(
    buildRestartRunnerErrorToFailure(
      new BuildRestartError("BUILD_FAILED", "boom"),
    ).message,
    "boom",
  );
  assert.equal(
    buildRestartRunnerErrorToFailure(
      new BuildRestartError("LIST_TIMEOUT", "x"),
    ).code,
    "DEVELOPER_BUILD_RESTART_LIST_TIMEOUT",
  );
  assert.equal(
    buildRestartRunnerErrorToFailure(
      new BuildRestartError("LIST_PARSE_FAILED", "bad json"),
    ).message,
    "bad json",
  );
  assert.throws(() => buildRestartRunnerErrorToFailure(new Error("other")));
});
