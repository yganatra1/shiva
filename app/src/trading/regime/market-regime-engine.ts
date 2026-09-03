import { calculateAdx14 } from "../indicators/adx";
import { calculateEma } from "../indicators/ema";
import type { Candle, MarketRegimeResult, TradingConfig } from "../types";

function round(value: number, decimals = 2): string {
  return value.toLocaleString("en-IN", {
    maximumFractionDigits: decimals,
    minimumFractionDigits: decimals,
  });
}

/**
 * Deterministic market-regime classification from benchmark candles alone.
 * Rules (evaluated in this order):
 *  - UNKNOWN: insufficient benchmark history to compute EMA50/EMA200/ADX.
 *  - BULLISH: close > EMA50 > EMA200 AND ADX >= adxBullishThreshold.
 *  - BEARISH: close < EMA50 < EMA200.
 *  - SIDEWAYS: ADX < adxSidewaysThreshold and neither of the above holds.
 *  - Otherwise SIDEWAYS (a trending-but-ambiguous EMA structure defaults to
 *    the conservative "not clearly trending" classification).
 */
export function detectMarketRegime(
  benchmarkCandles: readonly Candle[],
  config: TradingConfig,
): MarketRegimeResult {
  const latest = benchmarkCandles[benchmarkCandles.length - 1];
  const ema50 = calculateEma(benchmarkCandles, config.emaMediumPeriod);
  const ema200 = calculateEma(benchmarkCandles, config.emaSlowPeriod);
  const adx = calculateAdx14(benchmarkCandles, config.adxPeriod);

  if (!latest || ema50 === undefined || ema200 === undefined || adx === undefined) {
    return {
      regime: "UNKNOWN",
      reasons: [
        "Insufficient benchmark candle history to compute EMA50, EMA200, and ADX.",
      ],
      asOf: latest?.timestamp ?? new Date(0).toISOString(),
    };
  }

  const close = latest.close;
  const asOf = latest.timestamp;

  if (close > ema50 && ema50 > ema200 && adx.adx >= config.adxBullishThreshold) {
    return {
      regime: "BULLISH",
      reasons: [
        `Benchmark close (${round(close)}) is above EMA50 (${round(ema50)}) and EMA200 (${round(ema200)}).`,
        `ADX (${round(adx.adx)}) is at or above the bullish threshold (${config.adxBullishThreshold}), indicating a trending market.`,
      ],
      asOf,
    };
  }

  if (close < ema50 && ema50 < ema200) {
    return {
      regime: "BEARISH",
      reasons: [
        `Benchmark close (${round(close)}) is below EMA50 (${round(ema50)}) and EMA200 (${round(ema200)}).`,
      ],
      asOf,
    };
  }

  if (adx.adx < config.adxSidewaysThreshold) {
    return {
      regime: "SIDEWAYS",
      reasons: [
        `ADX (${round(adx.adx)}) is below the sideways threshold (${config.adxSidewaysThreshold}), indicating a non-trending market.`,
      ],
      asOf,
    };
  }

  return {
    regime: "SIDEWAYS",
    reasons: [
      `Benchmark close (${round(close)}), EMA50 (${round(ema50)}), and EMA200 (${round(ema200)}) do not form a clear bullish or bearish structure.`,
      `ADX (${round(adx.adx)}) is between the sideways (${config.adxSidewaysThreshold}) and bullish (${config.adxBullishThreshold}) thresholds.`,
    ],
    asOf,
  };
}
