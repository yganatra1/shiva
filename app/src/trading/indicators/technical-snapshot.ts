import type { Candle, TechnicalSnapshot, TradingConfig } from "../types";
import { calculateAdx14 } from "./adx";
import { calculateAtr14 } from "./atr";
import { calculateEma } from "./ema";
import { calculateMomentum } from "./momentum";
import { calculateRelativeStrength } from "./relative-strength";
import { calculateRsi14 } from "./rsi";
import { averageVolume, highestHigh } from "./volume";

/**
 * Builds the full deterministic indicator readout for one instrument's most
 * recent candle. Any indicator that lacks enough history is simply left
 * undefined — never fabricated or defaulted to zero.
 */
export function buildTechnicalSnapshot(
  candles: readonly Candle[],
  benchmarkCandles: readonly Candle[],
  config: TradingConfig,
): TechnicalSnapshot {
  const latest = candles[candles.length - 1];
  const close = latest?.close ?? 0;
  const currentVolume = latest?.volume ?? 0;

  const adx = calculateAdx14(candles, config.adxPeriod);
  const ema20 = calculateEma(candles, config.emaFastPeriod);
  const ema50 = calculateEma(candles, config.emaMediumPeriod);
  const ema200 = calculateEma(candles, config.emaSlowPeriod);
  const rsi14 = calculateRsi14(candles, config.rsiPeriod);
  const atr14 = calculateAtr14(candles, config.atrPeriod);
  const avgVolume20 = averageVolume(candles, config.breakoutLookback);
  const highestHigh20ExcludingCurrent = highestHigh(candles, config.breakoutLookback);
  const momentum1M = calculateMomentum(candles, config.momentum1MLookbackDays);
  const momentum3M = calculateMomentum(candles, config.momentum3MLookbackDays);
  const relativeStrength3M = calculateRelativeStrength(
    candles,
    benchmarkCandles,
    config.momentum3MLookbackDays,
  );
  const benchmarkReturn3M = calculateMomentum(
    benchmarkCandles,
    config.momentum3MLookbackDays,
  );

  return {
    close,
    currentVolume,
    ...(ema20 !== undefined ? { ema20 } : {}),
    ...(ema50 !== undefined ? { ema50 } : {}),
    ...(ema200 !== undefined ? { ema200 } : {}),
    ...(rsi14 !== undefined ? { rsi14 } : {}),
    ...(atr14 !== undefined ? { atr14 } : {}),
    ...(adx ? { adx14: adx.adx, plusDi14: adx.plusDi, minusDi14: adx.minusDi } : {}),
    ...(avgVolume20 !== undefined ? { avgVolume20 } : {}),
    ...(highestHigh20ExcludingCurrent !== undefined
      ? { highestHigh20ExcludingCurrent }
      : {}),
    ...(momentum1M !== undefined ? { momentum1M } : {}),
    ...(momentum3M !== undefined ? { momentum3M } : {}),
    ...(relativeStrength3M !== undefined ? { relativeStrength3M } : {}),
    ...(benchmarkReturn3M !== undefined ? { benchmarkReturn3M } : {}),
  };
}
