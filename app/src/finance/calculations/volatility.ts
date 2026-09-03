import { TRADING_DAYS_PER_YEAR } from "../constants";
import { sampleStandardDeviation } from "./statistics";
import type { DailyReturn } from "./daily-returns";
import { finiteOrUndefined } from "../validation";

/**
 * Annualized volatility = stddev(dailyReturns) × sqrt(252).
 * 252 is the conventional equity trading-day count, not the actual number of
 * NAV observations in the sample year.
 */
export function annualizedVolatilityPct(
  returns: readonly DailyReturn[],
): number | undefined {
  const values = returns.map((item) => item.value);
  const daily = sampleStandardDeviation(values);
  if (daily === undefined) return undefined;
  return finiteOrUndefined(daily * Math.sqrt(TRADING_DAYS_PER_YEAR) * 100);
}

/**
 * Downside deviation of daily excess returns below `marDaily`.
 *
 * Sortino's conventional definition divides by n (every observation, including
 * non-negative excess returns as zeros), then annualizes with sqrt(252).
 */
export function annualizedDownsideDeviationPct(
  returns: readonly DailyReturn[],
  marDaily: number,
): number | undefined {
  if (returns.length === 0) return undefined;
  let sumSquares = 0;
  for (const item of returns) {
    const excess = item.value - marDaily;
    if (excess < 0) sumSquares += excess * excess;
  }
  const daily = finiteOrUndefined(Math.sqrt(sumSquares / returns.length));
  if (daily === undefined) return undefined;
  return finiteOrUndefined(daily * Math.sqrt(TRADING_DAYS_PER_YEAR) * 100);
}
