import type { NavPoint } from "../types";
import { finiteOrUndefined } from "../validation";

export interface DailyReturn {
  readonly date: string;
  readonly value: number;
}

/** Consecutive-observation returns. The series must already be ascending. */
export function dailyReturns(nav: readonly NavPoint[]): DailyReturn[] {
  const result: DailyReturn[] = [];
  for (let i = 1; i < nav.length; i += 1) {
    const previous = nav[i - 1];
    const current = nav[i];
    if (!previous || !current || !(previous.nav > 0) || !(current.nav > 0)) {
      continue;
    }
    const value = finiteOrUndefined(current.nav / previous.nav - 1);
    if (value === undefined) continue;
    result.push({ date: current.date, value });
  }
  return result;
}
