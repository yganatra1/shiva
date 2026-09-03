import type { Candle } from "../types";

/**
 * Average volume over the `period` candles immediately preceding the most
 * recent candle — the current/most-recent candle is EXCLUDED to avoid
 * look-ahead bias (a stock cannot be screened against its own still-forming
 * or same-day volume).
 */
export function averageVolume(
  candles: readonly Candle[],
  period: number,
): number | undefined {
  if (period <= 0 || candles.length < period + 1) return undefined;
  const window = candles.slice(candles.length - 1 - period, candles.length - 1);
  return window.reduce((sum, candle) => sum + candle.volume, 0) / period;
}

/**
 * Highest high over the `period` candles immediately preceding the most
 * recent candle — the current/most-recent candle is EXCLUDED. This is what
 * makes a breakout check ("close > previous N-day high") valid instead of
 * comparing a candle's high against a window that includes itself.
 */
export function highestHigh(
  candles: readonly Candle[],
  period: number,
): number | undefined {
  if (period <= 0 || candles.length < period + 1) return undefined;
  const window = candles.slice(candles.length - 1 - period, candles.length - 1);
  return window.reduce((max, candle) => Math.max(max, candle.high), -Infinity);
}
