import assert from "node:assert/strict";
import { test } from "node:test";

import { MutualFundError } from "../../src/finance/errors.js";
import { silentFinanceLogger } from "../../src/finance/logging.js";
import { InMemoryMutualFundRepository } from "../../src/finance/persistence/mutual-fund-repository.js";
import { MutualFundAnalysisService } from "../../src/finance/services/mutual-fund-analysis.service.js";
import { MutualFundRankingService } from "../../src/finance/services/mutual-fund-ranking.service.js";
import { MutualFundService } from "../../src/finance/services/mutual-fund.service.js";
import type { MutualFund, MutualFundDataProvider, MutualFundHistory } from "../../src/finance/types.js";
import { cagrSeries, fund, history } from "./fixtures.js";

function providerWith(histories: readonly MutualFundHistory[]): MutualFundDataProvider {
  const funds = histories.map((item) => item.fund);
  const byCode = new Map(histories.map((item) => [item.fund.schemeCode, item]));
  return {
    async searchFunds() {
      return funds;
    },
    async listFunds() {
      return funds;
    },
    async getFundHistory(schemeCode) {
      const found = byCode.get(schemeCode);
      if (!found) {
        throw new MutualFundError("MFAPI_NOT_FOUND", `missing ${schemeCode}`);
      }
      return found;
    },
  };
}

test("ranking keeps Direct Growth ELSS only and excludes a young peer", async () => {
  const elssLong = history(
    "Alpha ELSS Tax Saver Direct Plan - Growth Option",
    101,
    cagrSeries({
      startIso: "2018-01-01",
      startNav: 100,
      days: 2500,
      annualRate: 0.14,
    }),
    { schemeCategory: "Equity Schemes - ELSS- Tax Saver Fund" },
  );
  const elssWorse = history(
    "Beta ELSS Tax Saver Direct Plan - Growth Option",
    102,
    cagrSeries({
      startIso: "2018-01-01",
      startNav: 100,
      days: 2500,
      annualRate: 0.08,
    }).map((point, index) =>
      index === 500 ? { ...point, nav: point.nav * 0.6 } : point,
    ),
    { schemeCategory: "Equity Schemes - ELSS- Tax Saver Fund" },
  );
  const elssYoung = history(
    "Gamma ELSS Tax Saver Direct Plan - Growth Option",
    103,
    cagrSeries({
      startIso: "2024-06-01",
      startNav: 100,
      days: 400,
      annualRate: 0.4,
    }),
    { schemeCategory: "Equity Schemes - ELSS- Tax Saver Fund" },
  );
  const elssRegular = fund(
    104,
    "Delta ELSS Tax Saver Regular Plan - Growth Option",
    { schemeCategory: "Equity Schemes - ELSS- Tax Saver Fund" },
  );
  const flexi = history(
    "Epsilon Flexi Cap Direct Plan - Growth Option",
    105,
    cagrSeries({
      startIso: "2018-01-01",
      startNav: 100,
      days: 2500,
      annualRate: 0.2,
    }),
    { schemeCategory: "Equity Schemes - Flexi Cap Fund" },
  );

  const listed: MutualFund[] = [
    elssLong.fund,
    elssWorse.fund,
    elssYoung.fund,
    elssRegular,
    flexi.fund,
  ];
  const histories = [elssLong, elssWorse, elssYoung, flexi];
  const repository = new InMemoryMutualFundRepository();
  await repository.saveSchemeList(listed, new Date());
  const logger = silentFinanceLogger();
  const funds = new MutualFundService({
    provider: providerWith(histories),
    repository,
    logger,
    listCacheTtlMs: 60_000,
    maxConcurrency: 5,
  });
  const analysis = new MutualFundAnalysisService({
    funds,
    repository,
    logger,
    riskFreeRate: 0.065,
    riskFreeRateSource: "configured",
    maxConcurrency: 5,
  });
  const ranking = new MutualFundRankingService(funds, analysis, logger, 5);
  const result = await ranking.rank({
    category: "ELSS",
    plan: "direct",
    option: "growth",
    timeHorizonYears: 5,
    limit: 10,
  });

  assert.equal(result.quantitativeRankingOnly, true);
  assert.ok(result.eligibleFunds >= 2);
  assert.ok(result.excludedFunds >= 1);
  assert.deepEqual(
    result.ranking.map((item) => item.schemeCode),
    [101, 102],
  );
  assert.equal(result.ranking[0]?.rank, 1);
  assert.ok((result.ranking[0]?.quantScore ?? 0) >= (result.ranking[1]?.quantScore ?? 1));
  assert.equal(result.dataCoverage.expenseRatio, false);
  assert.equal(result.dataCoverage.aum, false);
});
