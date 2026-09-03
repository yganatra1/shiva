import { calendarDaysBetween } from "../dates";
import type {
  CalendarYearPerformance,
  CalendarYearReturn,
  NavPoint,
} from "../types";
import { simpleReturnPct } from "./returns";
import { maxValue, minValue, percentageAtOrAbove, percentageBelow } from "./statistics";

export function calendarYearPerformance(
  nav: readonly NavPoint[],
): CalendarYearPerformance {
  if (nav.length === 0) return { years: [] };

  const byYear = new Map<number, { first: NavPoint; last: NavPoint }>();
  for (const point of nav) {
    const year = Number(point.date.slice(0, 4));
    const existing = byYear.get(year);
    if (!existing) {
      byYear.set(year, { first: point, last: point });
      continue;
    }
    existing.last = point;
  }

  const years: CalendarYearReturn[] = [];
  for (const [year, span] of [...byYear.entries()].sort((left, right) => left[0] - right[0])) {
    if (calendarDaysBetween(span.first.date, span.last.date) <= 0) continue;
    const value = simpleReturnPct(span.first.nav, span.last.nav);
    if (value === undefined) continue;
    years.push({
      year,
      return: value,
      startDate: span.first.date,
      endDate: span.last.date,
    });
  }

  if (years.length === 0) return { years: [] };

  const values = years.map((item) => item.return);
  const bestReturn = maxValue(values);
  const worstReturn = minValue(values);
  const positiveYearPercentage = percentageAtOrAbove(values, 0);
  const negativeYearPercentage = percentageBelow(values, 0);
  const bestYear = years.find((item) => item.return === bestReturn);
  const worstYear = years.find((item) => item.return === worstReturn);

  return {
    years,
    ...(positiveYearPercentage !== undefined ? { positiveYearPercentage } : {}),
    ...(negativeYearPercentage !== undefined ? { negativeYearPercentage } : {}),
    ...(bestYear ? { bestYear } : {}),
    ...(worstYear ? { worstYear } : {}),
  };
}
