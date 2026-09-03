import { z } from "zod";

import { defineSkill } from "../define-skill";
import type { SkillResult } from "../types";
import type { TradingService } from "../../trading/trading-service";
import type { TradeOpportunity } from "../../trading/types";

const inputSchema = z.object({
  minScore: z.number().min(0).max(100).optional(),
  strategy: z.string().trim().min(1).max(100).optional(),
  limit: z.number().int().min(1).max(200).optional(),
});

export type TradingGetOpportunitiesInput = z.infer<typeof inputSchema>;
export interface TradingGetOpportunitiesOutput {
  readonly opportunities: readonly TradeOpportunity[];
}

/**
 * Read-only: returns already-computed, deterministic opportunities from the
 * most recent persisted scan. Never computes or invents a score itself.
 */
export function createTradingGetOpportunitiesSkill(tradingService: TradingService) {
  return defineSkill<TradingGetOpportunitiesInput, TradingGetOpportunitiesOutput>({
    name: "trading_get_opportunities",
    description:
      "Lists ranked long-equity trade candidates from the most recent trading scan, optionally filtered by minimum score or strategy. Purely a read of already-computed deterministic output; it never generates a new score itself.",
    inputDescription:
      '{ "minScore"?: number 0-100, "strategy"?: "trend-momentum" | "breakout-volume", "limit"?: number }',
    inputSchema,
    execution: { mutability: "read", impact: "normal" },
    configured: true,
    async execute(
      input: TradingGetOpportunitiesInput,
    ): Promise<SkillResult<TradingGetOpportunitiesOutput>> {
      const opportunities = await tradingService.listOpportunities({
        ...(input.minScore !== undefined ? { minScore: input.minScore } : {}),
        ...(input.strategy !== undefined ? { strategy: input.strategy } : {}),
        ...(input.limit !== undefined ? { limit: input.limit } : {}),
      });
      return { success: true, data: { opportunities } };
    },
  });
}
