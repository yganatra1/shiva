import type {
  ScoreComponent,
  StrategyEvaluationContext,
  StrategyEvaluationResult,
  TradeStrategy,
} from "../types";
import { checkLiquidity } from "./liquidity";
import { scoreVolatilityQuality } from "./volatility-quality";

/**
 * Strategy #2: Breakout + Volume Expansion.
 *
 * Eligibility (all must hold; failing any one is ineligible, not a fabricated
 * low score):
 *  - Market regime is BULLISH (or SIDEWAYS if config.allowSidewaysForBreakout).
 *  - close > highest high of the prior config.breakoutLookback candles,
 *    EXCLUDING the current candle (see indicators/volume.ts#highestHigh).
 *  - current volume >= config.breakoutVolumeMultiplier x the 20-day average
 *    volume, EXCLUDING the current candle from that average.
 *  - close > EMA50 > EMA200.
 *  - ADX >= config.breakoutAdxThreshold.
 *  - Liquidity filter passes.
 *
 * Scoring (weights sum to 100, see TradingConfig.breakoutWeights):
 *  - breakoutStrength (25): % close is above the prior high, graduated.
 *  - volumeExpansion (20): volume ratio vs the 20-day average, graduated.
 *  - trendQuality (15): close>EMA50>EMA200 margin, graduated.
 *  - adxStrength (15): ADX magnitude above the breakout threshold, graduated.
 *  - relativeStrength (10): stock 3M return minus benchmark 3M return.
 *  - volatilityQuality (10): ATR/close vs the configured preferred band.
 *  - liquidity (5): graduated credit for being comfortably above the
 *    liquidity minimums.
 */
export const BreakoutVolumeStrategy: TradeStrategy = {
  id: "breakout-volume",
  name: "Breakout + Volume Expansion",
  evaluate(context: StrategyEvaluationContext): StrategyEvaluationResult {
    const { config, regime, snapshot, candles } = context;

    const regimeAllowed =
      regime.regime === "BULLISH" ||
      (regime.regime === "SIDEWAYS" && config.allowSidewaysForBreakout);
    if (!regimeAllowed) {
      return ineligible(
        `Market regime is ${regime.regime}; Breakout + Volume Expansion only trades in a BULLISH regime${config.allowSidewaysForBreakout ? " (or SIDEWAYS, per configuration)" : ""}.`,
      );
    }

    const liquidity = checkLiquidity(candles, config);
    if (!liquidity.eligible) {
      return ineligible(liquidity.reason ?? "Instrument failed the liquidity filter.");
    }

    const {
      close,
      ema50,
      ema200,
      adx14,
      atr14,
      relativeStrength3M,
      avgVolume20,
      currentVolume,
      highestHigh20ExcludingCurrent,
    } = snapshot;
    if (
      ema50 === undefined ||
      ema200 === undefined ||
      adx14 === undefined ||
      atr14 === undefined ||
      relativeStrength3M === undefined ||
      avgVolume20 === undefined ||
      highestHigh20ExcludingCurrent === undefined
    ) {
      return ineligible(
        "Insufficient candle history to compute the indicators this strategy requires.",
      );
    }

    if (close <= highestHigh20ExcludingCurrent) {
      return ineligible(
        `Close (${close.toFixed(2)}) is not above the prior ${config.breakoutLookback}-day high (${highestHigh20ExcludingCurrent.toFixed(2)}); no breakout occurred.`,
      );
    }
    const volumeRatio = avgVolume20 > 0 ? currentVolume / avgVolume20 : 0;
    if (volumeRatio < config.breakoutVolumeMultiplier) {
      return ineligible(
        `Volume is ${volumeRatio.toFixed(2)}x the 20-day average, below the required ${config.breakoutVolumeMultiplier}x.`,
      );
    }
    if (!(close > ema50 && ema50 > ema200)) {
      return ineligible(
        `Trend structure close>EMA50>EMA200 does not hold (close=${close.toFixed(2)}, EMA50=${ema50.toFixed(2)}, EMA200=${ema200.toFixed(2)}).`,
      );
    }
    if (adx14 < config.breakoutAdxThreshold) {
      return ineligible(
        `ADX (${adx14.toFixed(1)}) is below the required breakout threshold (${config.breakoutAdxThreshold}).`,
      );
    }

    const weights = config.breakoutWeights;
    const components: ScoreComponent[] = [
      scoreBreakoutStrength(close, highestHigh20ExcludingCurrent, weights.breakoutStrength),
      scoreVolumeExpansion(volumeRatio, config.breakoutVolumeMultiplier, weights.volumeExpansion),
      scoreTrendQuality(close, ema50, ema200, weights.trendQuality),
      scoreAdxStrength(adx14, config.breakoutAdxThreshold, weights.adxStrength),
      scoreRelativeStrength(relativeStrength3M, weights.relativeStrength),
      scoreVolatilityQuality(atr14, close, config, weights.volatilityQuality),
      scoreLiquidityBonus(
        liquidity.avgTradedValue ?? 0,
        config.minimumAverageTradedValue,
        weights.liquidity,
      ),
    ];

    const score = clamp(
      components.reduce((sum, component) => sum + component.score, 0),
      0,
      100,
    );

    return {
      strategyId: BreakoutVolumeStrategy.id,
      eligible: true,
      score,
      components,
    };
  },
};

