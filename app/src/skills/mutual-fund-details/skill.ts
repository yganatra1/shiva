import { z } from "zod";

import { defineSkill } from "../define-skill";
import { mutualFundErrorToFailure } from "../../finance/errors";
import { presentJson } from "../../finance/presentation";
import type { MutualFundAnalysisService } from "../../finance/services/mutual-fund-analysis.service";
import type { SkillContext, SkillResult } from "../types";

const inputSchema = z
  .object({
    schemeCode: z.number().int().positive(),
    includeNav: z.boolean().default(false),
  })
  .strict();

export type MutualFundDetailsInput = z.infer<typeof inputSchema>;

export function createMutualFundDetailsSkill(
  analysis: MutualFundAnalysisService,
) {
  return defineSkill({
    name: "mutual_fund_details",
    description:
      "Returns scheme metadata, latest NAV, inception date inferred from NAV history, history length, and observation count. Does not return the full NAV array unless includeNav is true. Does not calculate performance metrics.",
    inputDescription:
      '{ "schemeCode": 120503, "includeNav"?: false }',
    inputSchema,
    execution: { mutability: "read", impact: "normal" },
    configured: true,
    async execute(
      input: MutualFundDetailsInput,
      context: SkillContext,
    ): Promise<SkillResult<unknown>> {
      try {
        const details = await analysis.details(input.schemeCode, {
          includeNav: input.includeNav,
          ...(context.signal ? { signal: context.signal } : {}),
        });
        return { success: true, data: presentJson(details) };
      } catch (error: unknown) {
        if (context.signal?.aborted) throw error;
        return { success: false, error: mutualFundErrorToFailure(error) };
      }
    },
  });
}
