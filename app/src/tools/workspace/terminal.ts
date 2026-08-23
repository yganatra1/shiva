import { spawn } from "node:child_process";
import { realpath, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  isBlockedWorkspacePath,
  WORKSPACE_GIT_EXCLUDES,
  WORKSPACE_RG_EXCLUDES,
} from "./path-policy";

const DEFAULT_WORKSPACE_ROOT = fileURLToPath(
  new URL("../../../../", import.meta.url),
);
const DEFAULT_TIMEOUT_MS = 8_000;
const DEFAULT_MAX_OUTPUT_BYTES = 64 * 1024;
const MAX_ARGUMENTS = 32;
const MAX_ARGUMENT_LENGTH = 500;
const SAFE_EXECUTABLE_PATH =
  "/opt/homebrew/bin:/usr/local/bin:/usr/local/sbin:/usr/bin:/bin";
const ALLOWED_COMMANDS = ["pwd", "ls", "rg", "cat", "head", "tail", "wc", "git"] as const;
const RG_FLAGS_WITHOUT_VALUES = new Set([
  "--count",
  "--count-matches",
  "--files",
  "--files-with-matches",
  "--fixed-strings",
  "--ignore-case",
  "--json",
  "--line-number",
  "--multiline",
  "--no-messages",
  "--smart-case",
  "--stats",
  "--text",
  "--type-list",
  "-F",
  "-S",
  "-U",
  "-i",
  "-l",
  "-n",
]);
const RG_FLAGS_WITH_VALUES = new Set([
  "--after-context",
  "--before-context",
  "--context",
  "--max-count",
  "--type",
  "--type-not",
  "-A",
  "-B",
  "-C",
  "-T",
  "-m",
  "-t",
]);

export type WorkspaceTerminalCommand = (typeof ALLOWED_COMMANDS)[number];

export interface WorkspaceTerminalInput {
  readonly command: WorkspaceTerminalCommand;
  readonly args?: readonly string[];
  readonly signal?: AbortSignal;
}

export interface WorkspaceTerminalResult {
  readonly command: WorkspaceTerminalCommand;
  readonly args: readonly string[];
  readonly cwd: ".";
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
  readonly durationMs: number;
  readonly truncated: boolean;
}

export type WorkspaceTerminalFailure =
  | "COMMAND_DENIED"
  | "PATH_DENIED"
  | "TIMEOUT"
  | "UNAVAILABLE";

export class WorkspaceTerminalError extends Error {
  override readonly name = "WorkspaceTerminalError";

  constructor(
    readonly failure: WorkspaceTerminalFailure,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
  }
}

export interface WorkspaceTerminalOptions {
  readonly root?: string;
  readonly timeoutMs?: number;
  readonly maxOutputBytes?: number;
}

export class ReadOnlyWorkspaceTerminal {
  private readonly root: string;
  private readonly rootRealPath: Promise<string>;
  private readonly timeoutMs: number;
  private readonly maxOutputBytes: number;

  constructor(options: WorkspaceTerminalOptions = {}) {
    this.root = path.resolve(options.root ?? DEFAULT_WORKSPACE_ROOT);
    this.rootRealPath = realpath(this.root);
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.maxOutputBytes = options.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES;
    if (!Number.isInteger(this.timeoutMs) || this.timeoutMs < 100 || this.timeoutMs > 30_000) {
      throw new RangeError("Workspace terminal timeout must be 100-30000ms.");
    }
    if (
      !Number.isInteger(this.maxOutputBytes) ||
      this.maxOutputBytes < 1_024 ||
      this.maxOutputBytes > 256 * 1024
    ) {
      throw new RangeError("Workspace terminal output limit must be 1024-262144 bytes.");
    }
  }

  async execute(input: WorkspaceTerminalInput): Promise<WorkspaceTerminalResult> {
    input.signal?.throwIfAborted();
    const args = [...(input.args ?? [])];
    validateArgumentEnvelope(args);
    const prepared = await this.prepare(input.command, args);
    const startedAt = performance.now();
    const result = await this.spawn(prepared.command, prepared.args, input.signal);
    return {
      command: input.command,
      args,
      cwd: ".",
      exitCode: result.exitCode,
      stdout: result.stdout,
      stderr: result.stderr,
      durationMs: Math.max(0, performance.now() - startedAt),
      truncated: result.truncated,
    };
  }

