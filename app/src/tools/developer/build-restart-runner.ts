import { spawn } from "node:child_process";
import { readdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";

export type BuildRestartFailure =
  | "PACKAGE_JSON_NOT_FOUND"
  | "BUILD_TIMEOUT"
  | "BUILD_FAILED"
  | "RESTART_TIMEOUT"
  | "RESTART_FAILED"
  | "UNAVAILABLE"
  | "CANCELLED";

export class BuildRestartError extends Error {
  override readonly name = "BuildRestartError";

  constructor(
    readonly failure: BuildRestartFailure,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
  }
}

export interface BuildRestartInput {
  readonly repoPath: string;
  readonly pm2ServiceName: string;
  readonly signal?: AbortSignal;
}

export interface BuildRestartResult {
  readonly buildDir: string;
  readonly buildOutput: string;
  readonly buildDurationMs: number;
  readonly buildTruncated: boolean;
  readonly restarted: boolean;
  readonly restartOutput: string;
  readonly restartDurationMs: number;
  readonly restartTruncated: boolean;
}

export interface BuildRestartRunnerOptions {
  readonly buildTimeoutMs: number;
  readonly restartTimeoutMs: number;
  readonly maxOutputBytes?: number;
  /**
   * The subprocess environment for both `npm run build` and `pm2 restart`.
   * Not scrubbed down, matching ClaudeCodeRunner — both commands need the
   * same effective permissions as the OS user running this agent.
   */
  readonly env: NodeJS.ProcessEnv;
  /** Test seams; production spawns the real binaries on PATH. */
  readonly npmCommand?: string;
  readonly pm2Command?: string;
}

const DEFAULT_MAX_OUTPUT_BYTES = 512 * 1024;
const IGNORED_DIRECTORY_NAMES = new Set(["node_modules"]);

/**
 * Finds the single directory under `repoPath` that contains a package.json,
 * checking `repoPath` itself first and then its immediate subdirectories
 * (one level deep, skipping hidden directories and node_modules). Returns
 * undefined if none or more than one candidate is found — this deliberately
 * never recurses further, so it can't wander into an unrelated nested
 * package.json (e.g. a dependency vendored into the repo).
 */
async function findPackageJsonDir(repoPath: string): Promise<string | undefined> {
  if (existsSync(join(repoPath, "package.json"))) return repoPath;
  const entries = await readdir(repoPath, { withFileTypes: true });
  const candidates: string[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    if (entry.name.startsWith(".") || IGNORED_DIRECTORY_NAMES.has(entry.name)) {
      continue;
    }
    const candidate = join(repoPath, entry.name);
    if (existsSync(join(candidate, "package.json"))) candidates.push(candidate);
  }
  return candidates.length === 1 ? candidates[0] : undefined;
}

/**
 * Runs `npm run build` in the directory containing package.json inside a
 * configured repository, then `pm2 restart <service>` — but only if the
 * build succeeded. A failed build never reaches the restart step, so the
 * running service is left untouched.
 */
export class BuildRestartRunner {
  private readonly buildTimeoutMs: number;
  private readonly restartTimeoutMs: number;
  private readonly maxOutputBytes: number;
  private readonly env: NodeJS.ProcessEnv;
  private readonly npmCommand: string;
  private readonly pm2Command: string;

  constructor(options: BuildRestartRunnerOptions) {
    this.buildTimeoutMs = options.buildTimeoutMs;
    this.restartTimeoutMs = options.restartTimeoutMs;
    this.maxOutputBytes = options.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES;
    this.env = options.env;
    this.npmCommand = options.npmCommand ?? "npm";
    this.pm2Command = options.pm2Command ?? "pm2";
    if (!Number.isInteger(this.buildTimeoutMs) || this.buildTimeoutMs < 1_000) {
      throw new RangeError(
        "BuildRestartRunner buildTimeoutMs must be a positive integer of at least 1000ms.",
      );
    }
    if (!Number.isInteger(this.restartTimeoutMs) || this.restartTimeoutMs < 1_000) {
      throw new RangeError(
        "BuildRestartRunner restartTimeoutMs must be a positive integer of at least 1000ms.",
      );
    }
  }

  async run(input: BuildRestartInput): Promise<BuildRestartResult> {
    input.signal?.throwIfAborted();
    const buildDir = await findPackageJsonDir(input.repoPath);
    if (!buildDir) {
      throw new BuildRestartError(
        "PACKAGE_JSON_NOT_FOUND",
        `Could not find a single directory containing package.json under ${input.repoPath}.`,
      );
    }

    const buildStartedAt = performance.now();
    const build = await this.spawnStep(
      this.npmCommand,
      ["run", "build"],
      buildDir,
      this.buildTimeoutMs,
      "BUILD_TIMEOUT",
      input.signal,
    );
    const buildDurationMs = Math.max(0, performance.now() - buildStartedAt);
    if (build.exitCode !== 0) {
      throw new BuildRestartError(
        "BUILD_FAILED",
        `npm run build exited with status ${build.exitCode} in ${buildDir}.${
          build.output ? ` Output: ${build.output.slice(-4_000)}` : ""
        }`,
      );
    }

    const restartStartedAt = performance.now();
    const restart = await this.spawnStep(
      this.pm2Command,
      ["restart", input.pm2ServiceName],
      buildDir,
      this.restartTimeoutMs,
      "RESTART_TIMEOUT",
      input.signal,
    );
    const restartDurationMs = Math.max(0, performance.now() - restartStartedAt);
    if (restart.exitCode !== 0) {
      throw new BuildRestartError(
        "RESTART_FAILED",
        `pm2 restart ${input.pm2ServiceName} exited with status ${restart.exitCode}.${
          restart.output ? ` Output: ${restart.output.slice(-2_000)}` : ""
        }`,
      );
    }

    return {
      buildDir,
      buildOutput: build.output,
      buildDurationMs,
      buildTruncated: build.truncated,
      restarted: true,
      restartOutput: restart.output,
      restartDurationMs,
      restartTruncated: restart.truncated,
    };
  }

  private spawnStep(
    command: string,
    args: readonly string[],
    cwd: string,
    timeoutMs: number,
    timeoutFailure: BuildRestartFailure,
    signal?: AbortSignal,
  ): Promise<{ exitCode: number; output: string; truncated: boolean }> {
    return new Promise((resolve, reject) => {
      let settled = false;
      let truncated = false;
      let capturedBytes = 0;
      const output: Buffer[] = [];
      const child = spawn(command, args, {
        cwd,
        shell: false,
        stdio: ["ignore", "pipe", "pipe"],
        env: this.env,
      });
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
          | { ok: false; error: BuildRestartError },
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
          output: Buffer.concat(output).toString("utf8"),
          truncated,
        });
      };
      const capture = (chunk: Buffer) => {
        if (settled || truncated) return;
        const remaining = this.maxOutputBytes - capturedBytes;
        if (chunk.length > remaining) {
          if (remaining > 0) output.push(chunk.subarray(0, remaining));
          capturedBytes = this.maxOutputBytes;
          truncated = true;
          return;
        }
        output.push(chunk);
        capturedBytes += chunk.length;
      };
      const onAbort = () => {
        terminate();
        if (settled) return;
        settled = true;
        clearLifecycle();
        reject(
          signal?.reason ??
            new DOMException("The build/restart run was cancelled.", "AbortError"),
        );
      };
      deadline = setTimeout(() => {
        terminate();
        finish({
          ok: false,
          error: new BuildRestartError(
            timeoutFailure,
            `${command} ${args.join(" ")} did not finish within ${timeoutMs}ms.`,
          ),
        });
      }, timeoutMs);
      deadline.unref();
      child.stdout.on("data", capture);
      child.stderr.on("data", capture);
      child.once("error", (error) =>
        finish({
          ok: false,
          error: new BuildRestartError(
            "UNAVAILABLE",
            `The ${command} command is unavailable.`,
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

/** Maps a thrown BuildRestartError to a skill failure code/message; rethrows anything else. */
export function buildRestartRunnerErrorToFailure(
  error: unknown,
): { readonly code: string; readonly message: string } {
  if (!(error instanceof BuildRestartError)) throw error;
  switch (error.failure) {
    case "PACKAGE_JSON_NOT_FOUND":
      return {
        code: "DEVELOPER_BUILD_RESTART_NO_PACKAGE_JSON",
        message: error.message,
      };
    case "BUILD_TIMEOUT":
      return {
        code: "DEVELOPER_BUILD_RESTART_BUILD_TIMEOUT",
        message: "npm run build did not finish within its allotted time.",
      };
    case "BUILD_FAILED":
      return { code: "DEVELOPER_BUILD_RESTART_BUILD_FAILED", message: error.message };
    case "RESTART_TIMEOUT":
      return {
        code: "DEVELOPER_BUILD_RESTART_RESTART_TIMEOUT",
        message: "pm2 restart did not finish within its allotted time.",
      };
    case "RESTART_FAILED":
      return { code: "DEVELOPER_BUILD_RESTART_RESTART_FAILED", message: error.message };
    case "CANCELLED":
      return {
        code: "DEVELOPER_BUILD_RESTART_CANCELLED",
        message: "The build/restart run was cancelled.",
      };
    default:
      return {
        code: "DEVELOPER_BUILD_RESTART_UNAVAILABLE",
        message: error.message,
      };
  }
}
