import { z } from "zod";

import { defineSkill } from "../define-skill";
import type { SkillResult } from "../types";
import type { TradingService } from "../../trading/trading-service";
import type { MarketRegimeResult } from "../../trading/types";

const inputSchema = z.object({});

export type TradingGetLatestScanInput = z.infer<typeof inputSchema>;
export type TradingGetLatestScanOutput =
  | {
      readonly found: true;
      readonly scanId: string | undefined;
      readonly startedAt: string;
      readonly completedAt: string;
      readonly benchmark: string;
      readonly marketRegime: MarketRegimeResult;
      readonly totalInstruments: number;
      readonly analyzedInstruments: number;
      readonly skippedInstruments: number;
      readonly failedInstruments: number;
      readonly opportunityCount: number;
    }
  | { readonly found: false };

/**
 * Read-only scan summary (regime, counts, timing) WITHOUT dumping every
 * opportunity — use trading_get_opportunities for the ranked list itself.
 */
export function createTradingGetLatestScanSkill(tradingService: TradingService) {
  return defineSkill<TradingGetLatestScanInput, TradingGetLatestScanOutput>({
    name: "trading_get_latest_scan",
    description:
      "Returns a summary of the most recent trading scan: market regime, instrument counts, and timing. Does not include the full opportunity list; use trading_get_opportunities for that.",
    inputDescription: "{} (no input required)",
    inputSchema,
    execution: { mutability: "read", impact: "normal" },
    configured: true,
    async execute(): Promise<SkillResult<TradingGetLatestScanOutput>> {
      const scan = await tradingService.getLatestScan();
      if (!scan) return { success: true, data: { found: false } };
      return {
        success: true,
        data: {
          found: true,
          scanId: scan.scanId,
          startedAt: scan.startedAt,
          completedAt: scan.completedAt,
          benchmark: scan.benchmark,
          marketRegime: scan.marketRegime,
          totalInstruments: scan.totalInstruments,
          analyzedInstruments: scan.analyzedInstruments,
          skippedInstruments: scan.skippedInstruments,
          failedInstruments: scan.failedInstruments,
          opportunityCount: scan.opportunities.length,
        },
      };
    },
  });
}
