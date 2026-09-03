export function isPositiveInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value > 0;
}

export function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

export function finiteOrUndefined(value: number): number | undefined {
  return Number.isFinite(value) ? value : undefined;
}

/** Round only at the tool-output boundary. Intermediate math stays full precision. */
export function roundMetric(value: number, digits = 4): number | undefined {
  if (!Number.isFinite(value)) return undefined;
  const factor = 10 ** digits;
  const rounded = Math.round(value * factor) / factor;
  return Number.isFinite(rounded) ? rounded : undefined;
}

export function presentNumber(
  value: number | undefined,
  digits = 4,
): number | undefined {
  if (value === undefined) return undefined;
  return roundMetric(value, digits);
}

export function presentObject<T extends Record<string, unknown>>(value: T): T {
  return value;
}
