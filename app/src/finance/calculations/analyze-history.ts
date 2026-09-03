import {
  DAYS_PER_YEAR,
  DEFAULT_RISK_FREE_RATE,
  MUTUAL_FUND_CALCULATION_VERSION,
  PHASE1_DATA_COVERAGE,
  TRADING_DAYS_PER_YEAR,
} from "../constants";
import { calendarDaysBetween } from "../dates";
import type {
  MutualFundAnalysis,
  MutualFundAssumptions,
  MutualFundHistory,
  RiskMetrics,
  TrailingReturns,
} from "../types";
import { MUTUAL_FUND_RESEARCH_DISCLAIMER } from "../types";
import { calendarYearPerformance } from "./calendar-returns";
import { consistencyMetrics } from "./consistency";
import { dailyReturns } from "./daily-returns";
import { maximumDrawdown } from "./drawdown";
import {
  sinceInceptionReturn,
  trailingPeriodReturn,
} from "./returns";
import { rollingReturnStatistics } from "./rolling-returns";
import { sharpeRatio } from "./sharpe";
import { sortinoRatio } from "./sortino";
import {
  annualizedDownsideDeviationPct,
  annualizedVolatilityPct,
} from "./volatility";

export interface AnalyzeHistoryOptions {
  readonly riskFreeRate?: number;
  readonly riskFreeRateSource?: "configured" | "default";
  readonly includeRollingSeries?: boolean;
}

export function analyzeMutualFundHistory(
  history: MutualFundHistory,
  options: AnalyzeHistoryOptions = {},
): MutualFundAnalysis {
  const nav = history.nav;
  const first = nav[0];
  const last = nav[nav.length - 1];
  if (!first || !last) {
    throw new Error("NAV history must contain at least one observation.");
  }

  const riskFreeRate = options.riskFreeRate ?? DEFAULT_RISK_FREE_RATE;
  const assumptions: MutualFundAssumptions = {
    riskFreeRate,
    tradingDaysPerYear: TRADING_DAYS_PER_YEAR,
    daysPerYear: DAYS_PER_YEAR,
    calculationVersion: MUTUAL_FUND_CALCULATION_VERSION,
    riskFreeRateSource: options.riskFreeRateSource ?? "default",
  };

  const rollingOptions = options.includeRollingSeries
    ? { includeSeries: true }
    : {};
  const trailingReturns = trailingReturnsFromNav(nav, last);
  const rollingOne = rollingReturnStatistics(nav, 1, rollingOptions);
  const rollingThree = rollingReturnStatistics(nav, 3, rollingOptions);
  const rollingFive = rollingReturnStatistics(nav, 5, rollingOptions);
  const rollingSeven = rollingReturnStatistics(nav, 7, rollingOptions);
  const returns = dailyReturns(nav);
  const risk = riskMetricsFromReturns(nav, returns, riskFreeRate);

  return {
    fund: history.fund,
    latestNav: { date: last.date, nav: last.nav },
    inceptionDate: first.date,
    historyLengthDays: calendarDaysBetween(first.date, last.date),
    navObservationCount: nav.length,
    trailingReturns,
    rollingReturns: {
      "1Y": rollingOne,
      "3Y": rollingThree,
      "5Y": rollingFive,
      "7Y": rollingSeven,
    },
    risk,
    calendarYears: calendarYearPerformance(nav),
    consistency: consistencyMetrics({
      threeYear: rollingThree,
      fiveYear: rollingFive,
    }),
    assumptions,
    dataCoverage: PHASE1_DATA_COVERAGE,
    disclaimer: MUTUAL_FUND_RESEARCH_DISCLAIMER,
  };
}

