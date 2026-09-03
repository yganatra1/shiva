import type { PHASE1_DATA_COVERAGE } from "./constants";

export type SchemePlan = "direct" | "regular" | "unknown";
export type SchemeOption = "growth" | "idcw" | "dividend" | "unknown";

export interface SchemeVariant {
  readonly plan: SchemePlan;
  readonly option: SchemeOption;
  readonly isBonus: boolean;
}

export interface MutualFund {
  readonly schemeCode: number;
  readonly schemeName: string;
  readonly fundHouse?: string;
  readonly schemeType?: string;
  readonly schemeCategory?: string;
  readonly isinGrowth?: string | null;
  readonly isinDividendReinvestment?: string | null;
  readonly variant: SchemeVariant;
}

export interface NavPoint {
  readonly date: string;
  readonly nav: number;
}

export interface MutualFundHistory {
  readonly fund: MutualFund;
  readonly nav: readonly NavPoint[];
}

export interface LatestNav {
  readonly date: string;
  readonly nav: number;
}

export interface TrailingReturns {
  readonly oneMonth?: number;
  readonly threeMonth?: number;
  readonly sixMonth?: number;
  readonly oneYear?: number;
  readonly threeYearCagr?: number;
  readonly fiveYearCagr?: number;
  readonly sevenYearCagr?: number;
  readonly tenYearCagr?: number;
  readonly sinceInceptionCagr?: number;
  readonly insufficientHistory: readonly string[];
}

export interface RollingPeriod {
  readonly startDate: string;
  readonly endDate: string;
  readonly return: number;
}

export interface RollingReturnObservation extends RollingPeriod {
  readonly startNav: number;
  readonly endNav: number;
}

export interface RollingReturnStatistics {
  readonly windowYears: number;
  readonly observations: number;
  readonly average: number;
  readonly median: number;
  readonly minimum: number;
  readonly maximum: number;
  readonly standardDeviation: number;
  readonly positivePeriodPercentage: number;
  readonly above8PercentPercentage: number;
  readonly above10PercentPercentage: number;
  readonly above12PercentPercentage: number;
  readonly above15PercentPercentage: number;
  readonly worstPeriod?: RollingPeriod;
  readonly bestPeriod?: RollingPeriod;
  readonly series?: readonly RollingReturnObservation[];
  readonly insufficientHistory: boolean;
}

export interface MaximumDrawdown {
  readonly drawdown: number;
  readonly peakDate: string;
  readonly peakNav: number;
  readonly troughDate: string;
  readonly troughNav: number;
  readonly recovered: boolean;
  readonly recoveryDate?: string;
  readonly recoveryDays?: number;
}

export interface CalendarYearReturn {
  readonly year: number;
  readonly return: number;
  readonly startDate: string;
  readonly endDate: string;
}

export interface CalendarYearPerformance {
  readonly years: readonly CalendarYearReturn[];
  readonly positiveYearPercentage?: number;
  readonly negativeYearPercentage?: number;
  readonly bestYear?: CalendarYearReturn;
  readonly worstYear?: CalendarYearReturn;
}

export interface ConsistencyMetrics {
  readonly positiveThreeYearRollingPercentage?: number;
  readonly positiveFiveYearRollingPercentage?: number;
  readonly threeYearAbove10PercentPercentage?: number;
  readonly threeYearAbove12PercentPercentage?: number;
  readonly fiveYearAbove10PercentPercentage?: number;
  readonly fiveYearAbove12PercentPercentage?: number;
  readonly threeYearRollingStandardDeviation?: number;
  readonly fiveYearRollingStandardDeviation?: number;
  readonly worstThreeYearRollingReturn?: number;
  readonly worstFiveYearRollingReturn?: number;
  readonly insufficientHistory: readonly string[];
}

export interface RiskMetrics {
  readonly annualizedVolatility?: number;
  readonly maximumDrawdown?: MaximumDrawdown;
  readonly sharpe?: number;
  readonly sortino?: number;
  readonly downsideDeviation?: number;
  readonly insufficientHistory: readonly string[];
}

export interface MutualFundAssumptions {
  readonly riskFreeRate: number;
  readonly tradingDaysPerYear: number;
  readonly daysPerYear: number;
  readonly calculationVersion: string;
  readonly riskFreeRateSource: "configured" | "default";
}

export type DataCoverage = typeof PHASE1_DATA_COVERAGE;

export interface QuantScoreBreakdown {
  readonly rollingReturnScore: number;
  readonly consistencyScore: number;
  readonly drawdownScore: number;
  readonly sortinoScore: number;
  readonly sharpeScore: number;
  readonly volatilityScore: number;
  readonly worstPeriodScore: number;
  readonly total: number;
  readonly renormalized: boolean;
  readonly missingComponents: readonly string[];
}

export interface MutualFundAnalysis {
  readonly fund: MutualFund;
  readonly latestNav: LatestNav;
  readonly inceptionDate: string;
  readonly historyLengthDays: number;
  readonly navObservationCount: number;
  readonly trailingReturns: TrailingReturns;
  readonly rollingReturns: {
    readonly "1Y": RollingReturnStatistics;
    readonly "3Y": RollingReturnStatistics;
    readonly "5Y": RollingReturnStatistics;
    readonly "7Y": RollingReturnStatistics;
  };
  readonly risk: RiskMetrics;
  readonly calendarYears: CalendarYearPerformance;
  readonly consistency: ConsistencyMetrics;
  readonly assumptions: MutualFundAssumptions;
  readonly dataCoverage: DataCoverage;
  readonly disclaimer: string;
}

export interface MutualFundDetails {
  readonly fund: MutualFund;
  readonly latestNav: LatestNav;
  readonly inceptionDate: string;
  readonly historyLengthDays: number;
  readonly navObservationCount: number;
  readonly dataCoverage: DataCoverage;
  readonly nav?: readonly NavPoint[];
}

export const MUTUAL_FUND_RESEARCH_DISCLAIMER =
  "This is a NAV-derived quantitative ranking and research snapshot, not a complete investment suitability assessment. Phase 1 does not include TER, AUM, holdings, fund-manager tenure, or benchmark-relative alpha.";

export interface MutualFundDataProvider {
  searchFunds(query: string, signal?: AbortSignal): Promise<readonly MutualFund[]>;
  listFunds(signal?: AbortSignal): Promise<readonly MutualFund[]>;
  getFundHistory(
    schemeCode: number,
    signal?: AbortSignal,
  ): Promise<MutualFundHistory>;
  probe?(signal?: AbortSignal): Promise<boolean>;
}

/**
 * Future Finance Manager domains. Phase 1 implements mutual funds only;
 * stocks, portfolio, and brokers stay unregistered until their providers exist.
 */
export type FinanceManagerDomain =
  | "mutual-funds"
  | "stocks"
  | "portfolio"
  | "paytm-money"
  | "kite"
  | "investment-fit";
