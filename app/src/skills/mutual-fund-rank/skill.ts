import { z } from "zod";

import { defineSkill } from "../define-skill";
import { mutualFundErrorToFailure } from "../../finance/errors";
import { presentJson } from "../../finance/presentation";
import type { MutualFundRankingService } from "../../finance/services/mutual-fund-ranking.service";
import type { SkillContext, SkillResult } from "../types";

const inputSchema = z
  .object({
    category: z.string().trim().min(2).max(200),
    plan: z.enum(["direct", "regular", "unknown"]).default("direct"),
    option: z.enum(["growth", "idcw", "dividend", "unknown"]).default("growth"),
    timeHorizonYears: z.union([z.literal(1), z.literal(3), z.literal(5), z.literal(7)]).default(5),
    limit: z.number().int().min(1).max(25).default(10),
  })
  .strict();

export type MutualFundRankInput = z.infer<typeof inputSchema>;

export function createMutualFundRankSkill(ranking: MutualFundRankingService) {
  return defineSkill({
    name: "mutual_fund_rank",
    description:
      "Ranks Direct Growth funds inside one scheme category using peer-relative NAV metrics (rolling returns, consistency, drawdown, Sortino, Sharpe, volatility). Never mix ELSS with Flexi Cap/Small Cap/etc. Young schemes without the requested history are excluded rather than scored as zero. The score is a quantitative ranking, not a complete suitability assessment, and does not include TER, AUM, holdings, or benchmark alpha.",
    inputDescription:
      '{ "category": "Equity Schemes - ELSS- Tax Saver Fund" | "ELSS", "plan"?: "direct", "option"?: "growth", "timeHorizonYears"?: 1|3|5|7 (default 5), "limit"?: 1-25 (default 10) }',
    inputSchema,
    execution: { mutability: "read", impact: "normal" },
    configured: true,
    async execute(
      input: MutualFundRankInput,
      context: SkillContext,
    ): Promise<SkillResult<unknown>> {
      try {
        const ranked = await ranking.rank(
          {
            category: input.category,
            plan: input.plan,
            option: input.option,
            timeHorizonYears: input.timeHorizonYears,
            limit: input.limit,
          },
          context.signal,
        );
        return { success: true, data: presentJson(ranked) };
      } catch (error: unknown) {
        if (context.signal?.aborted) throw error;
        return { success: false, error: mutualFundErrorToFailure(error) };
      }
    },
  });
}
