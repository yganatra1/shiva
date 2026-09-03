import assert from "node:assert/strict";
import { test } from "node:test";

import { resolveNavOnOrBefore } from "../../src/finance/calculations/returns.js";

test("weekend/holiday target dates resolve to the latest prior NAV within tolerance", () => {
  const nav = [
    { date: "2026-09-04", nav: 10 }, // Friday
    { date: "2026-09-07", nav: 11 }, // Monday
  ];
  const saturday = resolveNavOnOrBefore(nav, "2026-09-05");
  assert.ok(saturday);
  assert.equal(saturday.point.date, "2026-09-04");
  assert.equal(saturday.gapDays, 1);
});

test("a gap wider than the holiday tolerance is insufficient data", () => {
  const nav = [{ date: "2026-01-01", nav: 10 }];
  assert.equal(resolveNavOnOrBefore(nav, "2026-02-01"), undefined);
});
