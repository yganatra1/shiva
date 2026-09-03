import { finiteOrUndefined } from "../validation";

export function mean(values: readonly number[]): number | undefined {
  if (values.length === 0) return undefined;
  let sum = 0;
  for (const value of values) {
    if (!Number.isFinite(value)) return undefined;
    sum += value;
  }
  return finiteOrUndefined(sum / values.length);
}

/** Sample (n-1) standard deviation. Returns undefined for fewer than 2 finite values. */
export function sampleStandardDeviation(
  values: readonly number[],
): number | undefined {
  const average = mean(values);
  if (average === undefined || values.length < 2) return undefined;
  let sumSquares = 0;
  for (const value of values) {
    const delta = value - average;
    sumSquares += delta * delta;
  }
  return finiteOrUndefined(Math.sqrt(sumSquares / (values.length - 1)));
}

export function median(values: readonly number[]): number | undefined {
  if (values.length === 0) return undefined;
  const sorted = [...values].sort((left, right) => left - right);
  const midpoint = Math.floor(sorted.length / 2);
  const mid = sorted[midpoint];
  if (mid === undefined) return undefined;
  if (sorted.length % 2 === 1) return finiteOrUndefined(mid);
  const previous = sorted[midpoint - 1];
  if (previous === undefined) return undefined;
  return finiteOrUndefined((previous + mid) / 2);
}

export function minValue(values: readonly number[]): number | undefined {
  if (values.length === 0) return undefined;
  let minimum = values[0];
  if (minimum === undefined) return undefined;
  for (const value of values) {
    if (value < minimum) minimum = value;
  }
  return finiteOrUndefined(minimum);
}

export function maxValue(values: readonly number[]): number | undefined {
  if (values.length === 0) return undefined;
  let maximum = values[0];
  if (maximum === undefined) return undefined;
  for (const value of values) {
    if (value > maximum) maximum = value;
  }
  return finiteOrUndefined(maximum);
}

export function percentageAtOrAbove(
  values: readonly number[],
  threshold: number,
): number | undefined {
  if (values.length === 0) return undefined;
  let count = 0;
  for (const value of values) {
    if (value >= threshold) count += 1;
  }
  return finiteOrUndefined((count / values.length) * 100);
}

export function percentageBelow(
  values: readonly number[],
  threshold: number,
): number | undefined {
  if (values.length === 0) return undefined;
  let count = 0;
  for (const value of values) {
    if (value < threshold) count += 1;
  }
  return finiteOrUndefined((count / values.length) * 100);
}

/**
 * Higher-is-better percentile among peers. Ties share the average rank.
 * A single observation is scored 50 because there is no peer distribution.
 */
export function peerPercentiles(
  values: readonly number[],
  invert = false,
): number[] {
  const n = values.length;
  if (n === 0) return [];
  if (n === 1) return [50];

  const indexed = values.map((value, index) => ({ value, index }));
  indexed.sort((left, right) =>
    invert ? left.value - right.value : right.value - left.value,
  );

  const scores = new Array<number>(n).fill(50);
  let i = 0;
  while (i < indexed.length) {
    let j = i + 1;
    while (j < indexed.length && indexed[j]?.value === indexed[i]?.value) {
      j += 1;
    }
    const startRank = i;
    const endRank = j - 1;
    const averageRank = (startRank + endRank) / 2;
    const percentile = (1 - averageRank / (n - 1)) * 100;
    for (let k = i; k < j; k += 1) {
      const item = indexed[k];
      if (item) scores[item.index] = percentile;
    }
    i = j;
  }
  return scores;
}
