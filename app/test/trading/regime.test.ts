import assert from "node:assert/strict";
import { test } from "node:test";

import { DEFAULT_TRADING_CONFIG } from "../../src/trading/config.js";
import { detectMarketRegime } from "../../src/trading/regime/market-regime-engine.js";
import { flatCandles, risingCandles, fallingCandles } from "./trading-test-support.js";

test("detectMarketRegime returns UNKNOWN with insufficient benchmark history", () => {
  const result = detectMarketRegime(flatCandles(10, 100), DEFAULT_TRADING_CONFIG);
  assert.equal(result.regime, "UNKNOWN");
  assert.ok(result.reasons.length > 0);
});

test("detectMarketRegime returns BULLISH for a strong sustained uptrend", () => {
  const candles = risingCandles(260, 100, 2, 1);
  const result = detectMarketRegime(candles, DEFAULT_TRADING_CONFIG);
  assert.equal(result.regime, "BULLISH");
  assert.ok(result.reasons.length > 0);
});

test("detectMarketRegime returns BEARISH for a strong sustained downtrend", () => {
  const candles = fallingCandles(260, 5_000, 2, 1);
  const result = detectMarketRegime(candles, DEFAULT_TRADING_CONFIG);
  assert.equal(result.regime, "BEARISH");
  assert.ok(result.reasons.length > 0);
});

test("detectMarketRegime returns SIDEWAYS for a flat, non-trending market", () => {
  // Enough history for EMA50/EMA200/ADX but essentially no directional move.
  const candles = flatCandles(260, 100);
  const result = detectMarketRegime(candles, DEFAULT_TRADING_CONFIG);
  assert.equal(result.regime, "SIDEWAYS");
});
