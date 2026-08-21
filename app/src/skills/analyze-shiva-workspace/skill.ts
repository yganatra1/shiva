import { z } from "zod";

import type { ShivaSkill, SkillResult } from "../types.js";
import {
  WorkspaceReaderError,
} from "../../tools/workspace/reader.js";
import type {
  WorkspaceAnalysis,
  WorkspaceReaderPort,
} from "../../tools/workspace/types.js";

const safePathSchema = z
  .string()
  .trim()
  .min(1)
  .max(500)
  .refine((value) => !value.includes("\0") && !value.includes("\\"));
const inputSchema = z
  .object({
    question: z.string().trim().min(2).max(1_000),
    paths: z.array(safePathSchema).max(8).optional(),
    searchTerms: z.array(z.string().trim().min(2).max(80)).max(8).optional(),
  })
  .strict();

export type AnalyzeShivaWorkspaceInput = z.infer<typeof inputSchema>;

export class AnalyzeShivaWorkspaceSkill
  implements ShivaSkill<AnalyzeShivaWorkspaceInput, WorkspaceAnalysis>
{
  readonly name = "analyze_shiva_workspace";
  readonly description =
    "Searches and reads safe text source/config files inside the Shiva repository to diagnose its implementation and identify exact files that should change. It is read-only and cannot access secrets or execute commands.";
  readonly inputDescription =
    '{ "question": string, "paths"?: [up to 8 repository-relative files to read], "searchTerms"?: [up to 8 literal terms] }';
  readonly inputSchema: z.ZodType<AnalyzeShivaWorkspaceInput> = inputSchema;
  readonly permissions = ["workspace.read"] as const;
  readonly configured = true;

  constructor(private readonly workspace: WorkspaceReaderPort) {}

  async execute(
    input: AnalyzeShivaWorkspaceInput,
    context: Parameters<ShivaSkill<AnalyzeShivaWorkspaceInput, WorkspaceAnalysis>["execute"]>[1],
  ): Promise<SkillResult<WorkspaceAnalysis>> {
    try {
      const analysis = await this.workspace.analyze({
        question: input.question,
        ...(input.paths ? { paths: input.paths } : {}),
        ...(input.searchTerms ? { searchTerms: input.searchTerms } : {}),
        ...(context.signal ? { signal: context.signal } : {}),
      });
      return { success: true, data: analysis };
    } catch (error: unknown) {
      if (context.signal?.aborted) throw error;
      if (error instanceof WorkspaceReaderError) {
        return {
          success: false,
          error: {
            code:
              error.failure === "PATH_DENIED"
                ? "WORKSPACE_PATH_DENIED"
                : error.failure === "NOT_FOUND"
                  ? "WORKSPACE_FILE_NOT_FOUND"
                  : "WORKSPACE_READ_FAILED",
            message:
              error.failure === "PATH_DENIED"
                ? "That workspace path is outside Shiva's safe read boundary."
                : error.failure === "NOT_FOUND"
                  ? "The requested Shiva workspace file was not found."
                  : "Shiva could not read the requested workspace file.",
          },
        };
      }
      throw error;
    }
  }
}
