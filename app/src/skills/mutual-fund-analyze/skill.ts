import { z } from "zod";

import { defineSkill } from "../define-skill";
import { mutualFundErrorToFailure } from "../../finance/errors";
import { presentJson } from "../../finance/presentation";
import type { MutualFundAnalysisService } from "../../finance/services/mutual-fund-analysis.service";
import type { SkillContext, SkillResult } from "../types";

const inputSchema = z
  .object({
    schemeCode: z.number().int().positive(),
    includeSeries: z.boolean().default(false),
  })
  .strict();

export type MutualFundAnalyzeInput = z.infer<typeof inputSchema>;

export function createMutualFundAnalyzeSkill(
  analysis: MutualFundAnalysisService,
) {
  return defineSkill({
    name: "mutual_fund_analyze",
    description:
      "Returns NAV-derived trailing returns, rolling-return statistics, volatility, max drawdown, Sharpe, Sortino, calendar-year returns, and consistency metrics calculated in TypeScript. Never invent missing TER/AUM/holdings/benchmark data. Skip windows the scheme is too young for. This is quantitative research, not investment advice.",
    inputDescription:
      '{ "schemeCode": 120503, "includeSeries"?: false }',
    inputSchema,
    execution: { mutability: "read", impact: "normal" },
    configured: true,
    async execute(
      input: MutualFundAnalyzeInput,
      context: SkillContext,
    ): Promise<SkillResult<unknown>> {
      try {
        const snapshot = await analysis.analyze(input.schemeCode, {
          includeRollingSeries: input.includeSeries,
          ...(context.signal ? { signal: context.signal } : {}),
        });
        return { success: true, data: presentJson(snapshot) };
      } catch (error: unknown) {
        if (context.signal?.aborted) throw error;
        return { success: false, error: mutualFundErrorToFailure(error) };
      }
    },
  });
}
