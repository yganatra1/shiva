import assert from "node:assert/strict";
import { test } from "node:test";

import { analyzeMutualFundHistory } from "../../src/finance/calculations/analyze-history.js";
import { hasMinimumHistory } from "../../src/finance/services/mutual-fund-ranking.service.js";
import { cagrSeries, history } from "./fixtures.js";

test("a two-year scheme cannot receive 5Y rolling statistics or a 5Y rank slot", () => {
  const snapshot = analyzeMutualFundHistory(
    history(
      "Young ELSS Direct Growth",
      1,
      cagrSeries({
        startIso: "2024-01-01",
        startNav: 100,
        days: 730,
        annualRate: 0.12,
      }),
      { schemeCategory: "Equity Schemes - ELSS- Tax Saver Fund" },
    ),
  );
  assert.equal(snapshot.rollingReturns["5Y"].insufficientHistory, true);
  assert.equal(snapshot.trailingReturns.fiveYearCagr, undefined);
  assert.ok(snapshot.trailingReturns.insufficientHistory.includes("5Y"));
  assert.equal(hasMinimumHistory(snapshot, 5), false);
  assert.equal(hasMinimumHistory(snapshot, 1), true);
});
