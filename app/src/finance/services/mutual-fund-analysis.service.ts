import { MUTUAL_FUND_CALCULATION_VERSION, PHASE1_DATA_COVERAGE } from "../constants";
import { analyzeMutualFundHistory } from "../calculations/analyze-history";
import { calendarDaysBetween } from "../dates";
import { MutualFundError } from "../errors";
import type { FinanceLogSink } from "../logging";
import type { MutualFundRepository } from "../persistence/mutual-fund-repository";
import type {
  MutualFundAnalysis,
  MutualFundDetails,
  MutualFundHistory,
} from "../types";
import { mapWithConcurrency } from "../concurrency";
import type { MutualFundService } from "./mutual-fund.service";

export interface MutualFundAnalysisServiceOptions {
  readonly funds: MutualFundService;
  readonly repository: MutualFundRepository;
  readonly logger: FinanceLogSink;
  readonly riskFreeRate: number;
  readonly riskFreeRateSource: "configured" | "default";
  readonly maxConcurrency: number;
}

export class MutualFundAnalysisService {
  constructor(private readonly options: MutualFundAnalysisServiceOptions) {}

  async details(
    schemeCode: number,
    options: { readonly includeNav?: boolean; readonly signal?: AbortSignal } = {},
  ): Promise<MutualFundDetails> {
    const history = await this.options.funds.getHistory(schemeCode, options.signal);
    return detailsFromHistory(history, options.includeNav === true);
  }

  async analyze(
    schemeCode: number,
    options: {
      readonly includeRollingSeries?: boolean;
      readonly signal?: AbortSignal;
    } = {},
  ): Promise<MutualFundAnalysis> {
    const history = await this.options.funds.getHistory(schemeCode, options.signal);
    return this.analyzeHistory(history, options.includeRollingSeries === true);
  }

  async compare(
    schemeCodes: readonly number[],
    signal?: AbortSignal,
  ): Promise<{
    readonly results: readonly MutualFundAnalysis[];
    readonly errors: readonly {
      readonly schemeCode: number;
      readonly code: string;
      readonly message: string;
    }[];
  }> {
    if (schemeCodes.length > 10) {
      throw new MutualFundError(
        "COMPARISON_LIMIT",
        "Direct comparison is limited to 10 schemes.",
      );
    }
    const unique = [...new Set(schemeCodes)];
    const results: MutualFundAnalysis[] = [];
    const errors: {
      readonly schemeCode: number;
      readonly code: string;
      readonly message: string;
    }[] = [];

    await mapWithConcurrency(
      unique,
      this.options.maxConcurrency,
      async (schemeCode) => {
        try {
          results.push(
            await this.analyze(schemeCode, {
              ...(signal ? { signal } : {}),
            }),
          );
        } catch (error: unknown) {
          if (signal?.aborted) throw error;
          const failure =
            error instanceof MutualFundError
              ? { code: error.code, message: error.message }
              : {
                  code: "MUTUAL_FUND_FAILED",
                  message: `Scheme ${schemeCode} could not be analyzed.`,
                };
          errors.push({ schemeCode, ...failure });
          this.options.logger.warn(
            { schemeCode, code: failure.code },
            "mutual fund comparison skipped a scheme",
          );
        }
      },
    );

    results.sort(
      (left, right) =>
        unique.indexOf(left.fund.schemeCode) -
        unique.indexOf(right.fund.schemeCode),
    );
    return { results, errors };
  }

  async analyzeHistory(
    history: MutualFundHistory,
    includeRollingSeries = false,
  ): Promise<MutualFundAnalysis> {
    const last = history.nav[history.nav.length - 1];
    if (!last) {
      throw new MutualFundError(
        "INSUFFICIENT_NAV_HISTORY",
        `Scheme ${history.fund.schemeCode} has no usable NAV observations.`,
      );
    }

    if (!includeRollingSeries) {
      const cached = await this.options.repository.getAnalytics({
        schemeCode: history.fund.schemeCode,
        latestNavDate: last.date,
        calculationVersion: MUTUAL_FUND_CALCULATION_VERSION,
      });
      if (cached && cached.riskFreeRate === this.options.riskFreeRate) {
        this.options.logger.info(
          {
            tool: "mutual_fund_analyze",
            schemeCode: history.fund.schemeCode,
            navRecords: history.nav.length,
            latestNavDate: last.date,
            calculationVersion: MUTUAL_FUND_CALCULATION_VERSION,
            cache: "hit",
          },
          "mutual fund analytics cache hit",
        );
        return cached.snapshot;
      }
    }

    const started = Date.now();
    const snapshot = analyzeMutualFundHistory(history, {
      riskFreeRate: this.options.riskFreeRate,
      riskFreeRateSource: this.options.riskFreeRateSource,
      includeRollingSeries,
    });
    const calculationLatencyMs = Date.now() - started;

    if (!includeRollingSeries) {
      await this.options.repository.saveAnalytics({
        schemeCode: history.fund.schemeCode,
        latestNavDate: last.date,
        calculationVersion: MUTUAL_FUND_CALCULATION_VERSION,
        riskFreeRate: this.options.riskFreeRate,
        navObservationCount: history.nav.length,
        calculatedAt: new Date(),
        assumptions: snapshot.assumptions,
        snapshot,
      });
    }

    this.options.logger.info(
      {
        tool: "mutual_fund_analyze",
        schemeCode: history.fund.schemeCode,
        navRecords: history.nav.length,
        latestNavDate: last.date,
        calculationVersion: MUTUAL_FUND_CALCULATION_VERSION,
        calculationLatencyMs,
        cache: "miss",
      },
      "mutual fund analytics calculated",
    );
    return snapshot;
  }
}

export function detailsFromHistory(
  history: MutualFundHistory,
  includeNav: boolean,
): MutualFundDetails {
  const first = history.nav[0];
  const last = history.nav[history.nav.length - 1];
  if (!first || !last) {
    throw new MutualFundError(
      "INSUFFICIENT_NAV_HISTORY",
      `Scheme ${history.fund.schemeCode} has no usable NAV observations.`,
    );
  }
  return {
    fund: history.fund,
    latestNav: { date: last.date, nav: last.nav },
    inceptionDate: first.date,
    historyLengthDays: calendarDaysBetween(first.date, last.date),
    navObservationCount: history.nav.length,
    dataCoverage: PHASE1_DATA_COVERAGE,
    ...(includeNav ? { nav: history.nav } : {}),
  };
}
