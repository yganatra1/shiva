import { z } from "zod";

import { sanitizeAuditText } from "../../security/audit-sanitizer.js";
import type { ShivaSkill, SkillResult } from "../types.js";
import {
  ALLOWED_COMMANDS,
  WorkspaceTerminalError,
  type ReadOnlyWorkspaceTerminal,
  type WorkspaceTerminalCommand,
  type WorkspaceTerminalResult,
} from "../../tools/workspace/terminal.js";

const inputSchema = z
  .object({
    command: z.enum(ALLOWED_COMMANDS),
    args: z.array(z.string().min(1).max(500)).max(32).default([]),
  })
  .strict();

export interface WorkspaceTerminalSkillInput {
  readonly command: WorkspaceTerminalCommand;
  readonly args?: readonly string[];
}

export class WorkspaceTerminalSkill
  implements ShivaSkill<WorkspaceTerminalSkillInput, WorkspaceTerminalResult>
{
  readonly name = "workspace_terminal";
  readonly description =
    "Runs one bounded read-only terminal inspection command inside the Shiva repository. Use repeated calls to explore files, search source, read relevant text, and inspect Git state before diagnosing the project.";
  readonly inputDescription =
    '{ "command": "pwd|ls|rg|cat|head|tail|wc|git", "args"?: [literal arguments]; git permits status/ls-files/diff/log/grep only; safe source/documentation access excludes credentials and runtime-private paths; no shell, writes, or paths outside Shiva }';
  readonly inputSchema: z.ZodType<WorkspaceTerminalSkillInput> = inputSchema;
  readonly execution = { mutability: "read", impact: "normal" } as const;
  readonly configured = true;

  constructor(private readonly terminal: ReadOnlyWorkspaceTerminal) {}

  async execute(
    input: WorkspaceTerminalSkillInput,
    context: Parameters<ShivaSkill<WorkspaceTerminalSkillInput, WorkspaceTerminalResult>["execute"]>[1],
  ): Promise<SkillResult<WorkspaceTerminalResult>> {
    try {
      const result = await this.terminal.execute({
        command: input.command,
        args: input.args ?? [],
        ...(context.signal ? { signal: context.signal } : {}),
      });
      return {
        success: true,
        data: {
          ...result,
          stdout: sanitizeAuditText(result.stdout, 64 * 1024),
          stderr: sanitizeAuditText(result.stderr, 64 * 1024),
        },
      };
    } catch (error: unknown) {
      if (context.signal?.aborted) throw error;
      if (error instanceof WorkspaceTerminalError) {
        context.reportAuditDiagnostic?.({
          category: error.failure,
          reason: error.message,
        });
        return {
          success: false,
          error: {
            code:
              error.failure === "PATH_DENIED"
                ? "WORKSPACE_PATH_DENIED"
                : error.failure === "TIMEOUT"
                  ? "WORKSPACE_COMMAND_TIMEOUT"
                  : error.failure === "UNAVAILABLE"
                    ? "WORKSPACE_COMMAND_UNAVAILABLE"
                    : "WORKSPACE_COMMAND_DENIED",
            message:
              error.failure === "PATH_DENIED"
                ? "That path is outside Shiva's safe workspace boundary."
                : error.failure === "TIMEOUT"
                  ? "The workspace command exceeded its safe execution time."
                  : error.failure === "UNAVAILABLE"
                    ? "That workspace inspection command is unavailable."
                    : "That terminal command is not allowed by the read-only workspace policy.",
          },
        };
      }
      throw error;
    }
  }
}
