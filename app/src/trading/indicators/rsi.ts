import type { Candle } from "../types";

/**
 * Wilder's RSI(14) (or any configured period). Returns undefined when there
 * are fewer than `period + 1` candles (need `period` deltas to seed).
 */
export function calculateRsi14(
  candles: readonly Candle[],
  period = 14,
): number | undefined {
  if (period <= 0 || candles.length < period + 1) return undefined;

  let gainSum = 0;
  let lossSum = 0;
  for (let i = 1; i <= period; i += 1) {
    const delta = (candles[i] as Candle).close - (candles[i - 1] as Candle).close;
    if (delta >= 0) gainSum += delta;
    else lossSum += -delta;
  }
  let avgGain = gainSum / period;
  let avgLoss = lossSum / period;

  for (let i = period + 1; i < candles.length; i += 1) {
    const delta = (candles[i] as Candle).close - (candles[i - 1] as Candle).close;
    const gain = delta >= 0 ? delta : 0;
    const loss = delta < 0 ? -delta : 0;
    avgGain = (avgGain * (period - 1) + gain) / period;
    avgLoss = (avgLoss * (period - 1) + loss) / period;
  }

  if (avgLoss === 0) return 100;
  const rs = avgGain / avgLoss;
  return 100 - 100 / (1 + rs);
}
