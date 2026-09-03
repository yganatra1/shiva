import type { Candle } from "../types";

/**
 * Momentum over N trading days: (close_t / close_t-N - 1), using the most
 * recent candle as close_t. Returns undefined without N+1 candles of
 * history.
 */
export function calculateMomentum(
  candles: readonly Candle[],
  lookbackDays: number,
): number | undefined {
  if (lookbackDays <= 0 || candles.length < lookbackDays + 1) return undefined;
  const latest = candles[candles.length - 1] as Candle;
  const past = candles[candles.length - 1 - lookbackDays] as Candle;
  if (past.close === 0) return undefined;
  return latest.close / past.close - 1;
}
