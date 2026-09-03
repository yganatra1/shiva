import { spawn } from "node:child_process";
import { resolve } from "node:path";

import { z } from "zod";

export type ClaudeCodeRunnerFailure =
  | "TIMEOUT"
  | "UNAVAILABLE"
  | "INVALID_RESPONSE"
  | "EXECUTION_FAILED"
  | "CANCELLED"
  | "ALREADY_RUNNING";

export class ClaudeCodeRunnerError extends Error {
  override readonly name = "ClaudeCodeRunnerError";

  constructor(
    readonly failure: ClaudeCodeRunnerFailure,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
  }
}

/**
 * "bypassPermissions" (--dangerously-skip-permissions) refuses to start when
 * the process's effective user is root — the other modes tolerate root.
 * There is no TTY in headless (-p) mode, so any mode other than
 * bypassPermissions auto-denies a tool call it hasn't been pre-approved for
 * rather than prompting anyone; "acceptEdits" auto-approves file
 * read/write/edit tools specifically, which covers most repo-inspection and
 * simple-change instructions without needing root.
 */
export type ClaudeCodePermissionMode =
  | "bypassPermissions"
  | "acceptEdits"
  | "plan"
  | "default";

export interface ClaudeCodeRunInput {
  readonly repoPath: string;
  readonly instruction: string;
  readonly signal?: AbortSignal;
}

export interface ClaudeCodeRunResult {
  readonly sessionId?: string;
  readonly result: string;
  readonly isError: boolean;
  readonly exitCode: number;
  readonly durationMs: number;
  readonly truncated: boolean;
}

export interface ClaudeCodeRunnerOptions {
  /**
   * Wall-clock cap enforced by this runner. Claude Code has no built-in
   * timeout — a headless session runs as long as the agentic loop takes.
   */
  readonly timeoutMs: number;
  readonly maxTurns: number;
  readonly maxOutputBytes?: number;
  readonly permissionMode: ClaudeCodePermissionMode;
  /**
   * Claude Code tool patterns pre-approved regardless of permissionMode, e.g.
   * ["Bash(npm *)", "Bash(npx *)"]. Under a mode other than bypassPermissions,
   * headless has no TTY to approve anything not covered here or by the
   * mode's own auto-approvals (acceptEdits' file edits) — without this,
   * "run the tests" instructions can edit a file but never verify it.
   */
  readonly allowedTools?: readonly string[];
  /** Test seam; production always spawns the real "claude" binary on PATH. */
  readonly command?: string;
  /**
   * The subprocess's environment. Must include HOME (or CLAUDE_CONFIG_DIR)
   * so the CLI can find the session saved by `claude login`, and a normal
   * PATH so anything it shells out to (git, npm, test runners) works.
   * Deliberately not scrubbed down to a minimal set the way
   * ReadOnlyWorkspaceTerminal's env is — this tool intentionally runs with
   * the same effective permissions as the OS user, since it drives a full
   * coding agent rather than a bounded set of read-only commands.
   */
  readonly env: NodeJS.ProcessEnv;
}

const DEFAULT_MAX_OUTPUT_BYTES = 2 * 1024 * 1024;

const claudeCodeJsonResultSchema = z
  .object({
    session_id: z.string().optional(),
    result: z.string(),
    is_error: z.boolean().optional(),
  })
  .passthrough();

/**
 * Runs the `claude` CLI headlessly (`-p`) against one repository and parses
 * its structured JSON result. Every invocation is a fresh, independent
 * session — this runner never uses --continue/--resume.
 */
export class ClaudeCodeRunner {
  private readonly timeoutMs: number;
  private readonly maxTurns: number;
  private readonly maxOutputBytes: number;
  private readonly permissionMode: ClaudeCodePermissionMode;
  private readonly allowedTools: readonly string[];
  private readonly command: string;
  private readonly env: NodeJS.ProcessEnv;
  /**
   * repoPath -> when the currently in-flight run against it started. Guards
   * against a second developer_execute call (e.g. Core giving up early on
   * its own wait and retrying, or the user saying "try again") launching a
   * concurrent, conflicting Claude Code session against the same repo while
   * the first is still genuinely working — this rejects fast instead.
   */
  private readonly activeRuns = new Map<string, number>();

  constructor(options: ClaudeCodeRunnerOptions) {
    this.timeoutMs = options.timeoutMs;
    this.maxTurns = options.maxTurns;
    this.maxOutputBytes = options.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES;
    this.permissionMode = options.permissionMode;
    this.allowedTools = options.allowedTools ?? [];
    this.command = options.command ?? "claude";
    this.env = options.env;
    if (!Number.isInteger(this.timeoutMs) || this.timeoutMs < 1_000) {
      throw new RangeError(
        "ClaudeCodeRunner timeoutMs must be a positive integer of at least 1000ms.",
      );
    }
    if (!Number.isInteger(this.maxTurns) || this.maxTurns < 1) {
      throw new RangeError("ClaudeCodeRunner maxTurns must be a positive integer.");
    }
  }