  private async prepare(
    command: WorkspaceTerminalCommand,
    args: readonly string[],
  ): Promise<{ command: string; args: string[] }> {
    switch (command) {
      case "pwd":
        if (args.length > 0) throw denied("pwd does not accept arguments.");
        return { command: "pwd", args: [] };
      case "ls":
        return { command: "ls", args: await this.prepareLs(args) };
      case "cat":
        return { command: "cat", args: await this.prepareCat(args) };
      case "head":
      case "tail":
        return { command, args: await this.prepareHeadOrTail(args) };
      case "wc":
        return { command: "wc", args: await this.prepareWc(args) };
      case "rg":
        return { command: "rg", args: await this.prepareRg(args) };
      case "git":
        return { command: "git", args: await this.prepareGit(args) };
      default:
        throw denied("That workspace command is not permitted.");
    }
  }

  private async prepareLs(args: readonly string[]): Promise<string[]> {
    const prepared: string[] = [];
    const paths: string[] = [];
    for (const arg of args) {
      if (arg.startsWith("-")) {
        if (arg !== "--color=never" && !/^-[aldF1h]+$/.test(arg)) {
          throw denied("That ls option is not permitted.");
        }
        prepared.push(arg);
      } else {
        paths.push(await this.validateExistingPath(arg, true));
      }
    }
    prepared.push(...(paths.length > 0 ? paths : ["."]));
    return prepared;
  }

  private async prepareCat(args: readonly string[]): Promise<string[]> {
    const options = args.filter((arg) => arg.startsWith("-"));
    if (options.some((arg) => !/^-[nbs]+$/.test(arg))) {
      throw denied("That cat option is not permitted.");
    }
    const paths = args.filter((arg) => !arg.startsWith("-"));
    if (paths.length < 1 || paths.length > 8) {
      throw denied("cat requires 1-8 safe workspace files.");
    }
    return [
      ...options,
      ...(await Promise.all(paths.map((entry) => this.validateExistingPath(entry, false)))),
    ];
  }

  private async prepareHeadOrTail(args: readonly string[]): Promise<string[]> {
    const prepared: string[] = [];
    const paths: string[] = [];
    for (let index = 0; index < args.length; index += 1) {
      const arg = args[index] ?? "";
      if (arg === "-n") {
        const count = args[index + 1] ?? "";
        if (!/^\d{1,5}$/.test(count)) throw denied("Invalid line count.");
        prepared.push(arg, count);
        index += 1;
      } else if (arg.startsWith("-")) {
        throw denied("That head/tail option is not permitted.");
      } else {
        paths.push(await this.validateExistingPath(arg, false));
      }
    }
    if (paths.length < 1 || paths.length > 8) {
      throw denied("head/tail requires 1-8 safe workspace files.");
    }
    return [...prepared, ...paths];
  }

  private async prepareWc(args: readonly string[]): Promise<string[]> {
    const prepared: string[] = [];
    const paths: string[] = [];
    for (const arg of args) {
      if (arg.startsWith("-")) {
        if (!/^-[lwc]+$/.test(arg)) throw denied("That wc option is not permitted.");
        prepared.push(arg);
      } else {
        paths.push(await this.validateExistingPath(arg, false));
      }
    }
    if (paths.length < 1 || paths.length > 8) {
      throw denied("wc requires 1-8 safe workspace files.");
    }
    return [...prepared, ...paths];
  }

