import type {
  ScoreComponent,
  StrategyEvaluationContext,
  StrategyEvaluationResult,
  TradeStrategy,
} from "../types";
import { checkLiquidity } from "./liquidity";
import { scoreVolatilityQuality } from "./volatility-quality";

/**
 * Strategy #1: Trend + Momentum.
 *
 * Eligibility: BULLISH regime only by default (SIDEWAYS is opt-in via
 * config.allowSidewaysForTrendMomentum). Never eligible in BEARISH/UNKNOWN,
 * on an illiquid instrument, or without enough candle history to compute
 * every scored indicator.
 *
 * Scoring (weights sum to 100, see TradingConfig.trendMomentumWeights):
 *  - trendStructure (30): close>EMA20>EMA50>EMA200 ordering (graduated by
 *    margin, not a cliff) with RSI14-in-[lower,upper] folded in as partial
 *    credit within this same component.
 *  - relativeStrength (25): stock 3M return minus benchmark 3M return vs
 *    config.relativeStrengthThreshold, graduated above the threshold.
 *  - momentum3M (20): stock's own 3M momentum, graduated by magnitude.
 *  - volumeQuality (10): current/avg-20d volume ratio, graduated.
 *  - volatilityQuality (10): ATR/close vs the configured preferred band.
 *  - liquidity (5): graduated credit for being comfortably above the
 *    liquidity minimums (the minimums themselves are a pass/fail gate
 *    evaluated before any scoring happens).
 */
export const TrendMomentumStrategy: TradeStrategy = {
  id: "trend-momentum",
  name: "Trend + Momentum",
  evaluate(context: StrategyEvaluationContext): StrategyEvaluationResult {
    const { config, regime, snapshot, candles } = context;

    const regimeAllowed =
      regime.regime === "BULLISH" ||
      (regime.regime === "SIDEWAYS" && config.allowSidewaysForTrendMomentum);
    if (!regimeAllowed) {
      return ineligible(
        `Market regime is ${regime.regime}; Trend + Momentum only trades in a BULLISH regime${config.allowSidewaysForTrendMomentum ? " (or SIDEWAYS, per configuration)" : ""}.`,
      );
    }

    const liquidity = checkLiquidity(candles, config);
    if (!liquidity.eligible) {
      return ineligible(liquidity.reason ?? "Instrument failed the liquidity filter.");
    }

    const { ema20, ema50, ema200, rsi14, atr14, momentum3M, relativeStrength3M, close, avgVolume20, currentVolume } =
      snapshot;
    if (
      ema20 === undefined ||
      ema50 === undefined ||
      ema200 === undefined ||
      rsi14 === undefined ||
      atr14 === undefined ||
      momentum3M === undefined ||
      relativeStrength3M === undefined ||
      avgVolume20 === undefined
    ) {
      return ineligible(
        "Insufficient candle history to compute the indicators this strategy requires.",
      );
    }

    const weights = config.trendMomentumWeights;
    const components: ScoreComponent[] = [];

    components.push(
      scoreTrendStructure(
        close,
        ema20,
        ema50,
        ema200,
        rsi14,
        config.rsiMomentumLowerBound,
        config.rsiMomentumUpperBound,
        weights.trendStructure,
      ),
    );
    components.push(
      scoreRelativeStrength(
        relativeStrength3M,
        config.relativeStrengthThreshold,
        weights.relativeStrength,
      ),
    );
    components.push(scoreMomentum3M(momentum3M, weights.momentum3M));
    components.push(
      scoreVolumeQuality(currentVolume, avgVolume20, weights.volumeQuality),
    );
    components.push(
      scoreVolatilityQuality(atr14, close, config, weights.volatilityQuality),
    );
    components.push(
      scoreLiquidityBonus(
        liquidity.avgTradedValue ?? 0,
        config.minimumAverageTradedValue,
        weights.liquidity,
      ),
    );

    const score = clamp(
      components.reduce((sum, component) => sum + component.score, 0),
      0,
      100,
    );

    return {
      strategyId: TrendMomentumStrategy.id,
      eligible: true,
      score,
      components,
    };
  },
};

function scoreTrendStructure(
  close: number,
  ema20: number,
  ema50: number,
  ema200: number,
  rsi14: number,
  rsiLower: number,
  rsiUpper: number,
  maxScore: number,
): ScoreComponent {
  const orderingCredit =
    (marginCredit(close, ema20) + marginCredit(ema20, ema50) + marginCredit(ema50, ema200)) / 3;
  const rsiCredit = rsiBandCredit(rsi14, rsiLower, rsiUpper);
  const score = maxScore * (0.7 * orderingCredit + 0.3 * rsiCredit);
  return {
    name: "trendStructure",
    score: round2(score),
    maxScore,
    reason: `close=${close.toFixed(2)}, EMA20=${ema20.toFixed(2)}, EMA50=${ema50.toFixed(2)}, EMA200=${ema200.toFixed(2)}; RSI14=${rsi14.toFixed(1)} (preferred ${rsiLower}-${rsiUpper}).`,
  };
}

function scoreRelativeStrength(
  relativeStrength3M: number,
  threshold: number,
  maxScore: number,
): ScoreComponent {
  const credit = clamp((relativeStrength3M - threshold) / 0.2, 0, 1);
  return {
    name: "relativeStrength",
    score: round2(maxScore * credit),
    maxScore,
    reason: `3M relative strength vs benchmark is ${(relativeStrength3M * 100).toFixed(1)}pp (threshold ${(threshold * 100).toFixed(1)}pp).`,
  };
}

function scoreMomentum3M(momentum3M: number, maxScore: number): ScoreComponent {
  const credit = clamp(momentum3M / 0.3, 0, 1);
  return {
    name: "momentum3M",
    score: round2(maxScore * credit),
    maxScore,
    reason: `3-month price momentum is ${(momentum3M * 100).toFixed(1)}%.`,
  };
}

function scoreVolumeQuality(
  currentVolume: number,
  avgVolume20: number,
  maxScore: number,
): ScoreComponent {
  const ratio = avgVolume20 > 0 ? currentVolume / avgVolume20 : 0;
  const credit = clamp(ratio - 1, 0, 1);
  return {
    name: "volumeQuality",
    score: round2(maxScore * credit),
    maxScore,
    reason: `Current volume is ${ratio.toFixed(2)}x the 20-day average.`,
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

function rsiBandCredit(rsi: number, lower: number, upper: number): number {
  if (rsi >= lower && rsi <= upper) return 1;
  if (rsi < lower) return clamp(1 - (lower - rsi) / 15, 0, 1);
  return clamp(1 - (rsi - upper) / 15, 0, 1);
}

function ineligible(reason: string): StrategyEvaluationResult {
  return {
    strategyId: TrendMomentumStrategy.id,
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
