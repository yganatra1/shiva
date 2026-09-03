import { QUANT_SCORE_WEIGHTS } from "../constants";
import type {
  MutualFundAnalysis,
  QuantScoreBreakdown,
} from "../types";
import { peerPercentiles } from "./statistics";

export interface ScoredFund {
  readonly analysis: MutualFundAnalysis;
  readonly breakdown: QuantScoreBreakdown;
}

interface MetricVector {
  readonly rollingReturn: number | undefined;
  readonly consistency: number | undefined;
  readonly drawdown: number | undefined;
  readonly sortino: number | undefined;
  readonly sharpe: number | undefined;
  readonly volatility: number | undefined;
  readonly worstPeriod: number | undefined;
}

/**
 * Peer-relative 0-100 score. Metrics are never compared across scheme
 * categories; the caller must pass a same-category cohort.
 *
 * Lower volatility and shallower (less negative) drawdowns rank better.
 * Missing metrics are omitted and remaining weights are renormalized so a
 * young scheme is not treated as scoring zero on 5Y windows it never had.
 */
export function scoreFunds(analyses: readonly MutualFundAnalysis[]): ScoredFund[] {
  const vectors = analyses.map(metricVector);
  const rolling = peerPercentiles(defined(vectors.map((item) => item.rollingReturn)));
  const consistency = peerPercentiles(defined(vectors.map((item) => item.consistency)));
  const drawdown = peerPercentiles(
    defined(vectors.map((item) => item.drawdown)),
    true,
  );
  const sortino = peerPercentiles(defined(vectors.map((item) => item.sortino)));
  const sharpe = peerPercentiles(defined(vectors.map((item) => item.sharpe)));
  const volatility = peerPercentiles(
    defined(vectors.map((item) => item.volatility)),
    true,
  );
  const worstPeriod = peerPercentiles(
    defined(vectors.map((item) => item.worstPeriod)),
  );

  let rollingIndex = 0;
  let consistencyIndex = 0;
  let drawdownIndex = 0;
  let sortinoIndex = 0;
  let sharpeIndex = 0;
  let volatilityIndex = 0;
  let worstIndex = 0;

  return analyses.map((analysis, index) => {
    const vector = vectors[index];
    const rollingScore = take(vector?.rollingReturn, rolling, () => rollingIndex++);
    const consistencyScore = take(
      vector?.consistency,
      consistency,
      () => consistencyIndex++,
    );
    const drawdownScore = take(vector?.drawdown, drawdown, () => drawdownIndex++);
    const sortinoScore = take(vector?.sortino, sortino, () => sortinoIndex++);
    const sharpeScore = take(vector?.sharpe, sharpe, () => sharpeIndex++);
    const volatilityScore = take(
      vector?.volatility,
      volatility,
      () => volatilityIndex++,
    );
    const worstPeriodScore = take(
      vector?.worstPeriod,
      worstPeriod,
      () => worstIndex++,
    );
    return {
      analysis,
      breakdown: combineBreakdown({
        rollingReturnScore: rollingScore,
        consistencyScore,
        drawdownScore,
        sortinoScore,
        sharpeScore,
        volatilityScore,
        worstPeriodScore,
      }),
    };
  });
}

function metricVector(analysis: MutualFundAnalysis): MetricVector {
  const horizonYears = preferredHorizon(analysis);
  const rolling =
    horizonYears === 7
      ? analysis.rollingReturns["7Y"]
      : horizonYears === 3
        ? analysis.rollingReturns["3Y"]
        : analysis.rollingReturns["5Y"];
  const consistency =
    analysis.consistency.fiveYearAbove12PercentPercentage ??
    analysis.consistency.threeYearAbove12PercentPercentage ??
    analysis.consistency.positiveFiveYearRollingPercentage ??
    analysis.consistency.positiveThreeYearRollingPercentage;
  return {
    rollingReturn: usableRolling(rolling)?.average,
    consistency,
    drawdown:
      analysis.risk.maximumDrawdown !== undefined
        ? Math.abs(analysis.risk.maximumDrawdown.drawdown)
        : undefined,
    sortino: analysis.risk.sortino,
    sharpe: analysis.risk.sharpe,
    volatility: analysis.risk.annualizedVolatility,
    worstPeriod: usableRolling(rolling)?.worstPeriod?.return,
  };
}