  private async prepareRg(args: readonly string[]): Promise<string[]> {
    if (args.length === 0) throw denied("rg requires a pattern or --files.");
    const prepared: string[] = [];
    const paths: string[] = [];
    let filesMode = false;
    let hasPattern = false;
    let positionalOnly = false;
    for (let index = 0; index < args.length; index += 1) {
      const arg = args[index] ?? "";
      if (!positionalOnly && arg === "--") {
        positionalOnly = true;
        continue;
      }
      if (!positionalOnly && arg.startsWith("-")) {
        if (RG_FLAGS_WITHOUT_VALUES.has(arg)) {
          if (arg === "--files") filesMode = true;
          prepared.push(arg);
          continue;
        }
        if (RG_FLAGS_WITH_VALUES.has(arg)) {
          const value = args[index + 1] ?? "";
          if (!isSafeRgOptionValue(arg, value)) {
            throw denied("That rg option value is not permitted.");
          }
          prepared.push(arg, value);
          index += 1;
          continue;
        }
        throw denied("That rg option is not permitted.");
      }
      if (!filesMode && !hasPattern) {
        hasPattern = true;
        prepared.push(arg);
      } else {
        paths.push(await this.validateExistingPath(arg, true));
      }
    }
    if (!filesMode && !hasPattern) throw denied("rg requires a search pattern.");
    return [
      "--no-config",
      "--color=never",
      "--hidden",
      "--no-ignore",
      "--glob-case-insensitive",
      ...WORKSPACE_RG_EXCLUDES.flatMap((pattern) => ["--glob", pattern]),
      ...prepared,
      "--",
      ...(paths.length > 0 ? paths : ["."]),
    ];
  }

  private async prepareGit(args: readonly string[]): Promise<string[]> {
    const [subcommand, ...rest] = args;
    if (!subcommand || !["status", "ls-files", "diff", "log", "grep"].includes(subcommand)) {
      throw denied("Only read-only git status, ls-files, diff, log, and grep are permitted.");
    }
    const prepared = ["--no-pager", "--no-optional-locks", subcommand];
    if (subcommand === "status") {
      if (rest.some((arg) => !["--short", "--branch", "--porcelain=v1"].includes(arg))) {
        throw denied("That git status option is not permitted.");
      }
      return [...prepared, ...rest];
    }
    if (subcommand === "ls-files") {
      if (rest.some((arg) => !["--cached", "--others", "--exclude-standard"].includes(arg))) {
        throw denied("That git ls-files option is not permitted.");
      }
      return [...prepared, ...rest];
    }
    if (subcommand === "log") {
      if (
        rest.some(
          (arg) =>
            !/^(?:--oneline|--stat|--name-only|--decorate|-[n]\d{1,3})$/.test(arg),
        )
      ) {
        throw denied("That git log option is not permitted.");
      }
      return [...prepared, ...rest];
    }
    if (subcommand === "grep") {
      return [...prepared, ...(await this.prepareGitGrep(rest))];
    }

    const separator = rest.indexOf("--");
    const options = separator >= 0 ? rest.slice(0, separator) : rest;
    const paths = separator >= 0 ? rest.slice(separator + 1) : [];
    if (
      options.some(
        (arg) =>
          ![
            "--stat",
            "--name-only",
            "--name-status",
            "--color=never",
            "--cached",
          ].includes(arg),
      )
    ) {
      throw denied("That git diff option is not permitted.");
    }
    return [
      ...prepared,
      "--no-ext-diff",
      "--no-textconv",
      ...options,
      "--",
      ...(paths.length > 0
        ? await Promise.all(
            paths.map((entry) => this.validateSyntacticPath(entry)),
          )
        : ["."]),
      ...WORKSPACE_GIT_EXCLUDES,
    ];
  }

  private async prepareGitGrep(args: readonly string[]): Promise<string[]> {
    const prepared: string[] = ["--no-color"];
    const paths: string[] = [];
    let hasPattern = false;
    let positionalOnly = false;
    for (const arg of args) {
      if (!positionalOnly && arg === "--") {
        positionalOnly = true;
        continue;
      }
      if (!positionalOnly && arg.startsWith("-")) {
        if (!["-n", "-i", "-F", "-l", "--line-number", "--ignore-case", "--fixed-strings", "--files-with-matches"].includes(arg)) {
          throw denied("That git grep option is not permitted.");
        }
        prepared.push(arg);
        continue;
      }
      if (!hasPattern) {
        hasPattern = true;
        prepared.push(arg);
      } else {
        paths.push(await this.validateExistingPath(arg, true));
      }
    }
    if (!hasPattern) throw denied("git grep requires a pattern.");
    return [
      ...prepared,
      "--",
      ...(paths.length > 0 ? paths : ["."]),
      ...WORKSPACE_GIT_EXCLUDES,
    ];
  }

