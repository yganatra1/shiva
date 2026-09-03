import { compareIsoDates, isIsoDate, mfapiDateToIso } from "../dates";
import type { NavPoint } from "../types";

export interface NavNormalizationResult {
  readonly nav: NavPoint[];
  readonly rejected: number;
}

/**
 * MFapi currently returns newest NAVs first. Calculations require ascending
 * chronological order and finite numeric NAVs.
 */
export function normalizeNavHistory(
  records: readonly { readonly date: string; readonly nav: string | number }[],
): NavNormalizationResult {
  const byDate = new Map<string, number>();
  let rejected = 0;

  for (const record of records) {
    const date = isIsoDate(record.date)
      ? record.date
      : mfapiDateToIso(record.date);
    const nav = typeof record.nav === "number" ? record.nav : Number(record.nav);
    if (!date || !Number.isFinite(nav) || !(nav > 0)) {
      rejected += 1;
      continue;
    }
    byDate.set(date, nav);
  }

  const nav = [...byDate.entries()]
    .map(([date, value]) => ({ date, nav: value }))
    .sort((left, right) => compareIsoDates(left.date, right.date));

  return { nav, rejected };
}
