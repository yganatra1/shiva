import type { MutualFund, MutualFundHistory, NavPoint } from "../../src/finance/types.js";
import { classifySchemeVariant } from "../../src/finance/calculations/scheme-variant.js";
import { addCalendarDays } from "../../src/finance/dates.js";

export function fund(
  schemeCode: number,
  schemeName: string,
  extra: Partial<MutualFund> = {},
): MutualFund {
  return {
    schemeCode,
    schemeName,
    variant: classifySchemeVariant(schemeName),
    ...extra,
  };
}

export function history(
  schemeName: string,
  schemeCode: number,
  nav: readonly NavPoint[],
  extra: Partial<MutualFund> = {},
): MutualFundHistory {
  return {
    fund: fund(schemeCode, schemeName, extra),
    nav,
  };
}

export function cagrSeries(options: {
  readonly startIso: string;
  readonly startNav: number;
  readonly days: number;
  readonly annualRate: number;
  readonly stepDays?: number;
}): NavPoint[] {
  const step = options.stepDays ?? 1;
  const nav: NavPoint[] = [];
  for (let offset = 0; offset <= options.days; offset += step) {
    const date = addCalendarDays(options.startIso, offset);
    const years = offset / 365.2425;
    nav.push({
      date,
      nav: options.startNav * (1 + options.annualRate) ** years,
    });
  }
  return nav;
}
