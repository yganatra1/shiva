import { addCalendarYears, calendarDaysBetween } from "../dates";
import type {
  RollingPeriod,
  RollingReturnObservation,
  RollingReturnStatistics,
  NavPoint,
} from "../types";
import { cagrPct, resolveNavOnOrBefore } from "./returns";
import {
  maxValue,
  mean,
  median,
  minValue,
  percentageAtOrAbove,
  sampleStandardDeviation,
} from "./statistics";

export function rollingReturnStatistics(
  nav: readonly NavPoint[],
  windowYears: number,
  options: { readonly includeSeries?: boolean } = {},
): RollingReturnStatistics {
  const empty: RollingReturnStatistics = {
    windowYears,
    observations: 0,
    average: 0,
    median: 0,
    minimum: 0,
    maximum: 0,
    standardDeviation: 0,
    positivePeriodPercentage: 0,
    above8PercentPercentage: 0,
    above10PercentPercentage: 0,
    above12PercentPercentage: 0,
    above15PercentPercentage: 0,
    insufficientHistory: true,
  };
  if (nav.length < 2 || windowYears <= 0) return empty;

  const observations: RollingReturnObservation[] = [];
  for (const end of nav) {
    const target = addCalendarYears(end.date, -windowYears);
    const start = resolveNavOnOrBefore(nav, target);
    if (!start) continue;
    const elapsedDays = calendarDaysBetween(start.point.date, end.date);
    const rolling = cagrPct(start.point.nav, end.nav, elapsedDays);
    if (rolling === undefined) continue;
    observations.push({
      startDate: start.point.date,
      endDate: end.date,
      startNav: start.point.nav,
      endNav: end.nav,
      return: rolling,
    });
  }

  if (observations.length === 0) return empty;

  const values = observations.map((item) => item.return);
  const average = mean(values);
  const middle = median(values);
  const minimum = minValue(values);
  const maximum = maxValue(values);
  const deviation = sampleStandardDeviation(values);
  if (
    average === undefined ||
    middle === undefined ||
    minimum === undefined ||
    maximum === undefined ||
    deviation === undefined
  ) {
    return empty;
  }

  const worst = observations.reduce((current, item) =>
    item.return < current.return ? item : current,
  );
  const best = observations.reduce((current, item) =>
    item.return > current.return ? item : current,
  );

  return {
    windowYears,
    observations: observations.length,
    average,
    median: middle,
    minimum,
    maximum,
    standardDeviation: deviation,
    positivePeriodPercentage: percentageAtOrAbove(values, 0) ?? 0,
    above8PercentPercentage: percentageAtOrAbove(values, 8) ?? 0,
    above10PercentPercentage: percentageAtOrAbove(values, 10) ?? 0,
    above12PercentPercentage: percentageAtOrAbove(values, 12) ?? 0,
    above15PercentPercentage: percentageAtOrAbove(values, 15) ?? 0,
    worstPeriod: toPeriod(worst),
    bestPeriod: toPeriod(best),
    ...(options.includeSeries ? { series: observations } : {}),
    insufficientHistory: false,
  };
}

function toPeriod(observation: RollingReturnObservation): RollingPeriod {
  return {
    startDate: observation.startDate,
    endDate: observation.endDate,
    return: observation.return,
  };
}
