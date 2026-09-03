import assert from "node:assert/strict";
import { test } from "node:test";

import { dailyReturns } from "../../src/finance/calculations/daily-returns.js";
import { sharpeRatio } from "../../src/finance/calculations/sharpe.js";
import { sortinoRatio } from "../../src/finance/calculations/sortino.js";
import {
  annualizedDownsideDeviationPct,
  annualizedVolatilityPct,
} from "../../src/finance/calculations/volatility.js";

test("Sharpe and Sortino return undefined instead of Infinity/NaN", () => {
  const flat = dailyReturns([
    { date: "2020-01-01", nav: 100 },
    { date: "2020-01-02", nav: 100 },
    { date: "2020-01-03", nav: 100 },
  ]);
  assert.equal(sharpeRatio(flat, 0.065), undefined);
  assert.equal(annualizedVolatilityPct(flat), 0);

  const rising = dailyReturns([
    { date: "2020-01-01", nav: 100 },
    { date: "2020-01-02", nav: 102 },
    { date: "2020-01-03", nav: 104 },
  ]);
  assert.equal(sortinoRatio(rising, 0.065), undefined);
});

test("downside deviation ignores upside excess returns", () => {
  const mixed = [
    { date: "2020-01-02", value: 0.02 },
    { date: "2020-01-03", value: -0.04 },
    { date: "2020-01-04", value: 0.01 },
  ];
  const down = annualizedDownsideDeviationPct(mixed, 0);
  assert.ok(down !== undefined && down > 0);
  const allUp = annualizedDownsideDeviationPct(
    [
      { date: "2020-01-02", value: 0.01 },
      { date: "2020-01-03", value: 0.02 },
    ],
    0,
  );
  assert.equal(allUp, 0);
});