function trailingReturnsFromNav(
  nav: MutualFundHistory["nav"],
  last: MutualFundHistory["nav"][number],
): TrailingReturns {
  const insufficientHistory: string[] = [];
  const oneMonth = pickSimple(trailingPeriodReturn(nav, last, "months", 1), "1M", insufficientHistory);
  const threeMonth = pickSimple(trailingPeriodReturn(nav, last, "months", 3), "3M", insufficientHistory);
  const sixMonth = pickSimple(trailingPeriodReturn(nav, last, "months", 6), "6M", insufficientHistory);
  const oneYear = pickSimple(trailingPeriodReturn(nav, last, "years", 1), "1Y", insufficientHistory);
  const threeYear = pickCagr(trailingPeriodReturn(nav, last, "years", 3), "3Y", insufficientHistory);
  const fiveYear = pickCagr(trailingPeriodReturn(nav, last, "years", 5), "5Y", insufficientHistory);
  const sevenYear = pickCagr(trailingPeriodReturn(nav, last, "years", 7), "7Y", insufficientHistory);
  const tenYear = pickCagr(trailingPeriodReturn(nav, last, "years", 10), "10Y", insufficientHistory);
  const inception = sinceInceptionReturn(nav);
  const sinceInceptionCagr =
    inception && inception.years > 1
      ? inception.cagrPct
      : inception
        ? inception.simpleReturnPct
        : undefined;
  if (sinceInceptionCagr === undefined) {
    insufficientHistory.push("since inception");
  }

  return {
    ...(oneMonth !== undefined ? { oneMonth } : {}),
    ...(threeMonth !== undefined ? { threeMonth } : {}),
    ...(sixMonth !== undefined ? { sixMonth } : {}),
    ...(oneYear !== undefined ? { oneYear } : {}),
    ...(threeYear !== undefined ? { threeYearCagr: threeYear } : {}),
    ...(fiveYear !== undefined ? { fiveYearCagr: fiveYear } : {}),
    ...(sevenYear !== undefined ? { sevenYearCagr: sevenYear } : {}),
    ...(tenYear !== undefined ? { tenYearCagr: tenYear } : {}),
    ...(sinceInceptionCagr !== undefined ? { sinceInceptionCagr } : {}),
    insufficientHistory,
  };
}

function pickSimple(
  period: ReturnType<typeof trailingPeriodReturn>,
  label: string,
  insufficientHistory: string[],
): number | undefined {
  if (!period) {
    insufficientHistory.push(label);
    return undefined;
  }
  return period.simpleReturnPct;
}

function pickCagr(
  period: ReturnType<typeof trailingPeriodReturn>,
  label: string,
  insufficientHistory: string[],
): number | undefined {
  if (!period) {
    insufficientHistory.push(label);
    return undefined;
  }
  return period.cagrPct;
}

function riskMetricsFromReturns(
  nav: MutualFundHistory["nav"],
  returns: ReturnType<typeof dailyReturns>,
  riskFreeRate: number,
): RiskMetrics {
  const insufficientHistory: string[] = [];
  const vol = annualizedVolatilityPct(returns);
  const drawdown = maximumDrawdown(nav);
  const sharpe = sharpeRatio(returns, riskFreeRate);
  const sortino = sortinoRatio(returns, riskFreeRate);
  const downside = annualizedDownsideDeviationPct(
    returns,
    riskFreeRate / TRADING_DAYS_PER_YEAR,
  );
  if (vol === undefined) insufficientHistory.push("volatility");
  if (!drawdown) insufficientHistory.push("maximum drawdown");
  if (sharpe === undefined) insufficientHistory.push("sharpe");
  if (sortino === undefined) insufficientHistory.push("sortino");

  return {
    ...(vol !== undefined ? { annualizedVolatility: vol } : {}),
    ...(drawdown ? { maximumDrawdown: drawdown } : {}),
    ...(sharpe !== undefined ? { sharpe } : {}),
    ...(sortino !== undefined ? { sortino } : {}),
    ...(downside !== undefined ? { downsideDeviation: downside } : {}),
    insufficientHistory,
  };
}
