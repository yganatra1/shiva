import { DAYS_PER_YEAR } from "../constants";
import { scoreFunds } from "../calculations/quant-score";
import { mapWithConcurrency } from "../concurrency";
import { MutualFundError } from "../errors";
import type { FinanceLogSink } from "../logging";
import {
  filterByPlanOption,
  matchesCategory,
  namePrefilterMatchesCategory,
} from "../search";
import type {
  MutualFundAnalysis,
  QuantScoreBreakdown,
  SchemeOption,
  SchemePlan,
} from "../types";
import { MUTUAL_FUND_RESEARCH_DISCLAIMER } from "../types";
import type { MutualFundAnalysisService } from "./mutual-fund-analysis.service";
import type { MutualFundService } from "./mutual-fund.service";

export interface RankFundsInput {
  readonly category: string;
  readonly plan: SchemePlan;
  readonly option: SchemeOption;
  readonly timeHorizonYears: 1 | 3 | 5 | 7;
  readonly limit: number;
}

export interface RankedFund {
  readonly rank: number;
  readonly schemeCode: number;
  readonly schemeName: string;
  readonly quantScore: number;
  readonly scoreBreakdown: QuantScoreBreakdown;
  readonly keyMetrics: {
    readonly trailing?: number;
    readonly rollingAverage?: number;
    readonly volatility?: number;
    readonly maxDrawdown?: number;
    readonly sharpe?: number;
    readonly sortino?: number;
  };
  readonly insufficientHistory: readonly string[];
}

export interface RankFundsResult {
  readonly category: string;
  readonly plan: SchemePlan;
  readonly option: SchemeOption;
  readonly timeHorizonYears: number;
  readonly candidateCount: number;
  readonly eligibleFunds: number;
  readonly excludedFunds: number;
  readonly ranking: readonly RankedFund[];
  readonly dataCoverage: MutualFundAnalysis["dataCoverage"];
  readonly disclaimer: string;
  readonly quantitativeRankingOnly: true;
}

export class MutualFundRankingService {
  constructor(
    private readonly funds: MutualFundService,
    private readonly analysis: MutualFundAnalysisService,
    private readonly logger: FinanceLogSink,
    private readonly maxConcurrency: number,
  ) {}

  async rank(
    input: RankFundsInput,
    signal?: AbortSignal,
  ): Promise<RankFundsResult> {
    const listed = await this.funds.listFunds(signal);
    const planned = filterByPlanOption(listed, input.plan, input.option);
    const prefiltered = planned.filter((fund) =>
      namePrefilterMatchesCategory(fund, input.category),
    );
    const candidates = prefiltered.length > 0 ? prefiltered : planned;

    this.logger.info(
      {
        tool: "mutual_fund_rank",
        category: input.category,
        plan: input.plan,
        option: input.option,
        timeHorizonYears: input.timeHorizonYears,
        rankingCandidateCount: candidates.length,
      },
      "mutual fund ranking candidates identified",
    );

    const eligible: MutualFundAnalysis[] = [];
    let excluded = 0;

    await mapWithConcurrency(
      candidates,
      this.maxConcurrency,
      async (fund) => {
        try {
          const snapshot = await this.analysis.analyze(fund.schemeCode, {
            ...(signal ? { signal } : {}),
          });
          if (!matchesCategory(snapshot.fund, input.category)) {
            excluded += 1;
            return;
          }
          if (!hasMinimumHistory(snapshot, input.timeHorizonYears)) {
            excluded += 1;
            return;
          }
          eligible.push(snapshot);
        } catch (error: unknown) {
          if (signal?.aborted) throw error;
          excluded += 1;
          this.logger.warn(
            {
              schemeCode: fund.schemeCode,
              category: input.category,
            },
            "mutual fund ranking excluded a scheme after a fetch/analysis failure",
          );
        }
      },
    );

    const sameCategory = filterToDominantCategory(eligible, input.category);
    excluded += eligible.length - sameCategory.length;

    if (sameCategory.length === 0) {
      throw new MutualFundError(
        "NO_ELIGIBLE_FUNDS",
        `No ${input.plan} ${input.option} funds in ${input.category} met the ${input.timeHorizonYears}Y history requirement.`,
      );
    }
    const coverage = sameCategory[0]?.dataCoverage;
    if (!coverage) {
      throw new MutualFundError(
        "NO_ELIGIBLE_FUNDS",
        `No ${input.plan} ${input.option} funds in ${input.category} met the ${input.timeHorizonYears}Y history requirement.`,
      );
    }

    const scored = scoreFunds(sameCategory)
      .sort((left, right) => right.breakdown.total - left.breakdown.total)
      .slice(0, input.limit);

    this.logger.info(
      {
        tool: "mutual_fund_rank",
        category: input.category,
        rankingCandidateCount: candidates.length,
        rankingEligibleCount: sameCategory.length,
        rankingExcludedCount: excluded,
      },
      "mutual fund ranking completed",
    );

    return {
      category: input.category,
      plan: input.plan,
      option: input.option,
      timeHorizonYears: input.timeHorizonYears,
      candidateCount: candidates.length,
      eligibleFunds: sameCategory.length,
      excludedFunds: excluded,
      ranking: scored.map((item, index) =>
        toRankedFund(item.analysis, item.breakdown, index + 1, input.timeHorizonYears),
      ),
      dataCoverage: coverage,
      disclaimer: MUTUAL_FUND_RESEARCH_DISCLAIMER,
      quantitativeRankingOnly: true,
    };
  }
}

