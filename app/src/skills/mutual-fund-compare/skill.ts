import { z } from "zod";

import { defineSkill } from "../define-skill";
import { mutualFundErrorToFailure } from "../../finance/errors";
import { presentJson } from "../../finance/presentation";
import type { MutualFundAnalysisService } from "../../finance/services/mutual-fund-analysis.service";
import type { SkillContext, SkillResult } from "../types";

const inputSchema = z
  .object({
    schemeCodes: z
      .array(z.number().int().positive())
      .min(2)
      .max(10),
  })
  .strict();

export type MutualFundCompareInput = z.infer<typeof inputSchema>;

export function createMutualFundCompareSkill(
  analysis: MutualFundAnalysisService,
) {
  return defineSkill({
    name: "mutual_fund_compare",
    description:
      "Side-by-side NAV-derived metrics for up to 10 schemes. One scheme's upstream failure does not fail the whole comparison. Prefer comparing the same scheme category and the same Direct/Growth plan. Quantitative comparison is not a suitability assessment.",
    inputDescription: '{ "schemeCodes": [120503, 123456] }',
    inputSchema,
    execution: { mutability: "read", impact: "normal" },
    configured: true,
    async execute(
      input: MutualFundCompareInput,
      context: SkillContext,
    ): Promise<SkillResult<unknown>> {
      try {
        const compared = await analysis.compare(
          input.schemeCodes,
          context.signal,
        );
        return {
          success: true,
          data: presentJson({
            ...compared,
            quantitativeRankingOnly: true,
            disclaimer:
              "This is a NAV-derived quantitative comparison, not a complete investment suitability assessment. TER, AUM, holdings, manager tenure, and benchmark alpha are not included.",
          }),
        };
      } catch (error: unknown) {
        if (context.signal?.aborted) throw error;
        return { success: false, error: mutualFundErrorToFailure(error) };
      }
    },
  });
}
