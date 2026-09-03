import { TRADING_DAYS_PER_YEAR } from "../constants";
import { mean } from "./statistics";
import type { DailyReturn } from "./daily-returns";
import { annualizedDownsideDeviationPct } from "./volatility";
import { finiteOrUndefined } from "../validation";

/**
 * Sortino = (annualized arithmetic return − Rf) / annualized downside deviation.
 * MAR is the same configured risk-free rate used for Sharpe, expressed as a
 * daily target of Rf / 252.
 */
export function sortinoRatio(
  returns: readonly DailyReturn[],
  riskFreeRate: number,
): number | undefined {
  const averageDaily = mean(returns.map((item) => item.value));
  const marDaily = riskFreeRate / TRADING_DAYS_PER_YEAR;
  const downsidePct = annualizedDownsideDeviationPct(returns, marDaily);
  if (
    averageDaily === undefined ||
    downsidePct === undefined ||
    downsidePct === 0
  ) {
    return undefined;
  }
  const annualizedReturn = averageDaily * TRADING_DAYS_PER_YEAR;
  return finiteOrUndefined(
    (annualizedReturn - riskFreeRate) / (downsidePct / 100),
  );
}
