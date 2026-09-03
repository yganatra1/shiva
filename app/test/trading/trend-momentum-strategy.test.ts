import assert from "node:assert/strict";
import { test } from "node:test";

import { DEFAULT_TRADING_CONFIG } from "../../src/trading/config.js";
import { buildTechnicalSnapshot } from "../../src/trading/indicators/technical-snapshot.js";
import { detectMarketRegime } from "../../src/trading/regime/market-regime-engine.js";
import { TrendMomentumStrategy } from "../../src/trading/strategies/trend-momentum-strategy.js";
import type { Candle, StrategyEvaluationContext, TradingInstrument } from "../../src/trading/types.js";
import { fallingCandles, flatCandles, risingCandles } from "./trading-test-support.js";

const instrument: TradingInstrument = {
  instrumentToken: 1,
  exchange: "NSE",
  tradingsymbol: "TESTCO",
};

function contextFor(
  candles: readonly Candle[],
  benchmarkCandles: readonly Candle[],
): StrategyEvaluationContext {
  const regime = detectMarketRegime(benchmarkCandles, DEFAULT_TRADING_CONFIG);
  const snapshot = buildTechnicalSnapshot(candles, benchmarkCandles, DEFAULT_TRADING_CONFIG);
  return { instrument, candles, benchmarkCandles, snapshot, regime, config: DEFAULT_TRADING_CONFIG };
}

test("TrendMomentumStrategy scores a strong, liquid, bullish-trend stock highly", () => {
  const benchmark = risingCandles(260, 20_000, 8, 5, 50_000_000);
  const stock = risingCandles(260, 200, 1.2, 1, 5_000_000);
  const context = contextFor(stock, benchmark);
  assert.equal(context.regime.regime, "BULLISH");
  const result = TrendMomentumStrategy.evaluate(context);
  assert.equal(result.eligible, true);
  assert.ok(result.score >= 50, `expected a high score, got ${result.score}`);
  assert.ok(result.components.length === 6);
});

test("TrendMomentumStrategy scores a weak/flat stock low even in a bullish regime", () => {
  const benchmark = risingCandles(260, 20_000, 8, 5, 50_000_000);
  const stock = flatCandles(260, 200, 5_000_000);
  const context = contextFor(stock, benchmark);
  const result = TrendMomentumStrategy.evaluate(context);
  // Flat close means close===EMA20===EMA50===EMA200, no ordering credit, and
  // momentum/relative-strength are ~0, so the score should stay very low.
  if (result.eligible) {
    assert.ok(result.score < 40, `expected a low score, got ${result.score}`);
  }
});

test("TrendMomentumStrategy is ineligible on insufficient candle history", () => {
  const benchmark = risingCandles(260, 20_000, 8, 5, 50_000_000);
  const stock = risingCandles(10, 200, 1, 1, 5_000_000);
  const context = contextFor(stock, benchmark);
  const result = TrendMomentumStrategy.evaluate(context);
  assert.equal(result.eligible, false);
  assert.ok(result.reason);
});

test("TrendMomentumStrategy is ineligible on an illiquid instrument", () => {
  const benchmark = risingCandles(260, 20_000, 8, 5, 50_000_000);
  const stock = risingCandles(260, 200, 1.2, 1, 100); // far below minimumAverageVolume
  const context = contextFor(stock, benchmark);
  const result = TrendMomentumStrategy.evaluate(context);
  assert.equal(result.eligible, false);
  assert.match(result.reason ?? "", /liquidity|average traded value|average volume|price/i);
});

test("TrendMomentumStrategy is ineligible in a BEARISH regime by default", () => {
  const benchmark = fallingCandles(260, 30_000, 8, 5, 50_000_000);
  const stock = risingCandles(260, 200, 1.2, 1, 5_000_000);
  const context = contextFor(stock, benchmark);
  assert.equal(context.regime.regime, "BEARISH");
  const result = TrendMomentumStrategy.evaluate(context);
  assert.equal(result.eligible, false);
  assert.match(result.reason ?? "", /regime/i);
});
