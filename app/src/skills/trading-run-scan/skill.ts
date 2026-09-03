import { z } from "zod";

import { defineSkill } from "../define-skill";
import type { SkillResult } from "../types";
import type { TradingService } from "../../trading/trading-service";

const inputSchema = z.object({});

export type TradingRunScanInput = z.infer<typeof inputSchema>;
export interface TradingRunScanOutput {
  readonly scanId: string | undefined;
  readonly marketRegime: string;
  readonly analyzedInstruments: number;
  readonly opportunityCount: number;
}

/**
 * Triggers a fresh deterministic scan and persists it. Classified as
 * mutability:"write" (it changes durable state) but impact:"normal" rather
 * than "sensitive": it only computes and stores candidate scores from public
 * market data — it never touches money, orders, or any broker account
 * state, so it carries none of the risk a "sensitive" write implies.
 */
export function createTradingRunScanSkill(tradingService: TradingService) {
  return defineSkill<TradingRunScanInput, TradingRunScanOutput>({
    name: "trading_run_scan",
    description:
      "Runs a fresh deterministic scan of the configured instrument universe (trend/momentum and breakout strategies) and persists the result. Computes candidate long-equity opportunities only; it never places an order.",
    inputDescription: "{} (no input required)",
    inputSchema,
    execution: { mutability: "write", impact: "normal" },
    configured: true,
    async execute(): Promise<SkillResult<TradingRunScanOutput>> {
      const scan = await tradingService.runScan();
      return {
        success: true,
        data: {
          scanId: scan.scanId,
          marketRegime: scan.marketRegime.regime,
          analyzedInstruments: scan.analyzedInstruments,
          opportunityCount: scan.opportunities.length,
        },
      };
    },
  });
}