export function hasMinimumHistory(
  analysis: MutualFundAnalysis,
  timeHorizonYears: 1 | 3 | 5 | 7,
): boolean {
  const requiredDays = timeHorizonYears * DAYS_PER_YEAR * 0.95;
  if (analysis.historyLengthDays < requiredDays) return false;
  if (timeHorizonYears === 1) {
    return analysis.trailingReturns.oneYear !== undefined;
  }
  const rolling =
    timeHorizonYears === 3
      ? analysis.rollingReturns["3Y"]
      : timeHorizonYears === 7
        ? analysis.rollingReturns["7Y"]
        : analysis.rollingReturns["5Y"];
  return !rolling.insufficientHistory && rolling.observations > 0;
}

function filterToDominantCategory(
  analyses: readonly MutualFundAnalysis[],
  requested: string,
): MutualFundAnalysis[] {
  const grouped = new Map<string, MutualFundAnalysis[]>();
  for (const analysis of analyses) {
    const key = analysis.fund.schemeCategory ?? requested;
    const group = grouped.get(key) ?? [];
    group.push(analysis);
    grouped.set(key, group);
  }
  let best: MutualFundAnalysis[] = [];
  for (const group of grouped.values()) {
    if (group.length > best.length) best = group;
  }
  return best;
}

function toRankedFund(
  analysis: MutualFundAnalysis,
  breakdown: QuantScoreBreakdown,
  rank: number,
  horizon: 1 | 3 | 5 | 7,
): RankedFund {
  const trailing =
    horizon === 1
      ? analysis.trailingReturns.oneYear
      : horizon === 3
        ? analysis.trailingReturns.threeYearCagr
        : horizon === 7
          ? analysis.trailingReturns.sevenYearCagr
          : analysis.trailingReturns.fiveYearCagr;
  const rolling =
    horizon === 1
      ? analysis.rollingReturns["1Y"]
      : horizon === 3
        ? analysis.rollingReturns["3Y"]
        : horizon === 7
          ? analysis.rollingReturns["7Y"]
          : analysis.rollingReturns["5Y"];
  return {
    rank,
    schemeCode: analysis.fund.schemeCode,
    schemeName: analysis.fund.schemeName,
    quantScore: breakdown.total,
    scoreBreakdown: breakdown,
    keyMetrics: {
      ...(trailing !== undefined ? { trailing } : {}),
      ...(!rolling.insufficientHistory ? { rollingAverage: rolling.average } : {}),
      ...(analysis.risk.annualizedVolatility !== undefined
        ? { volatility: analysis.risk.annualizedVolatility }
        : {}),
      ...(analysis.risk.maximumDrawdown
        ? { maxDrawdown: analysis.risk.maximumDrawdown.drawdown }
        : {}),
      ...(analysis.risk.sharpe !== undefined ? { sharpe: analysis.risk.sharpe } : {}),
      ...(analysis.risk.sortino !== undefined
        ? { sortino: analysis.risk.sortino }
        : {}),
    },
    insufficientHistory: [
      ...analysis.trailingReturns.insufficientHistory,
      ...analysis.risk.insufficientHistory,
      ...analysis.consistency.insufficientHistory,
    ],
  };
}

