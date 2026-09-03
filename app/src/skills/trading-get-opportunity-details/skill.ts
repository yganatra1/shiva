import { z } from "zod";

import { defineSkill } from "../define-skill";
import type { SkillResult } from "../types";
import type { TradingService } from "../../trading/trading-service";
import type { TradeOpportunity } from "../../trading/types";

const inputSchema = z.object({
  tradingsymbol: z.string().trim().min(1).max(64),
});

export type TradingGetOpportunityDetailsInput = z.infer<typeof inputSchema>;
export type TradingGetOpportunityDetailsOutput =
  | { readonly found: true; readonly opportunity: TradeOpportunity }
  | { readonly found: false };

/**
 * Read-only explainability lookup: returns the full deterministic reasons,
 * metrics, and component scores behind one symbol's opportunity, exactly as
 * computed by the scanner. When asked "why is X ranked highly", relay these
 * `reasons` verbatim/paraphrased — never fabricate new ones.
 */
export function createTradingGetOpportunityDetailsSkill(
  tradingService: TradingService,
) {
  return defineSkill<
    TradingGetOpportunityDetailsInput,
    TradingGetOpportunityDetailsOutput
  >({
    name: "trading_get_opportunity_details",
    description:
      "Returns the full deterministic breakdown (reasons, metrics, component scores) behind one tradingsymbol's most recent opportunity, for explaining why it is ranked the way it is. Never invents reasons beyond what this returns.",
    inputDescription: '{ "tradingsymbol": string }',
    inputSchema,
    execution: { mutability: "read", impact: "normal" },
    configured: true,
    async execute(
      input: TradingGetOpportunityDetailsInput,
    ): Promise<SkillResult<TradingGetOpportunityDetailsOutput>> {
      const opportunity = await tradingService.getOpportunity(input.tradingsymbol);
      if (!opportunity) return { success: true, data: { found: false } };
      return { success: true, data: { found: true, opportunity } };
    },
  });
}
