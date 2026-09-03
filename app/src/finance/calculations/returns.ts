import { DAYS_PER_YEAR, MAX_NAV_LOOKBACK_DAYS } from "../constants";
import {
  addCalendarMonths,
  addCalendarYears,
  calendarDaysBetween,
  compareIsoDates,
} from "../dates";
import type { NavPoint } from "../types";
import { finiteOrUndefined } from "../validation";

export interface ResolvedNav {
  readonly point: NavPoint;
  readonly targetDate: string;
  readonly gapDays: number;
}

export interface PeriodReturn {
  readonly start: NavPoint;
  readonly end: NavPoint;
  readonly elapsedDays: number;
  readonly years: number;
  readonly simpleReturnPct: number;
  readonly cagrPct: number;
}

/**
 * Latest NAV on or before `targetDate`, rejecting gaps wider than the
 * holiday/weekend tolerance. Array offsets are never used as a proxy for time.
 */
export function resolveNavOnOrBefore(
  nav: readonly NavPoint[],
  targetDate: string,
  maxLookbackDays = MAX_NAV_LOOKBACK_DAYS,
): ResolvedNav | undefined {
  if (nav.length === 0) return undefined;
  let lo = 0;
  let hi = nav.length - 1;
  let candidate: NavPoint | undefined;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const point = nav[mid];
    if (!point) break;
    if (compareIsoDates(point.date, targetDate) <= 0) {
      candidate = point;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  if (!candidate) return undefined;
  const gapDays = calendarDaysBetween(candidate.date, targetDate);
  if (gapDays > maxLookbackDays) return undefined;
  return { point: candidate, targetDate, gapDays };
}

export function simpleReturnPct(startNav: number, endNav: number): number | undefined {
  if (!(startNav > 0) || !(endNav > 0)) return undefined;
  return finiteOrUndefined((endNav / startNav - 1) * 100);
}

export function cagrPct(
  startNav: number,
  endNav: number,
  elapsedDays: number,
): number | undefined {
  if (!(startNav > 0) || !(endNav > 0) || elapsedDays <= 0) return undefined;
  const years = elapsedDays / DAYS_PER_YEAR;
  if (!(years > 0)) return undefined;
  return finiteOrUndefined((endNav / startNav) ** (1 / years) * 100 - 100);
}

export function periodReturn(
  start: NavPoint,
  end: NavPoint,
): PeriodReturn | undefined {
  const elapsedDays = calendarDaysBetween(start.date, end.date);
  const simple = simpleReturnPct(start.nav, end.nav);
  const compounded = cagrPct(start.nav, end.nav, elapsedDays);
  if (simple === undefined || compounded === undefined) return undefined;
  return {
    start,
    end,
    elapsedDays,
    years: elapsedDays / DAYS_PER_YEAR,
    simpleReturnPct: simple,
    cagrPct: compounded,
  };
}

export function trailingPeriodReturn(
  nav: readonly NavPoint[],
  end: NavPoint,
  kind: "months" | "years",
  count: number,
): PeriodReturn | undefined {
  const target =
    kind === "months"
      ? addCalendarMonths(end.date, -count)
      : addCalendarYears(end.date, -count);
  const start = resolveNavOnOrBefore(nav, target);
  if (!start) return undefined;
  return periodReturn(start.point, end);
}

export function sinceInceptionReturn(
  nav: readonly NavPoint[],
): PeriodReturn | undefined {
  const start = nav[0];
  const end = nav[nav.length - 1];
  if (!start || !end) return undefined;
  return periodReturn(start, end);
}
