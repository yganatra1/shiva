import assert from "node:assert/strict";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import {
  ClaudeCodeRunner,
  ClaudeCodeRunnerError,
  claudeCodeRunnerErrorToFailure,
} from "../src/tools/developer/claude-code-runner.js";

const fixtureCommand = fileURLToPath(
  new URL("./fixtures/fake-claude-cli.mjs", import.meta.url),
);

function runner(overrides: Partial<ConstructorParameters<typeof ClaudeCodeRunner>[0]> = {}) {
  return new ClaudeCodeRunner({
    timeoutMs: 5_000,
    maxTurns: 10,
    permissionMode: "bypassPermissions",
    command: fixtureCommand,
    env: process.env,
    ...overrides,
  });
}

test("run() passes --dangerously-skip-permissions only for permissionMode bypassPermissions", async () => {
  const result = await runner({ permissionMode: "bypassPermissions" }).run({
    repoPath: process.cwd(),
    instruction: "ECHO_ARGV",
  });
  const argv = JSON.parse(result.result) as string[];
  assert.ok(argv.includes("--dangerously-skip-permissions"));
  assert.ok(!argv.includes("--permission-mode"));
});

test("run() translates any other permissionMode into --permission-mode <value>", async () => {
  const result = await runner({ permissionMode: "acceptEdits" }).run({
    repoPath: process.cwd(),
    instruction: "ECHO_ARGV",
  });
  const argv = JSON.parse(result.result) as string[];
  assert.ok(!argv.includes("--dangerously-skip-permissions"));
  const modeIndex = argv.indexOf("--permission-mode");
  assert.ok(modeIndex >= 0);
  assert.equal(argv[modeIndex + 1], "acceptEdits");
});

test("run() parses a successful JSON result", async () => {
  const result = await runner().run({
    repoPath: process.cwd(),
    instruction: "SUCCESS",
  });

  assert.deepEqual(result, {
    sessionId: "sess-1",
    result: "did the thing",
    isError: false,
    exitCode: 0,
    durationMs: result.durationMs,
    truncated: false,
  });
  assert.ok(result.durationMs >= 0);
});

test("run() surfaces is_error:true without throwing — a completed session that failed its task is not a runner failure", async () => {
  const result = await runner().run({
    repoPath: process.cwd(),
    instruction: "IS_ERROR",
  });

  assert.equal(result.isError, true);
  assert.equal(result.result, "could not finish");
});

test("run() rejects with INVALID_RESPONSE for malformed JSON stdout", async () => {
  await assert.rejects(
    () => runner().run({ repoPath: process.cwd(), instruction: "MALFORMED" }),
    (error: unknown) =>
      error instanceof ClaudeCodeRunnerError &&
      error.failure === "INVALID_RESPONSE",
  );
});

test("run() rejects with INVALID_RESPONSE when the result field is missing", async () => {
  await assert.rejects(
    () =>
      runner().run({
        repoPath: process.cwd(),
        instruction: "MISSING_RESULT_FIELD",
      }),
    (error: unknown) =>
      error instanceof ClaudeCodeRunnerError &&
      error.failure === "INVALID_RESPONSE",
  );
});

test("run() rejects with EXECUTION_FAILED on a non-zero exit", async () => {
  await assert.rejects(
    () => runner().run({ repoPath: process.cwd(), instruction: "FAIL" }),
    (error: unknown) =>
      error instanceof ClaudeCodeRunnerError &&
      error.failure === "EXECUTION_FAILED" &&
      /boom/.test(error.message),
  );
});

test("run() enforces its own wall-clock timeout, escalating to SIGKILL when the process ignores SIGTERM", async () => {
  await assert.rejects(
    () =>
      runner({ timeoutMs: 1_000 }).run({
        repoPath: process.cwd(),
        instruction: "HANG",
      }),
    (error: unknown) =>
      error instanceof ClaudeCodeRunnerError && error.failure === "TIMEOUT",
  );
});

test("run() terminates and rejects a runaway process that exceeds the output cap", async () => {
  await assert.rejects(() =>
    runner({ timeoutMs: 5_000, maxOutputBytes: 4_096 }).run({
      repoPath: process.cwd(),
      instruction: "BIG_OUTPUT",
    }),
  );
});

test("run() rejects with UNAVAILABLE when the claude binary cannot be spawned at all", async () => {
  await assert.rejects(
    () =>
      runner({ command: "/nonexistent/definitely-not-claude" }).run({
        repoPath: process.cwd(),
        instruction: "SUCCESS",
      }),
    (error: unknown) =>
      error instanceof ClaudeCodeRunnerError && error.failure === "UNAVAILABLE",
  );
});

test("claudeCodeRunnerErrorToFailure maps every failure kind and rethrows anything else", () => {
  assert.equal(
    claudeCodeRunnerErrorToFailure(
      new ClaudeCodeRunnerError("TIMEOUT", "x"),
    ).code,
    "DEVELOPER_EXECUTE_TIMEOUT",
  );
  assert.equal(
    claudeCodeRunnerErrorToFailure(
      new ClaudeCodeRunnerError("EXECUTION_FAILED", "boom"),
    ).message,
    "boom",
  );
  assert.throws(() => claudeCodeRunnerErrorToFailure(new Error("other")));
});
