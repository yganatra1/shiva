import type { Candle } from "../types";

/**
 * Standard exponential moving average of candle closes. Returns undefined
 * when there is not enough history (fewer than `period` candles) rather
 * than fabricating a value from partial data.
 */
export function calculateEma(
  candles: readonly Candle[],
  period: number,
): number | undefined {
  const series = calculateEmaSeries(candles, period);
  return series.length === 0 ? undefined : series[series.length - 1];
}

/**
 * Full EMA series aligned to `candles` (same length as the number of
 * candles from the first fully-seeded point onward). The first `period`
 * values are seeded with a simple moving average, matching common
 * charting-library convention.
 */
export function calculateEmaSeries(
  candles: readonly Candle[],
  period: number,
): number[] {
  if (period <= 0 || candles.length < period) return [];
  const multiplier = 2 / (period + 1);
  const seed =
    candles.slice(0, period).reduce((sum, candle) => sum + candle.close, 0) /
    period;
  const series: number[] = [seed];
  for (let i = period; i < candles.length; i += 1) {
    const previous = series[series.length - 1] as number;
    const next = (candles[i] as Candle).close * multiplier + previous * (1 - multiplier);
    series.push(next);
  }
  return series;
}