  async run(input: ClaudeCodeRunInput): Promise<ClaudeCodeRunResult> {
    input.signal?.throwIfAborted();
    const repoKey = resolve(input.repoPath);
    const existingStartedAt = this.activeRuns.get(repoKey);
    if (existingStartedAt !== undefined) {
      const elapsedSeconds = Math.round((Date.now() - existingStartedAt) / 1_000);
      throw new ClaudeCodeRunnerError(
        "ALREADY_RUNNING",
        `A Claude Code session is already running against this repository (started ${elapsedSeconds}s ago); refusing to start a second, concurrent one. Wait for it to finish rather than retrying.`,
      );
    }
    this.activeRuns.set(repoKey, Date.now());
    try {
      const startedAt = performance.now();
      const spawned = await this.spawn(
        input.repoPath,
        input.instruction,
        input.signal,
      );
      const durationMs = Math.max(0, performance.now() - startedAt);

      if (spawned.exitCode !== 0) {
        throw new ClaudeCodeRunnerError(
          "EXECUTION_FAILED",
          `Claude Code exited with status ${spawned.exitCode}.${
            spawned.stderr ? ` stderr: ${spawned.stderr.slice(0, 2_000)}` : ""
          }`,
        );
      }

      const parsed = claudeCodeJsonResultSchema.safeParse(
        lastResultEvent(spawned.stdout),
      );
      if (!parsed.success) {
        throw new ClaudeCodeRunnerError(
          "INVALID_RESPONSE",
          "Claude Code returned a response that did not match the expected JSON result shape.",
        );
      }

      return {
        ...(parsed.data.session_id ? { sessionId: parsed.data.session_id } : {}),
        result: parsed.data.result,
        isError: parsed.data.is_error ?? false,
        exitCode: spawned.exitCode,
        durationMs,
        truncated: spawned.truncated,
      };
    } finally {
      this.activeRuns.delete(repoKey);
    }
  }

  private spawn(
    cwd: string,
    instruction: string,
    signal?: AbortSignal,
  ): Promise<{
    exitCode: number;
    stdout: string;
    stderr: string;
    truncated: boolean;
  }> {
    return new Promise((resolve, reject) => {
      let settled = false;
      let truncated = false;
      let capturedBytes = 0;
      const stdout: Buffer[] = [];
      const stderr: Buffer[] = [];
      const child = spawn(
        this.command,
        [
          "-p",
          instruction,
          "--output-format",
          "stream-json",
          "--verbose",
          ...(this.permissionMode === "bypassPermissions"
            ? ["--dangerously-skip-permissions"]
            : ["--permission-mode", this.permissionMode]),
          ...(this.allowedTools.length > 0
            ? ["--allowedTools", this.allowedTools.join(",")]
            : []),
          "--max-turns",
          String(this.maxTurns),
        ],
        {
          cwd,
          shell: false,
          // "ignore" maps stdin to /dev/null at the OS level; explicitly
          // piping and immediately ending it is a more predictable EOF
          // signal across platforms for a CLI that also supports reading
          // piped stdin input in -p mode.
          stdio: ["pipe", "pipe", "pipe"],
          env: this.env,
        },
      );
      child.stdin.end();
      let deadline: NodeJS.Timeout | undefined;
      let forceKill: NodeJS.Timeout | undefined;
      const clearLifecycle = () => {
        if (deadline) clearTimeout(deadline);
        signal?.removeEventListener("abort", onAbort);
      };
      const terminate = () => {
        if (child.exitCode !== null || child.signalCode !== null) return;
        child.kill("SIGTERM");
        if (!forceKill) {
          forceKill = setTimeout(() => child.kill("SIGKILL"), 250);
          forceKill.unref();
        }
      };
      const finish = (
        outcome:
          | { ok: true; exitCode: number }
          | { ok: false; error: ClaudeCodeRunnerError },
      ) => {
        if (settled) return;
        settled = true;
        clearLifecycle();
        if (!outcome.ok) {
          reject(outcome.error);
          return;
        }
        resolve({
          exitCode: outcome.exitCode,
          stdout: Buffer.concat(stdout).toString("utf8"),
          stderr: Buffer.concat(stderr).toString("utf8"),
          truncated,
        });
      };
      const capture = (target: Buffer[]) => (chunk: Buffer) => {
        if (settled || truncated) return;
        const remaining = this.maxOutputBytes - capturedBytes;
        if (chunk.length > remaining) {
          if (remaining > 0) target.push(chunk.subarray(0, remaining));
          capturedBytes = this.maxOutputBytes;
          truncated = true;
          terminate();
          return;
        }
        target.push(chunk);
        capturedBytes += chunk.length;
      };
      const onAbort = () => {
        terminate();
        if (settled) return;
        settled = true;
        clearLifecycle();
        reject(
          signal?.reason ??
            new DOMException("The Claude Code run was cancelled.", "AbortError"),
        );
      };
      deadline = setTimeout(() => {
        terminate();
        finish({
          ok: false,
          error: new ClaudeCodeRunnerError(
            "TIMEOUT",
            `Claude Code did not finish within ${this.timeoutMs}ms.`,
          ),
        });
      }, this.timeoutMs);
      deadline.unref();
      child.stdout.on("data", capture(stdout));
      child.stdout.on("data", logStreamEvents());
      child.stderr.on("data", capture(stderr));
      child.once("error", (error) =>
        finish({
          ok: false,
          error: new ClaudeCodeRunnerError(
            "UNAVAILABLE",
            "The claude CLI is unavailable.",
            { cause: error },
          ),
        }),
      );
      child.once("close", (code) => {
        if (forceKill) clearTimeout(forceKill);
        finish({ ok: true, exitCode: code ?? 1 });
      });
      if (signal?.aborted) onAbort();
      else signal?.addEventListener("abort", onAbort, { once: true });
    });
  }
}

