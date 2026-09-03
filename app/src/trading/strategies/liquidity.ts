import type { Candle, TradingConfig } from "../types";

export interface LiquidityCheckResult {
  readonly eligible: boolean;
  readonly reason?: string;
  readonly avgTradedValue?: number;
  readonly avgVolume?: number;
}

/**
 * Pass/fail liquidity gate using average traded value (close*volume) and
 * average volume over the trailing window (config.breakoutLookback candles,
 * excluding the current candle to stay consistent with the rest of the
 * pipeline's look-ahead-bias avoidance), plus a minimum absolute price
 * filter to exclude penny stocks.
 */
export function checkLiquidity(
  candles: readonly Candle[],
  config: TradingConfig,
): LiquidityCheckResult {
  const period = config.breakoutLookback;
  if (candles.length < period + 1) {
    return {
      eligible: false,
      reason: `Insufficient candle history (${candles.length}) to evaluate liquidity over ${period} trading days.`,
    };
  }
  const window = candles.slice(candles.length - 1 - period, candles.length - 1);
  const avgTradedValue =
    window.reduce((sum, candle) => sum + candle.close * candle.volume, 0) /
    period;
  const avgVolume = window.reduce((sum, candle) => sum + candle.volume, 0) / period;
  const latestClose = (candles[candles.length - 1] as Candle).close;

  if (latestClose < config.minimumStockPrice) {
    return {
      eligible: false,
      reason: `Price (${latestClose.toFixed(2)}) is below the minimum configured stock price (${config.minimumStockPrice}).`,
      avgTradedValue,
      avgVolume,
    };
  }
  if (avgTradedValue < config.minimumAverageTradedValue) {
    return {
      eligible: false,
      reason: `Average traded value (${avgTradedValue.toFixed(0)}) is below the minimum required (${config.minimumAverageTradedValue}).`,
      avgTradedValue,
      avgVolume,
    };
  }
  if (avgVolume < config.minimumAverageVolume) {
    return {
      eligible: false,
      reason: `Average volume (${avgVolume.toFixed(0)}) is below the minimum required (${config.minimumAverageVolume}).`,
      avgTradedValue,
      avgVolume,
    };
  }
  return {
    eligible: true,
    avgTradedValue,
    avgVolume,
  };
}
