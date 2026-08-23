import { z } from "zod";

import { sanitizeAuditText } from "../../security/audit-sanitizer";
import type { ShivaSkill, SkillResult } from "../types";
import type {
  WorkspaceOverview,
  WorkspaceReaderPort,
} from "../../tools/workspace/types";

const inputSchema = z
  .object({
    focus: z.string().trim().min(2).max(300).optional(),
  })
  .strict();

export type LearnAboutShivaInput = z.infer<typeof inputSchema>;

export class LearnAboutShivaSkill
  implements ShivaSkill<LearnAboutShivaInput, WorkspaceOverview>
{
  readonly name = "learn_about_shiva";
  readonly description =
    "Reads a safe, bounded snapshot of Shiva's repository structure and core project documentation so Shiva can accurately explain itself.";
  readonly inputDescription =
    '{ "focus"?: "optional topic to locate in Shiva documentation/source" }';
  readonly inputSchema: z.ZodType<LearnAboutShivaInput> = inputSchema;
  readonly pack = "core";
  readonly execution = { mutability: "read", impact: "normal" } as const;
  readonly configured = true;

  constructor(private readonly workspace: WorkspaceReaderPort) {}

  async execute(
    input: LearnAboutShivaInput,
    context: Parameters<ShivaSkill<LearnAboutShivaInput, WorkspaceOverview>["execute"]>[1],
  ): Promise<SkillResult<WorkspaceOverview>> {
    const overview = await this.workspace.overview(input.focus, context.signal);
    return {
      success: true,
      data: {
        ...overview,
        documents: overview.documents.map((document) => ({
          ...document,
          content: sanitizeAuditText(document.content, 12_000),
        })),
        matches: overview.matches.map((match) => ({
          ...match,
          excerpt: sanitizeAuditText(match.excerpt, 240),
        })),
      },
    };
  }
}
