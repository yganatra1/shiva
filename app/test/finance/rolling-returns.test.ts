import assert from "node:assert/strict";
import { test } from "node:test";

import { rollingReturnStatistics } from "../../src/finance/calculations/rolling-returns.js";
import { cagrSeries } from "./fixtures.js";

test("1Y rolling CAGR on a 10% synthetic series is about 10%", () => {
  const nav = cagrSeries({
    startIso: "2018-01-01",
    startNav: 100,
    days: 2000,
    annualRate: 0.1,
    stepDays: 1,
  });
  const stats = rollingReturnStatistics(nav, 1);
  assert.equal(stats.insufficientHistory, false);
  assert.ok(stats.observations > 300);
  assert.ok(Math.abs(stats.average - 10) < 0.15, `average ${stats.average}`);
  assert.ok(Math.abs(stats.minimum - 10) < 0.15);
  assert.ok(Math.abs(stats.maximum - 10) < 0.15);
  assert.ok(stats.positivePeriodPercentage === 100);
});

test("includeSeries is omitted unless requested", () => {
  const nav = cagrSeries({
    startIso: "2020-01-01",
    startNav: 100,
    days: 800,
    annualRate: 0.1,
  });
  assert.equal(rollingReturnStatistics(nav, 1).series, undefined);
  assert.ok((rollingReturnStatistics(nav, 1, { includeSeries: true }).series?.length ?? 0) > 0);
});