function scoreBreakoutStrength(
  close: number,
  priorHigh: number,
  maxScore: number,
): ScoreComponent {
  const pctAbove = priorHigh > 0 ? (close / priorHigh - 1) * 100 : 0;
  const credit = clamp(pctAbove / 5, 0, 1); // 5%+ above prior high = full credit
  return {
    name: "breakoutStrength",
    score: round2(maxScore * credit),
    maxScore,
    reason: `Close is ${pctAbove.toFixed(1)}% above the previous ${priorHigh > 0 ? "20-day" : ""} high.`,
  };
}

function scoreVolumeExpansion(
  volumeRatio: number,
  requiredMultiplier: number,
  maxScore: number,
): ScoreComponent {
  const credit = clamp((volumeRatio - requiredMultiplier) / requiredMultiplier, 0, 1);
  return {
    name: "volumeExpansion",
    score: round2(maxScore * credit),
    maxScore,
    reason: `Volume is ${volumeRatio.toFixed(2)}x the 20-day average.`,
  };
}

function scoreTrendQuality(
  close: number,
  ema50: number,
  ema200: number,
  maxScore: number,
): ScoreComponent {
  const credit = (marginCredit(close, ema50) + marginCredit(ema50, ema200)) / 2;
  return {
    name: "trendQuality",
    score: round2(maxScore * credit),
    maxScore,
    reason: `close=${close.toFixed(2)}, EMA50=${ema50.toFixed(2)}, EMA200=${ema200.toFixed(2)}.`,
  };
}

function scoreAdxStrength(
  adx: number,
  threshold: number,
  maxScore: number,
): ScoreComponent {
  const credit = clamp((adx - threshold) / threshold, 0, 1);
  return {
    name: "adxStrength",
    score: round2(maxScore * credit),
    maxScore,
    reason: `ADX is ${adx.toFixed(1)}.`,
  };
}

function scoreRelativeStrength(
  relativeStrength3M: number,
  maxScore: number,
): ScoreComponent {
  const credit = clamp(relativeStrength3M / 0.2, 0, 1);
  return {
    name: "relativeStrength",
    score: round2(maxScore * credit),
    maxScore,
    reason: `3M relative strength vs benchmark is ${(relativeStrength3M * 100).toFixed(1)}pp.`,
  };
}

function scoreLiquidityBonus(
  avgTradedValue: number,
  minimumAverageTradedValue: number,
  maxScore: number,
): ScoreComponent {
  const ratio =
    minimumAverageTradedValue > 0 ? avgTradedValue / minimumAverageTradedValue : 1;
  const credit = clamp(ratio - 1, 0, 1);
  return {
    name: "liquidity",
    score: round2(maxScore * credit),
    maxScore,
    reason: `Average traded value is ${ratio.toFixed(2)}x the configured minimum.`,
  };
}

function marginCredit(a: number, b: number): number {
  if (b === 0) return 0;
  const margin = (a - b) / b;
  if (margin <= 0) return 0;
  return clamp(margin / 0.05, 0, 1);
}

function ineligible(reason: string): StrategyEvaluationResult {
  return {
    strategyId: BreakoutVolumeStrategy.id,
    eligible: false,
    reason,
    score: 0,
    components: [],
  };
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}
