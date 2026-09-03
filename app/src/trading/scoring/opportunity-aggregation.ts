import type {
  MarketRegimeResult,
  StrategyEvaluationResult,
  TechnicalSnapshot,
  TradeOpportunity,
  TradingInstrument,
} from "../types";

/**
 * Aggregates every strategy's evaluation for one instrument into a single
 * TradeOpportunity, or undefined when the instrument does not clear the bar.
 *
 * finalScore is the HIGHEST score among eligible strategies for this
 * instrument, NOT an average — a stock that is a strong breakout candidate
 * but a mediocre trend-momentum candidate should be ranked on its best
 * qualifying setup, not diluted by a strategy it was never a good fit for.
 * When more than one strategy ties for that top score, the tie is broken
 * deterministically by (in order): score desc, relativeStrength component
 * score desc, liquidity/avgTradedValue component score desc, then strategy
 * id as a final deterministic fallback.
 */
export function buildTradeOpportunity(
  strategyResults: readonly StrategyEvaluationResult[],
  instrument: TradingInstrument,
  regime: MarketRegimeResult,
  timestamp: string,
  minimumOpportunityScore: number,
  snapshot?: TechnicalSnapshot,
): TradeOpportunity | undefined {
  const eligible = strategyResults.filter((result) => result.eligible);
  if (eligible.length === 0) return undefined;

  const winner = [...eligible].sort(compareStrategyResults)[0] as StrategyEvaluationResult;
  if (winner.score < minimumOpportunityScore) return undefined;

  const metrics: Record<string, unknown> = {
    componentScores: Object.fromEntries(
      winner.components.map((component) => [
        component.name,
        { score: component.score, maxScore: component.maxScore },
      ]),
    ),
    strategyScores: Object.fromEntries(
      strategyResults.map((result) => [
        result.strategyId,
        { eligible: result.eligible, score: result.score },
      ]),
    ),
  };
  if (snapshot) {
    metrics.snapshot = {
      close: snapshot.close,
      rsi14: snapshot.rsi14,
      adx14: snapshot.adx14,
      atr14: snapshot.atr14,
      momentum1M: snapshot.momentum1M,
      momentum3M: snapshot.momentum3M,
      relativeStrength3M: snapshot.relativeStrength3M,
      avgVolume20: snapshot.avgVolume20,
      currentVolume: snapshot.currentVolume,
    };
  }

  return {
    instrumentToken: instrument.instrumentToken,
    exchange: instrument.exchange,
    tradingsymbol: instrument.tradingsymbol,
    primaryStrategy: winner.strategyId,
    finalScore: winner.score,
    regime: regime.regime,
    reasons: winner.components.map((component) => component.reason),
    metrics,
    asOf: timestamp,
  };
}

/** Deterministic ordering used both to pick a primary strategy and to rank opportunities scanner-wide. */
export function compareOpportunities(
  a: TradeOpportunity,
  b: TradeOpportunity,
): number {
  if (a.finalScore !== b.finalScore) return b.finalScore - a.finalScore;
  const relativeStrengthDelta = relativeStrengthOf(b) - relativeStrengthOf(a);
  if (relativeStrengthDelta !== 0) return relativeStrengthDelta;
  const avgTradedValueDelta = avgTradedValueOf(b) - avgTradedValueOf(a);
  if (avgTradedValueDelta !== 0) return avgTradedValueDelta;
  return a.tradingsymbol.localeCompare(b.tradingsymbol);
}

function relativeStrengthOf(opportunity: TradeOpportunity): number {
  const snapshot = (opportunity.metrics as { snapshot?: { relativeStrength3M?: number } })
    .snapshot;
  return snapshot?.relativeStrength3M ?? 0;
}

function avgTradedValueOf(opportunity: TradeOpportunity): number {
  const componentScores = (
    opportunity.metrics as {
      componentScores?: Record<string, { score: number; maxScore: number }>;
    }
  ).componentScores;
  return componentScores?.liquidity?.score ?? 0;
}

function compareStrategyResults(
  a: StrategyEvaluationResult,
  b: StrategyEvaluationResult,
): number {
  if (a.score !== b.score) return b.score - a.score;
  const relativeStrengthDelta =
    componentScore(b, "relativeStrength") - componentScore(a, "relativeStrength");
  if (relativeStrengthDelta !== 0) return relativeStrengthDelta;
  const liquidityDelta = componentScore(b, "liquidity") - componentScore(a, "liquidity");
  if (liquidityDelta !== 0) return liquidityDelta;
  return a.strategyId.localeCompare(b.strategyId);
}

function componentScore(result: StrategyEvaluationResult, name: string): number {
  return result.components.find((component) => component.name === name)?.score ?? 0;
}
