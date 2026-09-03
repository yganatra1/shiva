import { presentNumber } from "./validation";

const INTEGER_KEYS = new Set([
  "schemeCode",
  "observations",
  "navObservationCount",
  "historyLengthDays",
  "year",
  "recoveryDays",
  "gapDays",
  "rank",
  "eligibleFunds",
  "excludedFunds",
  "candidateCount",
  "windowYears",
]);

export function presentJson(value: unknown): unknown {
  if (typeof value === "number") {
    return presentNumber(value);
  }
  if (Array.isArray(value)) {
    return value.map(presentJson);
  }
  if (value && typeof value === "object") {
    const result: Record<string, unknown> = {};
    for (const [key, nested] of Object.entries(value)) {
      if (typeof nested === "number" && INTEGER_KEYS.has(key)) {
        result[key] = nested;
      } else {
        result[key] = presentJson(nested);
      }
    }
    return result;
  }
  return value;
}
