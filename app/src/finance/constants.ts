/**
 * Deterministic mutual-fund analytics constants.
 *
 * Annualized volatility uses 252 trading days, the conventional Indian/global
 * equity-fund assumption. Calendar CAGR uses the mean Gregorian year length
 * 365.2425 rather than 365, so leap days do not silently bias long windows.
 */
export const DAYS_PER_YEAR = 365.2425;

/** Conventional equity-fund trading-day count used to annualize daily risk. */
export const TRADING_DAYS_PER_YEAR = 252;

/**
 * Temporary Indian risk-free/MAR assumption until an external rate provider
 * is wired. Callers must surface the rate actually used; never treat this as
 * a live RBI/T-bill quote.
 */
export const DEFAULT_RISK_FREE_RATE = 0.065;

/** Snapshot key so a formula change does not reuse stale PostgreSQL rows. */
export const MUTUAL_FUND_CALCULATION_VERSION = "mf-nav-v1";

/**
 * Maximum calendar gap allowed when resolving a target date onto the nearest
 * prior NAV. Mutual-fund NAVs skip weekends and exchange holidays.
 */
export const MAX_NAV_LOOKBACK_DAYS = 10;

export const PHASE1_DATA_COVERAGE = {
  navHistory: true,
  expenseRatio: false,
  aum: false,
  holdings: false,
  fundManager: false,
  benchmark: false,
} as const;

export const QUANT_SCORE_WEIGHTS = {
  rollingReturn: 0.25,
  consistency: 0.2,
  drawdown: 0.15,
  sortino: 0.15,
  sharpe: 0.1,
  volatility: 0.05,
  worstPeriod: 0.1,
} as const;
