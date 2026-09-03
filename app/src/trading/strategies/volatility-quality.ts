import type { ScoreComponent, TradingConfig } from "../types";

/**
 * Graduated (not cliff-edged) score for ATR/close as a percentage against
 * the configured preferred band [atrPreferredRangeLowPct,
 * atrPreferredRangeHighPct]. Inside the band scores the full maxScore;
 * below it ramps down linearly to 0 as ATR% approaches 0 (too little
 * movement to trend); above it decays linearly to 0 by 2x the high bound
 * (too volatile/risky).
 */
export function scoreVolatilityQuality(
  atr: number | undefined,
  close: number,
  config: TradingConfig,
  maxScore: number,
): ScoreComponent {
  if (atr === undefined || close <= 0) {
    return {
      name: "volatilityQuality",
      score: 0,
      maxScore,
      reason: "Insufficient history to compute ATR/close volatility.",
    };
  }
  const atrPct = (atr / close) * 100;
  const low = config.atrPreferredRangeLowPct;
  const high = config.atrPreferredRangeHighPct;

  let score: number;
  if (atrPct >= low && atrPct <= high) {
    score = maxScore;
  } else if (atrPct < low) {
    score = maxScore * clamp01(atrPct / low);
  } else {
    score = maxScore * clamp01(1 - (atrPct - high) / high);
  }

  return {
    name: "volatilityQuality",
    score: round2(score),
    maxScore,
    reason: `ATR is ${atrPct.toFixed(2)}% of close, versus a preferred range of ${low}%-${high}%.`,
  };
}

function clamp01(value: number): number {
  return Math.max(0, Math.min(1, value));
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}
