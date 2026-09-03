import { z } from "zod";

import { defineSkill } from "../define-skill";
import type { SkillResult } from "../types";
import type { KiteClientPort, KiteHolding } from "../../tools/kite/types";

const inputSchema = z.object({});

export type TradingGetHoldingsInput = z.infer<typeof inputSchema>;
export interface TradingGetHoldingsOutput {
  readonly holdings: readonly KiteHolding[];
  readonly totalPnl: number;
}

/** Read-only: "what's my portfolio". Directly reads Kite's holdings; not part of the deterministic scanner. */
export function createTradingGetHoldingsSkill(client?: KiteClientPort) {
  return defineSkill<TradingGetHoldingsInput, TradingGetHoldingsOutput>({
    name: "trading_get_holdings",
    description:
      "Returns the user's current equity holdings (portfolio) from their Kite account, with each position's P&L and a total P&L.",
    inputDescription: "{} (no input required)",
    inputSchema,
    execution: { mutability: "read", impact: "normal" },
    configured: client !== undefined,
    async execute(): Promise<SkillResult<TradingGetHoldingsOutput>> {
      if (!client) {
        return {
          success: false,
          error: {
            code: "KITE_UNAVAILABLE",
            message: "Kite is not configured — set KITE_API_KEY/KITE_ACCESS_TOKEN.",
          },
        };
      }
      const holdings = await client.getHoldings();
      const totalPnl = holdings.reduce((sum, holding) => sum + holding.pnl, 0);
      return { success: true, data: { holdings, totalPnl } };
    },
  });
}
