import type { Candle } from "../types";
import { trueRange } from "./atr";

export interface AdxResult {
  readonly adx: number;
  readonly plusDi: number;
  readonly minusDi: number;
}

/**
 * Wilder's ADX(14) (or any configured period), with +DI/-DI/DX intermediate
 * values. Needs roughly 2*period candles to produce one seeded ADX value
 * (period candles to seed the smoothed +DM/-DM/TR, then period more DX
 * values to seed the ADX average); returns undefined otherwise.
 */
export function calculateAdx14(
  candles: readonly Candle[],
  period = 14,
): AdxResult | undefined {
  if (period <= 0 || candles.length < period * 2 + 1) return undefined;

  const plusDm: number[] = [];
  const minusDm: number[] = [];
  const trueRanges: number[] = [];
  for (let i = 1; i < candles.length; i += 1) {
    const current = candles[i] as Candle;
    const previous = candles[i - 1] as Candle;
    const upMove = current.high - previous.high;
    const downMove = previous.low - current.low;
    plusDm.push(upMove > downMove && upMove > 0 ? upMove : 0);
    minusDm.push(downMove > upMove && downMove > 0 ? downMove : 0);
    trueRanges.push(trueRange(current, previous));
  }

  let smoothedPlusDm =
    plusDm.slice(0, period).reduce((sum, value) => sum + value, 0);
  let smoothedMinusDm =
    minusDm.slice(0, period).reduce((sum, value) => sum + value, 0);
  let smoothedTr =
    trueRanges.slice(0, period).reduce((sum, value) => sum + value, 0);

  const dxValues: number[] = [];
  let plusDi = 0;
  let minusDi = 0;
  for (let i = period; i < plusDm.length; i += 1) {
    if (i > period) {
      smoothedPlusDm =
        smoothedPlusDm - smoothedPlusDm / period + (plusDm[i] as number);
      smoothedMinusDm =
        smoothedMinusDm - smoothedMinusDm / period + (minusDm[i] as number);
      smoothedTr = smoothedTr - smoothedTr / period + (trueRanges[i] as number);
    }
    plusDi = smoothedTr === 0 ? 0 : (100 * smoothedPlusDm) / smoothedTr;
    minusDi = smoothedTr === 0 ? 0 : (100 * smoothedMinusDm) / smoothedTr;
    const diSum = plusDi + minusDi;
    const dx = diSum === 0 ? 0 : (100 * Math.abs(plusDi - minusDi)) / diSum;
    dxValues.push(dx);
  }

  if (dxValues.length < period) return undefined;

  let adx = dxValues.slice(0, period).reduce((sum, value) => sum + value, 0) / period;
  for (let i = period; i < dxValues.length; i += 1) {
    adx = (adx * (period - 1) + (dxValues[i] as number)) / period;
  }

  return { adx, plusDi, minusDi };
}
