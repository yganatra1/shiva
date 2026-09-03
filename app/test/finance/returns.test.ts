import assert from "node:assert/strict";
import { test } from "node:test";

import { cagrPct, periodReturn } from "../../src/finance/calculations/returns.js";

test("CAGR of NAV 100 → 121 over two calendar years is about 10%", () => {
  const value = cagrPct(100, 121, 730);
  assert.ok(value !== undefined);
  assert.ok(Math.abs(value - 10) < 0.05, `expected ~10, got ${value}`);
});

test("periodReturn uses actual elapsed days rather than a 365-day assumption", () => {
  const result = periodReturn(
    { date: "2021-01-01", nav: 100 },
    { date: "2023-01-01", nav: 121 },
  );
  assert.ok(result);
  assert.equal(result.elapsedDays, 730);
  assert.ok(Math.abs(result.cagrPct - 10) < 0.05);
});
