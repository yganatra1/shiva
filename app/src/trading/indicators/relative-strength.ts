import type { Candle } from "../types";
import { calculateMomentum } from "./momentum";

/**
 * Relative strength here means: stock's N-period return MINUS the
 * benchmark's N-period return over the same window. This is NOT the RSI
 * oscillator (see rsi.ts for that) — it is a simple relative-performance
 * spread used to check whether a stock is outperforming the index.
 * Returns undefined if either leg lacks sufficient history.
 */
export function calculateRelativeStrength(
  candles: readonly Candle[],
  benchmarkCandles: readonly Candle[],
  lookbackDays: number,
): number | undefined {
  const stockReturn = calculateMomentum(candles, lookbackDays);
  const benchmarkReturn = calculateMomentum(benchmarkCandles, lookbackDays);
  if (stockReturn === undefined || benchmarkReturn === undefined) return undefined;
  return stockReturn - benchmarkReturn;
}
