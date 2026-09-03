import assert from "node:assert/strict";
import { test } from "node:test";

import { silentFinanceLogger } from "../../src/finance/logging.js";
import { InMemoryMutualFundRepository } from "../../src/finance/persistence/mutual-fund-repository.js";
import { MutualFundAnalysisService } from "../../src/finance/services/mutual-fund-analysis.service.js";
import { MutualFundService } from "../../src/finance/services/mutual-fund.service.js";
import type { MutualFundDataProvider } from "../../src/finance/types.js";
import { cagrSeries, history } from "./fixtures.js";

test("analytics are reused for the same scheme + latest NAV date + version", async () => {
  let fetches = 0;
  const snapshot = history(
    "Axis ELSS Direct Growth",
    120503,
    cagrSeries({
      startIso: "2018-01-01",
      startNav: 15,
      days: 2200,
      annualRate: 0.12,
    }),
    { schemeCategory: "Equity Schemes - ELSS- Tax Saver Fund" },
  );
  const provider: MutualFundDataProvider = {
    async searchFunds() {
      return [snapshot.fund];
    },
    async listFunds() {
      return [snapshot.fund];
    },
    async getFundHistory() {
      fetches += 1;
      return snapshot;
    },
  };
  const repository = new InMemoryMutualFundRepository();
  const funds = new MutualFundService({
    provider,
    repository,
    logger: silentFinanceLogger(),
    listCacheTtlMs: 60_000,
    maxConcurrency: 2,
  });
  const analysis = new MutualFundAnalysisService({
    funds,
    repository,
    logger: silentFinanceLogger(),
    riskFreeRate: 0.065,
    riskFreeRateSource: "default",
    maxConcurrency: 2,
  });

  const first = await analysis.analyze(120503);
  const second = await analysis.analyze(120503);
  assert.equal(fetches, 1);
  assert.equal(first.fund.schemeCode, 120503);
  assert.equal(second.assumptions.calculationVersion, first.assumptions.calculationVersion);
  assert.equal(second.latestNav.date, first.latestNav.date);
});

test("compare returns partial success when one scheme fails", async () => {
  const good = history(
    "Good Direct Growth",
    1,
    cagrSeries({
      startIso: "2018-01-01",
      startNav: 100,
      days: 1200,
      annualRate: 0.1,
    }),
  );
  const provider: MutualFundDataProvider = {
    async searchFunds() {
      return [good.fund];
    },
    async listFunds() {
      return [good.fund];
    },
    async getFundHistory(schemeCode) {
      if (schemeCode !== 1) throw new Error("upstream");
      return good;
    },
  };
  const repository = new InMemoryMutualFundRepository();
  const funds = new MutualFundService({
    provider,
    repository,
    logger: silentFinanceLogger(),
    listCacheTtlMs: 60_000,
    maxConcurrency: 2,
  });
  const analysis = new MutualFundAnalysisService({
    funds,
    repository,
    logger: silentFinanceLogger(),
    riskFreeRate: 0.065,
    riskFreeRateSource: "default",
    maxConcurrency: 2,
  });
  const compared = await analysis.compare([1, 2]);
  assert.equal(compared.results.length, 1);
  assert.equal(compared.errors.length, 1);
  assert.equal(compared.errors[0]?.schemeCode, 2);
});
