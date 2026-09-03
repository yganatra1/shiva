import type { Candle } from "../types";

/** True range for candle `i` relative to the previous candle's close. */
export function trueRange(current: Candle, previous: Candle | undefined): number {
  if (!previous) return current.high - current.low;
  return Math.max(
    current.high - current.low,
    Math.abs(current.high - previous.close),
    Math.abs(current.low - previous.close),
  );
}

/**
 * Wilder's ATR(14) (or any configured period), computed over true range.
 * Returns undefined when there are fewer than `period + 1` candles.
 */
export function calculateAtr14(
  candles: readonly Candle[],
  period = 14,
): number | undefined {
  if (period <= 0 || candles.length < period + 1) return undefined;

  const trueRanges: number[] = [];
  for (let i = 1; i < candles.length; i += 1) {
    trueRanges.push(trueRange(candles[i] as Candle, candles[i - 1]));
  }

  let atr =
    trueRanges.slice(0, period).reduce((sum, value) => sum + value, 0) / period;
  for (let i = period; i < trueRanges.length; i += 1) {
    atr = (atr * (period - 1) + (trueRanges[i] as number)) / period;
  }
  return atr;
}
