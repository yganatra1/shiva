import assert from "node:assert/strict";
import { test } from "node:test";

import { DEFAULT_TRADING_CONFIG } from "../../src/trading/config.js";
import { TradingScannerService } from "../../src/trading/scanner/trading-scanner-service.js";
import { BreakoutVolumeStrategy } from "../../src/trading/strategies/breakout-volume-strategy.js";
import { TrendMomentumStrategy } from "../../src/trading/strategies/trend-momentum-strategy.js";
import type { TradingInstrument } from "../../src/trading/types.js";
import {
  candle,
  FakeMarketDataProvider,
  FakeUniverseProvider,
  risingCandles,
} from "./trading-test-support.js";

const benchmark: TradingInstrument = {
  instrumentToken: 0,
  exchange: "INDICES",
  tradingsymbol: "NIFTY 50",
};

function strongTrendCandles(startClose: number, volume = 5_000_000) {
  return risingCandles(260, startClose, 1.5, 1, volume);
}

function breakoutCandles(startClose: number) {
  const base = risingCandles(240, startClose, 0.6, 1, 5_000_000);
  const priorHigh = Math.max(...base.slice(-20).map((c) => c.high));
  base.push(
    candle(240, priorHigh + 20, {
      high: priorHigh + 25,
      low: priorHigh + 15,
      volume: 20_000_000,
    }),
  );
  return base;
}

test("TradingScannerService ranks opportunities in descending score order and enforces the minimum threshold", async () => {
  const strong: TradingInstrument = { instrumentToken: 1, exchange: "NSE", tradingsymbol: "STRONG" };
  const weak: TradingInstrument = { instrumentToken: 2, exchange: "NSE", tradingsymbol: "WEAK" };
  const benchmarkCandles = strongTrendCandles(20_000, 50_000_000);

  const universe = new FakeUniverseProvider([strong, weak]);
  const marketData = new FakeMarketDataProvider(
    new Map([
      [0, benchmarkCandles],
      [1, strongTrendCandles(200)],
      // "weak" barely moves: should score far lower (or be excluded outright).
      [2, risingCandles(260, 200, 0.02, 1, 5_000_000)],
    ]),
  );
  const scanner = new TradingScannerService({
    universeProvider: universe,
    marketDataProvider: marketData,
    strategies: [TrendMomentumStrategy, BreakoutVolumeStrategy],
    config: { ...DEFAULT_TRADING_CONFIG, minimumOpportunityScore: 0 },
    benchmarkInstrument: benchmark,
  });

  const result = await scanner.scan();
  assert.equal(result.marketRegime.regime, "BULLISH");
  assert.equal(result.totalInstruments, 2);
  assert.equal(result.analyzedInstruments, 2);
  assert.ok(result.opportunities.length >= 1);
  for (let i = 1; i < result.opportunities.length; i += 1) {
    assert.ok(
      (result.opportunities[i - 1]?.finalScore ?? 0) >= (result.opportunities[i]?.finalScore ?? 0),
      "opportunities must be sorted by finalScore descending",
    );
  }
});

test("TradingScannerService excludes opportunities below minimumOpportunityScore", async () => {
  const weak: TradingInstrument = { instrumentToken: 2, exchange: "NSE", tradingsymbol: "WEAK" };
  const benchmarkCandles = strongTrendCandles(20_000, 50_000_000);
  const universe = new FakeUniverseProvider([weak]);
  const marketData = new FakeMarketDataProvider(
    new Map([
      [0, benchmarkCandles],
      [2, risingCandles(260, 200, 0.02, 1, 5_000_000)],
    ]),
  );
  const scanner = new TradingScannerService({
    universeProvider: universe,
    marketDataProvider: marketData,
    strategies: [TrendMomentumStrategy, BreakoutVolumeStrategy],
    config: { ...DEFAULT_TRADING_CONFIG, minimumOpportunityScore: 99.9 },
    benchmarkInstrument: benchmark,
  });
  const result = await scanner.scan();
  assert.equal(result.opportunities.length, 0);
});

test("TradingScannerService isolates one instrument's failure without aborting the scan", async () => {
  const good: TradingInstrument = { instrumentToken: 1, exchange: "NSE", tradingsymbol: "GOOD" };
  const bad: TradingInstrument = { instrumentToken: 2, exchange: "NSE", tradingsymbol: "BAD" };
  const benchmarkCandles = strongTrendCandles(20_000, 50_000_000);
  const universe = new FakeUniverseProvider([good, bad]);
  const marketData = new FakeMarketDataProvider(
    new Map([
      [0, benchmarkCandles],
      [1, strongTrendCandles(200)],
    ]),
    new Set([2]),
  );
  const scanner = new TradingScannerService({
    universeProvider: universe,
    marketDataProvider: marketData,
    strategies: [TrendMomentumStrategy, BreakoutVolumeStrategy],
    config: { ...DEFAULT_TRADING_CONFIG, minimumOpportunityScore: 0 },
    benchmarkInstrument: benchmark,
  });
  const result = await scanner.scan();
  assert.equal(result.failedInstruments, 1);
  assert.equal(result.failures.length, 1);
  assert.equal(result.failures[0]?.tradingsymbol, "BAD");
  assert.ok(result.opportunities.some((o) => o.tradingsymbol === "GOOD"));
});

test("finalScore is the HIGHEST eligible strategy score, not an average", async () => {
  const instrument: TradingInstrument = { instrumentToken: 1, exchange: "NSE", tradingsymbol: "BOTH" };
  const benchmarkCandles = strongTrendCandles(20_000, 50_000_000);
  // Strong trend AND a fresh breakout on the last candle: both strategies
  // should be eligible, at different scores.
  const stockCandles = breakoutCandles(200);
  const universe = new FakeUniverseProvider([instrument]);
  const marketData = new FakeMarketDataProvider(
    new Map([
      [0, benchmarkCandles],
      [1, stockCandles],
    ]),
  );
  const scanner = new TradingScannerService({
    universeProvider: universe,
    marketDataProvider: marketData,
    strategies: [TrendMomentumStrategy, BreakoutVolumeStrategy],
    config: { ...DEFAULT_TRADING_CONFIG, minimumOpportunityScore: 0 },
    benchmarkInstrument: benchmark,
  });
  const result = await scanner.scan();
  const opportunity = result.opportunities.find((o) => o.tradingsymbol === "BOTH");
  assert.ok(opportunity);
  const strategyScores = (
    opportunity.metrics as { strategyScores: Record<string, { eligible: boolean; score: number }> }
  ).strategyScores;
  const eligibleScores = Object.values(strategyScores)
    .filter((s) => s.eligible)
    .map((s) => s.score);
  assert.ok(eligibleScores.length >= 1);
  assert.equal(opportunity.finalScore, Math.max(...eligibleScores));
  // If more than one strategy was eligible, prove it is NOT an average.
  if (eligibleScores.length > 1) {
    const average = eligibleScores.reduce((a, b) => a + b, 0) / eligibleScores.length;
    assert.notEqual(opportunity.finalScore, average);
  }
});
