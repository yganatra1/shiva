import assert from "node:assert/strict";
import { test } from "node:test";

import { analyzeMutualFundHistory } from "../../src/finance/calculations/analyze-history.js";
import { scoreFunds } from "../../src/finance/calculations/quant-score.js";
import { cagrSeries, history } from "./fixtures.js";

test("lower volatility and shallower drawdowns score higher among same-category peers", () => {
  const steady = analyzeMutualFundHistory(
    history(
      "Steady ELSS Direct Growth",
      1,
      cagrSeries({
        startIso: "2018-01-01",
        startNav: 100,
        days: 2200,
        annualRate: 0.12,
        stepDays: 1,
      }),
      { schemeCategory: "Equity Schemes - ELSS- Tax Saver Fund" },
    ),
  );
  const choppyNav = cagrSeries({
    startIso: "2018-01-01",
    startNav: 100,
    days: 2200,
    annualRate: 0.12,
    stepDays: 1,
  }).map((point, index) =>
    index === 400 ? { ...point, nav: point.nav * 0.5 } : point,
  );
  const choppy = analyzeMutualFundHistory(
    history("Choppy ELSS Direct Growth", 2, choppyNav, {
      schemeCategory: "Equity Schemes - ELSS- Tax Saver Fund",
    }),
  );

  const scored = scoreFunds([steady, choppy]);
  const steadyScore = scored.find((item) => item.analysis.fund.schemeCode === 1);
  const choppyScore = scored.find((item) => item.analysis.fund.schemeCode === 2);
  assert.ok(steadyScore && choppyScore);
  assert.ok(
    (steady.risk.annualizedVolatility ?? 0) <
      (choppy.risk.annualizedVolatility ?? 1),
  );
  assert.ok(
    Math.abs(steady.risk.maximumDrawdown?.drawdown ?? 0) <
      Math.abs(choppy.risk.maximumDrawdown?.drawdown ?? 1),
  );
  assert.ok(steadyScore.breakdown.volatilityScore > choppyScore.breakdown.volatilityScore);
  assert.ok(steadyScore.breakdown.drawdownScore > choppyScore.breakdown.drawdownScore);
  assert.ok(steadyScore.breakdown.total > choppyScore.breakdown.total);
});
