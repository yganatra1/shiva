import assert from "node:assert/strict";
import { test } from "node:test";

import { normalizeNavHistory } from "../../src/finance/calculations/nav-history.js";

test("MFapi newest-first NAV history is stored in ascending date order", () => {
  const result = normalizeNavHistory([
    { date: "02-09-2026", nav: "111.56080" },
    { date: "01-09-2026", nav: "112.04800" },
    { date: "31-08-2026", nav: "110.00000" },
  ]);
  assert.deepEqual(
    result.nav.map((point) => point.date),
    ["2026-08-31", "2026-09-01", "2026-09-02"],
  );
  assert.equal(result.nav[0]?.nav, 110);
  assert.equal(result.rejected, 0);
});

test("invalid NAV strings are rejected rather than becoming NaN", () => {
  const result = normalizeNavHistory([
    { date: "01-09-2026", nav: "N.A." },
    { date: "02-09-2026", nav: "0" },
    { date: "03-09-2026", nav: "10.5" },
  ]);
  assert.equal(result.nav.length, 1);
  assert.equal(result.nav[0]?.date, "2026-09-03");
  assert.equal(result.rejected, 2);
});