function preferredHorizon(analysis: MutualFundAnalysis): 3 | 5 | 7 {
  if (!analysis.rollingReturns["5Y"].insufficientHistory) return 5;
  if (!analysis.rollingReturns["3Y"].insufficientHistory) return 3;
  return 7;
}

function usableRolling(
  stats: MutualFundAnalysis["rollingReturns"]["5Y"],
): MutualFundAnalysis["rollingReturns"]["5Y"] | undefined {
  return !stats.insufficientHistory && stats.observations > 0 ? stats : undefined;
}

function defined(values: readonly (number | undefined)[]): number[] {
  return values.filter((value): value is number => value !== undefined);
}

function take(
  value: number | undefined,
  scores: readonly number[],
  nextIndex: () => number,
): number | undefined {
  if (value === undefined) return undefined;
  return scores[nextIndex()];
}

function combineBreakdown(input: {
  readonly rollingReturnScore: number | undefined;
  readonly consistencyScore: number | undefined;
  readonly drawdownScore: number | undefined;
  readonly sortinoScore: number | undefined;
  readonly sharpeScore: number | undefined;
  readonly volatilityScore: number | undefined;
  readonly worstPeriodScore: number | undefined;
}): QuantScoreBreakdown {
  const components: { readonly score: number; readonly weight: number; readonly name: string }[] =
    [];
  push(components, input.rollingReturnScore, QUANT_SCORE_WEIGHTS.rollingReturn, "rollingReturn");
  push(components, input.consistencyScore, QUANT_SCORE_WEIGHTS.consistency, "consistency");
  push(components, input.drawdownScore, QUANT_SCORE_WEIGHTS.drawdown, "drawdown");
  push(components, input.sortinoScore, QUANT_SCORE_WEIGHTS.sortino, "sortino");
  push(components, input.sharpeScore, QUANT_SCORE_WEIGHTS.sharpe, "sharpe");
  push(components, input.volatilityScore, QUANT_SCORE_WEIGHTS.volatility, "volatility");
  push(components, input.worstPeriodScore, QUANT_SCORE_WEIGHTS.worstPeriod, "worstPeriod");

  const missing = [
    input.rollingReturnScore === undefined ? "rollingReturn" : undefined,
    input.consistencyScore === undefined ? "consistency" : undefined,
    input.drawdownScore === undefined ? "drawdown" : undefined,
    input.sortinoScore === undefined ? "sortino" : undefined,
    input.sharpeScore === undefined ? "sharpe" : undefined,
    input.volatilityScore === undefined ? "volatility" : undefined,
    input.worstPeriodScore === undefined ? "worstPeriod" : undefined,
  ].filter((value): value is string => value !== undefined);

  const weightSum = components.reduce((sum, item) => sum + item.weight, 0);
  const renormalized = missing.length > 0 && weightSum > 0;
  const total =
    weightSum > 0
      ? components.reduce((sum, item) => sum + item.score * (item.weight / weightSum), 0)
      : 0;

  return {
    rollingReturnScore: input.rollingReturnScore ?? 0,
    consistencyScore: input.consistencyScore ?? 0,
    drawdownScore: input.drawdownScore ?? 0,
    sortinoScore: input.sortinoScore ?? 0,
    sharpeScore: input.sharpeScore ?? 0,
    volatilityScore: input.volatilityScore ?? 0,
    worstPeriodScore: input.worstPeriodScore ?? 0,
    total,
    renormalized,
    missingComponents: missing,
  };
}

function push(
  components: { score: number; weight: number; name: string }[],
  score: number | undefined,
  weight: number,
  name: string,
): void {
  if (score === undefined) return;
  components.push({ score, weight, name });
}
