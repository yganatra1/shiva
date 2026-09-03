import assert from "node:assert/strict";
import { test } from "node:test";

import { analyzeMutualFundHistory } from "../../src/finance/calculations/analyze-history.js";
import { MfApiClient } from "../../src/finance/providers/mfapi.client.js";
import { historyToFund } from "../../src/finance/providers/mfapi-provider.js";

const live = process.env.LIVE_MFAPI === "1";

test(
  "live MFapi analyze of Axis ELSS Direct Growth (120503)",
  { skip: !live },
  async () => {
    const client = new MfApiClient({
      baseUrl: "https://api.mfapi.in",
      timeoutMs: 15_000,
      maxRetries: 2,
    });
    const payload = await client.getSchemeHistory(120503);
    const history = historyToFund(payload);
    const snapshot = analyzeMutualFundHistory(history, {
      riskFreeRate: 0.065,
      riskFreeRateSource: "default",
    });
    assert.equal(snapshot.fund.schemeCode, 120503);
    assert.match(snapshot.fund.schemeName, /Axis ELSS/i);
    assert.equal(snapshot.fund.variant.plan, "direct");
    assert.equal(snapshot.fund.variant.option, "growth");
    assert.ok(snapshot.trailingReturns.oneYear !== undefined);
    assert.ok(snapshot.trailingReturns.threeYearCagr !== undefined);
    assert.ok(snapshot.trailingReturns.fiveYearCagr !== undefined);
    assert.equal(snapshot.rollingReturns["3Y"].insufficientHistory, false);
    assert.equal(snapshot.rollingReturns["5Y"].insufficientHistory, false);
    assert.ok(snapshot.risk.annualizedVolatility !== undefined);
    assert.ok(snapshot.risk.maximumDrawdown);
    assert.ok(snapshot.risk.sharpe !== undefined);
    assert.ok(snapshot.risk.sortino !== undefined);
    assert.ok(snapshot.calendarYears.years.length > 5);
    assert.equal(snapshot.dataCoverage.expenseRatio, false);
    assert.equal(snapshot.dataCoverage.aum, false);
    assert.equal(snapshot.dataCoverage.holdings, false);
    assert.equal(snapshot.dataCoverage.fundManager, false);
    assert.equal(snapshot.dataCoverage.benchmark, false);
  },
);
