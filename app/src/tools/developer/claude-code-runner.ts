import { spawn } from "node:child_process";

import { z } from "zod";

export type ClaudeCodeRunnerFailure =
  | "TIMEOUT"
  | "UNAVAILABLE"
  | "INVALID_RESPONSE"
  | "EXECUTION_FAILED"
  | "CANCELLED";

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
  private readonly command: string;
  private readonly env: NodeJS.ProcessEnv;

  constructor(options: ClaudeCodeRunnerOptions) {
    this.timeoutMs = options.timeoutMs;
    this.maxTurns = options.maxTurns;
    this.maxOutputBytes = options.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES;
    this.permissionMode = options.permissionMode;
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
      parseJson(spawned.stdout),
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
          "json",
          ...(this.permissionMode === "bypassPermissions"
            ? ["--dangerously-skip-permissions"]
            : ["--permission-mode", this.permissionMode]),
          "--max-turns",
          String(this.maxTurns),
        ],
        {
          cwd,
          shell: false,
          stdio: ["ignore", "pipe", "pipe"],
          env: this.env,
        },
      );
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
