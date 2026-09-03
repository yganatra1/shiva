import { isPreferredResearchPlan } from "./calculations/scheme-variant";
import type { MutualFund, SchemeOption, SchemePlan } from "./types";

const STOP_WORDS = new Set([
  "schemes",
  "scheme",
  "fund",
  "funds",
  "equity",
  "the",
  "and",
  "plan",
  "option",
  "direct",
  "regular",
  "growth",
]);

export function normalizeSearchText(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .replace(/\s+/g, " ");
}

export function searchTokens(value: string): string[] {
  return normalizeSearchText(value)
    .split(" ")
    .filter((token) => token.length >= 2 && !STOP_WORDS.has(token));
}

export function scoreSchemeMatch(query: string, fund: MutualFund): number {
  const haystack = normalizeSearchText(
    [fund.schemeName, fund.fundHouse, fund.schemeCategory]
      .filter((value): value is string => Boolean(value))
      .join(" "),
  );
  const needle = normalizeSearchText(query);
  if (!needle || !haystack) return 0;
  if (haystack === needle) return 100;
  if (haystack.includes(needle)) return 80;

  const tokens = needle.split(" ").filter((token) => token.length >= 2);
  if (tokens.length === 0) return 0;
  let matched = 0;
  for (const token of tokens) {
    if (haystack.includes(token)) matched += 1;
  }
  if (matched === 0) return 0;
  const coverage = matched / tokens.length;
  let score = coverage * 60;
  if (fund.variant.plan === "direct") score += 4;
  if (fund.variant.option === "growth") score += 4;
  if (fund.variant.isBonus) score -= 10;
  return score;
}

export function rankSearchResults(
  query: string,
  funds: readonly MutualFund[],
  limit: number,
): MutualFund[] {
  return funds
    .map((fund) => ({ fund, score: scoreSchemeMatch(query, fund) }))
    .filter((item) => item.score > 0)
    .sort((left, right) => {
      if (right.score !== left.score) return right.score - left.score;
      return left.fund.schemeName.localeCompare(right.fund.schemeName);
    })
    .slice(0, limit)
    .map((item) => item.fund);
}

export function matchesCategory(
  fund: MutualFund,
  category: string,
): boolean {
  const expected = normalizeSearchText(category);
  const actual = fund.schemeCategory
    ? normalizeSearchText(fund.schemeCategory)
    : "";
  if (actual && (actual === expected || actual.includes(expected) || expected.includes(actual))) {
    return true;
  }
  const tokens = searchTokens(category);
  if (tokens.length === 0) return false;
  const haystack = normalizeSearchText(
    [fund.schemeName, fund.schemeCategory].filter(Boolean).join(" "),
  );
  return tokens.every((token) => haystack.includes(token));
}

export function namePrefilterMatchesCategory(
  fund: MutualFund,
  category: string,
): boolean {
  const tokens = searchTokens(category);
  if (tokens.length === 0) return true;
  const haystack = normalizeSearchText(fund.schemeName);
  return tokens.some((token) => haystack.includes(token));
}

export function filterByPlanOption(
  funds: readonly MutualFund[],
  plan: SchemePlan,
  option: SchemeOption,
): MutualFund[] {
  return funds.filter((fund) => isPreferredResearchPlan(fund.variant, plan, option));
}
