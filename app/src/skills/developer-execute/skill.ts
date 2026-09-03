import { z } from "zod";

import { defineSkill } from "../define-skill";
import type { SkillContext, SkillResult } from "../types";
import {
  ClaudeCodeRunner,
  claudeCodeRunnerErrorToFailure,
  type ClaudeCodePermissionMode,
} from "../../tools/developer/claude-code-runner";

export interface DeveloperExecuteOutput {
  readonly repo: string;
  readonly sessionId?: string;
  readonly result: string;
  readonly isError: boolean;
  readonly exitCode: number;
  readonly durationMs: number;
  readonly truncated: boolean;
}

const PERMISSION_MODE_DESCRIPTIONS: Readonly<
  Record<ClaudeCodePermissionMode, string>
> = {
  bypassPermissions:
    "Claude Code has full read/write file and shell access inside that repository (runs with --dangerously-skip-permissions) — it can create, edit, or delete files and run arbitrary commands including git.",
  acceptEdits:
    "Claude Code can freely read, create, edit, and delete files inside that repository (runs with --permission-mode acceptEdits), but headless mode has no terminal to prompt on, so any command it would normally ask about (e.g. running git, tests, or other shell commands) is automatically denied rather than executed — it cannot silently do more than file edits.",
  plan:
    "Claude Code only plans in this mode (--permission-mode plan) — it can read the repository but every file edit and shell command is automatically denied, so it cannot make any actual change.",
  default:
    "Claude Code runs in its default permission mode; headless mode has no terminal to prompt on, so any action requiring approval is automatically denied rather than executed.",
};

export function createDeveloperExecuteSkill(
  repos: Readonly<Record<string, string>>,
  permissionMode: ClaudeCodePermissionMode,
  runner?: ClaudeCodeRunner,
) {
  const repoNames = Object.keys(repos);
  const inputSchema = z.object({
    repo:
      repoNames.length > 0
        ? z.enum(repoNames as [string, ...string[]])
        : z.string(),
    instruction: z.string().trim().min(1).max(8_000),
  });
  type DeveloperExecuteInput = z.infer<typeof inputSchema>;
  const permissionDescription = PERMISSION_MODE_DESCRIPTIONS[permissionMode];

  return defineSkill<DeveloperExecuteInput, DeveloperExecuteOutput>({
    name: "developer_execute",
    description:
      `Runs Claude Code (a full autonomous coding agent) against one configured repository to inspect, debug, modify, or test it. Configured repositories: ${
        repoNames.length > 0 ? repoNames.join(", ") : "(none)"
      }. ${permissionDescription} Give it exactly one well-scoped instruction; never ask it to push, deploy, restart, or reboot any service unless the user's original request explicitly asked for that. Its result is Claude Code's own report of what it did, not independently verified — relay it honestly rather than claiming the requested change is correct beyond what that report says.`,
    inputDescription: `{ "repo": ${
      repoNames.length > 0
        ? repoNames.map((name) => `"${name}"`).join(" | ")
        : "string"
    }, "instruction": string (one well-scoped task for Claude Code) }`,
    inputSchema,
    execution: {
      mutability: "write",
      impact: "sensitive",
      confirmationReason: `Runs Claude Code against a real repository. ${permissionDescription} This can modify Shiva's own code if the shiva repo is targeted.`,
    },
    configured: repoNames.length > 0 && runner !== undefined,
    async execute(
      input: DeveloperExecuteInput,
      context: SkillContext,
    ): Promise<SkillResult<DeveloperExecuteOutput>> {
      const repoPath = repos[input.repo];
      if (!runner || !repoPath) {
        return {
          success: false,
          error: {
            code: "DEVELOPER_AGENT_UNAVAILABLE",
            message: "Developer Agent is not configured for that repository.",
          },
        };
      }
      try {
        const result = await runner.run({
          repoPath,
          instruction: input.instruction,
          ...(context.signal ? { signal: context.signal } : {}),
        });
        return {
          success: true,
          data: {
            repo: input.repo,
            ...(result.sessionId ? { sessionId: result.sessionId } : {}),
            result: result.result,
            isError: result.isError,
            exitCode: result.exitCode,
            durationMs: result.durationMs,
            truncated: result.truncated,
          },
        };
      } catch (error: unknown) {
        if (context.signal?.aborted) throw error;
        return { success: false, error: claudeCodeRunnerErrorToFailure(error) };
      }
    },
  });
}
