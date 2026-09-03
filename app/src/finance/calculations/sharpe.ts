import { TRADING_DAYS_PER_YEAR } from "../constants";
import { mean } from "./statistics";
import type { DailyReturn } from "./daily-returns";
import { annualizedVolatilityPct } from "./volatility";
import { finiteOrUndefined } from "../validation";

/**
 * Sharpe = (annualized arithmetic return − Rf) / annualized volatility.
 * Daily returns are annualized with 252 days so the ratio stays internally
 * consistent with {@link annualizedVolatilityPct}.
 */
export function sharpeRatio(
  returns: readonly DailyReturn[],
  riskFreeRate: number,
): number | undefined {
  const averageDaily = mean(returns.map((item) => item.value));
  const volPct = annualizedVolatilityPct(returns);
  if (averageDaily === undefined || volPct === undefined || volPct === 0) {
    return undefined;
  }
  const annualizedReturn = averageDaily * TRADING_DAYS_PER_YEAR;
  return finiteOrUndefined((annualizedReturn - riskFreeRate) / (volPct / 100));
}