  private async validateExistingPath(
    input: string,
    allowDirectory: boolean,
  ): Promise<string> {
    const relative = this.validateSyntacticPath(input);
    const absolute = path.join(this.root, relative);
    try {
      const [rootRealPath, targetRealPath, metadata] = await Promise.all([
        this.rootRealPath,
        realpath(absolute),
        stat(absolute),
      ]);
      if (
        targetRealPath !== rootRealPath &&
        !targetRealPath.startsWith(`${rootRealPath}${path.sep}`)
      ) {
        throw pathDenied();
      }
      const resolvedRelative = path
        .relative(rootRealPath, targetRealPath)
        .split(path.sep)
        .join("/");
      if (isBlockedWorkspacePath(resolvedRelative)) throw pathDenied();
      if (!allowDirectory && !metadata.isFile()) {
        throw pathDenied();
      }
      return relative;
    } catch (error: unknown) {
      if (error instanceof WorkspaceTerminalError) throw error;
      throw new WorkspaceTerminalError(
        "PATH_DENIED",
        "The requested workspace path is unavailable or outside the safe boundary.",
        { cause: error },
      );
    }
  }

  private validateSyntacticPath(input: string): string {
    const trimmed = input.trim();
    if (
      trimmed.length === 0 ||
      trimmed.includes("\0") ||
      trimmed.includes("\\") ||
      path.isAbsolute(trimmed)
    ) {
      throw pathDenied();
    }
    const normalized = path.posix.normalize(trimmed.replace(/^\.\//, ""));
    if (
      normalized === ".." ||
      normalized.startsWith("../") ||
      isBlockedWorkspacePath(normalized)
    ) {
      throw pathDenied();
    }
    return normalized;
  }

  private spawn(
    command: string,
    args: readonly string[],
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
      const child = spawn(command, args, {
        cwd: this.root,
        shell: false,
        stdio: ["ignore", "pipe", "pipe"],
        env: {
          PATH: SAFE_EXECUTABLE_PATH,
          LANG: "C",
          LC_ALL: "C",
          GIT_CONFIG_GLOBAL: "/dev/null",
          GIT_CONFIG_NOSYSTEM: "1",
          GIT_OPTIONAL_LOCKS: "0",
          GIT_PAGER: "cat",
        },
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
          | { ok: false; error: WorkspaceTerminalError },
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
            new DOMException("The workspace command was cancelled.", "AbortError"),
        );
      };
      deadline = setTimeout(() => {
        terminate();
        finish({
          ok: false,
          error: new WorkspaceTerminalError(
            "TIMEOUT",
            "The workspace command exceeded its deadline.",
          ),
        });
      }, this.timeoutMs);
      deadline.unref();
      child.stdout.on("data", capture(stdout));
      child.stderr.on("data", capture(stderr));
      child.once("error", (error) =>
        finish({
          ok: false,
          error: new WorkspaceTerminalError(
            "UNAVAILABLE",
            "The requested workspace command is unavailable.",
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

function validateArgumentEnvelope(args: readonly string[]): void {
  if (
    args.length > MAX_ARGUMENTS ||
    args.some(
      (arg) =>
        arg.length === 0 ||
        arg.length > MAX_ARGUMENT_LENGTH ||
        arg.includes("\0") ||
        arg.includes("\n") ||
        arg.includes("\r"),
    )
  ) {
    throw denied("The workspace command arguments are invalid.");
  }
}

function isSafeRgOptionValue(option: string, value: string): boolean {
  if (["-t", "-T", "--type", "--type-not"].includes(option)) {
    return /^[a-zA-Z0-9_+.-]{1,64}$/.test(value);
  }
  return /^\d{1,6}$/.test(value);
}

function denied(message: string): WorkspaceTerminalError {
  return new WorkspaceTerminalError("COMMAND_DENIED", message);
}

function pathDenied(): WorkspaceTerminalError {
  return new WorkspaceTerminalError(
    "PATH_DENIED",
    "The requested path is outside Shiva's safe workspace boundary.",
  );
}

export { ALLOWED_COMMANDS };
