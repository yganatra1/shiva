import assert from "node:assert/strict";
import { test } from "node:test";

import { maximumDrawdown } from "../../src/finance/calculations/drawdown.js";

test("peak-to-trough drawdown of 120 → 90 is -25%", () => {
  const result = maximumDrawdown([
    { date: "2020-01-01", nav: 100 },
    { date: "2020-02-01", nav: 120 },
    { date: "2020-03-01", nav: 90 },
    { date: "2020-04-01", nav: 110 },
    { date: "2020-05-01", nav: 130 },
  ]);
  assert.ok(result);
  assert.equal(result.drawdown, -25);
  assert.equal(result.peakDate, "2020-02-01");
  assert.equal(result.peakNav, 120);
  assert.equal(result.troughDate, "2020-03-01");
  assert.equal(result.troughNav, 90);
  assert.equal(result.recovered, true);
  assert.equal(result.recoveryDate, "2020-05-01");
});

test("unrecovered drawdown omits recovery fields", () => {
  const result = maximumDrawdown([
    { date: "2020-01-01", nav: 100 },
    { date: "2020-02-01", nav: 80 },
  ]);
  assert.ok(result);
  assert.ok(Math.abs((result.drawdown ?? 0) + 20) < 1e-10);
  assert.equal(result.recovered, false);
  assert.equal(result.recoveryDate, undefined);
});
