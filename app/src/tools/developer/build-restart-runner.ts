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
  | "LIST_TIMEOUT"
  | "LIST_FAILED"
  | "LIST_PARSE_FAILED"
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
  /** Timeout for the read-only `pm2 jlist` status check. Defaults to 15s. */
  readonly listTimeoutMs?: number;
  readonly maxOutputBytes?: number;
  /**
   * The subprocess environment for `npm run build`, `pm2 restart`, and
   * `pm2 jlist`. Not scrubbed down, matching ClaudeCodeRunner — all three
   * commands need the same effective permissions as the OS user running
   * this agent.
   */
  readonly env: NodeJS.ProcessEnv;
  /** Test seams; production spawns the real binaries on PATH. */
  readonly npmCommand?: string;
  readonly pm2Command?: string;
}

/** A single PM2-managed process as reported by `pm2 jlist`. */
export interface Pm2ServiceStatus {
  readonly name: string;
  readonly pm2Id: number;
  readonly status: string;
  readonly pid: number | null;
  readonly restarts: number;
  readonly uptimeMs: number | null;
}

export interface Pm2ListResult {
  /** Only entries whose name was requested — pm2 jlist reports every
   * process on the host, and callers must never see services they didn't
   * ask about. */
  readonly services: readonly Pm2ServiceStatus[];
  readonly raw: string;
  readonly truncated: boolean;
}

const DEFAULT_MAX_OUTPUT_BYTES = 512 * 1024;
const DEFAULT_LIST_TIMEOUT_MS = 15_000;
const IGNORED_DIRECTORY_NAMES = new Set(["node_modules"]);

interface RawPm2ListEntry {
  readonly name?: unknown;
  readonly pm_id?: unknown;
  readonly pid?: unknown;
  readonly pm2_env?: {
    readonly status?: unknown;
    readonly restart_time?: unknown;
    readonly pm_uptime?: unknown;
  };
}

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
 * running service is left untouched. `restart` separately exposes a
 * standalone `pm2 restart <service>` for callers that want to restart a
 * service without rebuilding it, and `listStatus` exposes the read-only
 * `pm2 jlist` operational command, e.g. to confirm a service came back up
 * after a restart.
 */
export class BuildRestartRunner {
  private readonly buildTimeoutMs: number;
  private readonly restartTimeoutMs: number;
  private readonly listTimeoutMs: number;
  private readonly maxOutputBytes: number;
  private readonly env: NodeJS.ProcessEnv;
  private readonly npmCommand: string;
  private readonly pm2Command: string;

  constructor(options: BuildRestartRunnerOptions) {
    this.buildTimeoutMs = options.buildTimeoutMs;
    this.restartTimeoutMs = options.restartTimeoutMs;
    this.listTimeoutMs = options.listTimeoutMs ?? DEFAULT_LIST_TIMEOUT_MS;
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
    if (!Number.isInteger(this.listTimeoutMs) || this.listTimeoutMs < 1_000) {
      throw new RangeError(
        "BuildRestartRunner listTimeoutMs must be a positive integer of at least 1000ms.",
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

  /**
   * Runs `pm2 restart <service>` directly, without building first. Separate
   * from `run()` so a caller can restart a service that doesn't need a fresh
   * build applied, while still going through the same timeout/output-cap
   * machinery and RESTART_TIMEOUT/RESTART_FAILED/UNAVAILABLE failure codes.
   */
  async restart(
    pm2ServiceName: string,
    signal?: AbortSignal,
  ): Promise<{
    restartOutput: string;
    restartDurationMs: number;
    restartTruncated: boolean;
  }> {
    signal?.throwIfAborted();
    const restartStartedAt = performance.now();
    const restart = await this.spawnStep(
      this.pm2Command,
      ["restart", pm2ServiceName],
      process.cwd(),
      this.restartTimeoutMs,
      "RESTART_TIMEOUT",
      signal,
    );
    const restartDurationMs = Math.max(0, performance.now() - restartStartedAt);
    if (restart.exitCode !== 0) {
      throw new BuildRestartError(
        "RESTART_FAILED",
        `pm2 restart ${pm2ServiceName} exited with status ${restart.exitCode}.${
          restart.output ? ` Output: ${restart.output.slice(-2_000)}` : ""
        }`,
      );
    }
    return {
      restartOutput: restart.output,
      restartDurationMs,
      restartTruncated: restart.truncated,
    };
  }

  /**
   * Runs `pm2 jlist` (the machine-readable form of `pm2 list`/`pm2 status`)
   * and returns only the entries whose name is in `serviceNames` — pm2
   * reports every process the daemon manages, and this tool must never leak
   * status for a service the caller didn't ask about.
   */
  async listStatus(
    serviceNames: readonly string[],
    signal?: AbortSignal,
  ): Promise<Pm2ListResult> {
    signal?.throwIfAborted();
    const list = await this.spawnStep(
      this.pm2Command,
      ["jlist"],
      process.cwd(),
      this.listTimeoutMs,
      "LIST_TIMEOUT",
      signal,
    );
    if (list.exitCode !== 0) {
      throw new BuildRestartError(
        "LIST_FAILED",
        `pm2 jlist exited with status ${list.exitCode}.${
          list.output ? ` Output: ${list.output.slice(-2_000)}` : ""
        }`,
      );
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(list.output);
    } catch (error) {
      throw new BuildRestartError(
        "LIST_PARSE_FAILED",
        "pm2 jlist did not return valid JSON.",
        { cause: error },
      );
    }
    if (!Array.isArray(parsed)) {
      throw new BuildRestartError(
        "LIST_PARSE_FAILED",
        "pm2 jlist did not return a JSON array.",
      );
    }

    const requested = new Set(serviceNames);
    const services: Pm2ServiceStatus[] = [];
    for (const entry of parsed as RawPm2ListEntry[]) {
      if (typeof entry?.name !== "string" || !requested.has(entry.name)) continue;
      const pmUptime =
        typeof entry.pm2_env?.pm_uptime === "number" ? entry.pm2_env.pm_uptime : undefined;
      services.push({
        name: entry.name,
        pm2Id: typeof entry.pm_id === "number" ? entry.pm_id : -1,
        status:
          typeof entry.pm2_env?.status === "string" ? entry.pm2_env.status : "unknown",
        pid: typeof entry.pid === "number" ? entry.pid : null,
        restarts:
          typeof entry.pm2_env?.restart_time === "number" ? entry.pm2_env.restart_time : 0,
        uptimeMs: pmUptime !== undefined ? Math.max(0, Date.now() - pmUptime) : null,
      });
    }

    return { services, raw: list.output, truncated: list.truncated };
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
    case "LIST_TIMEOUT":
      return {
        code: "DEVELOPER_BUILD_RESTART_LIST_TIMEOUT",
        message: "pm2 jlist did not finish within its allotted time.",
      };
    case "LIST_FAILED":
      return { code: "DEVELOPER_BUILD_RESTART_LIST_FAILED", message: error.message };
    case "LIST_PARSE_FAILED":
      return { code: "DEVELOPER_BUILD_RESTART_LIST_PARSE_FAILED", message: error.message };
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