/** Maps a thrown ClaudeCodeRunnerError to a skill failure code/message; rethrows anything else. */
export function claudeCodeRunnerErrorToFailure(
  error: unknown,
): { readonly code: string; readonly message: string } {
  if (!(error instanceof ClaudeCodeRunnerError)) throw error;
  switch (error.failure) {
    case "TIMEOUT":
      return {
        code: "DEVELOPER_EXECUTE_TIMEOUT",
        message: "Claude Code did not finish within its allotted time.",
      };
    case "EXECUTION_FAILED":
      return { code: "DEVELOPER_EXECUTE_FAILED", message: error.message };
    case "INVALID_RESPONSE":
      return {
        code: "DEVELOPER_EXECUTE_INVALID_RESPONSE",
        message: "Claude Code returned an unexpected response.",
      };
    case "CANCELLED":
      return {
        code: "DEVELOPER_EXECUTE_CANCELLED",
        message: "The Claude Code run was cancelled.",
      };
    case "ALREADY_RUNNING":
      return { code: "DEVELOPER_EXECUTE_ALREADY_RUNNING", message: error.message };
    default:
      return {
        code: "DEVELOPER_EXECUTE_UNAVAILABLE",
        message: "The claude CLI is unavailable.",
      };
  }
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

/** Finds the terminal "result" event in stream-json output (one JSON object per line). */
function lastResultEvent(stdout: string): unknown {
  let result: unknown;
  for (const line of stdout.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const parsed = parseJson(trimmed);
    if (isRecord(parsed) && parsed.type === "result") result = parsed;
  }
  return result;
}

/**
 * Returns a stdout data listener that incrementally parses stream-json's
 * newline-delimited events and logs Claude Code's reasoning as it happens —
 * thinking blocks, visible text, and tool calls — via console.log, the same
 * ad hoc tracing convention already used elsewhere in this codebase (e.g.
 * planner.ts). This is purely observational: it never affects the buffered
 * bytes capture() collects or the final result lastResultEvent() extracts.
 */
function logStreamEvents(): (chunk: Buffer) => void {
  let pending = "";
  return (chunk: Buffer) => {
    pending += chunk.toString("utf8");
    const lines = pending.split("\n");
    pending = lines.pop() ?? "";
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      logClaudeCodeEvent(parseJson(trimmed));
    }
  };
}

function logClaudeCodeEvent(event: unknown): void {
  if (!isRecord(event)) return;
  if (event.type === "assistant" && isRecord(event.message)) {
    const content = event.message.content;
    if (!Array.isArray(content)) return;
    for (const block of content) {
      if (!isRecord(block)) continue;
      if (block.type === "thinking" && typeof block.thinking === "string") {
        console.log("[claude-code thinking]", block.thinking);
      } else if (block.type === "text" && typeof block.text === "string") {
        console.log("[claude-code]", block.text);
      } else if (block.type === "tool_use") {
        console.log(
          "[claude-code tool_use]",
          block.name,
          JSON.stringify(block.input),
        );
      }
    }
  } else if (event.type === "result") {
    console.log("[claude-code result]", event);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
