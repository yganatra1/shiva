import assert from "node:assert/strict";
import { test } from "node:test";

import { DEFAULT_TRADING_CONFIG } from "../../src/trading/config.js";
import { buildTechnicalSnapshot } from "../../src/trading/indicators/technical-snapshot.js";
import { detectMarketRegime } from "../../src/trading/regime/market-regime-engine.js";
import { BreakoutVolumeStrategy } from "../../src/trading/strategies/breakout-volume-strategy.js";
import type { Candle, StrategyEvaluationContext, TradingInstrument } from "../../src/trading/types.js";
import { candle, fallingCandles, risingCandles } from "./trading-test-support.js";

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

/** A liquid, established uptrend (satisfies EMA50>EMA200, ADX, liquidity) that
 * then breaks out on the final candle with `breakoutVolumeMultiplier`+ volume. */
function breakoutSeries(finalClose: number, finalVolume: number): Candle[] {
  const base = risingCandles(240, 200, 0.6, 1, 5_000_000);
  const lastPriorHigh = Math.max(...base.slice(-20).map((c) => c.high));
  base.push(
    candle(240, finalClose, {
      high: Math.max(finalClose + 1, lastPriorHigh + 1),
      low: finalClose - 1,
      volume: finalVolume,
    }),
  );
  return base;
}

test("BreakoutVolumeStrategy scores a valid breakout (price + volume expansion) well", () => {
  const benchmark = risingCandles(260, 20_000, 8, 5, 50_000_000);
  const stock = breakoutSeries(500, 20_000_000); // well above prior high, ~4x volume
  const context = contextFor(stock, benchmark);
  assert.equal(context.regime.regime, "BULLISH");
  const result = BreakoutVolumeStrategy.evaluate(context);
  assert.equal(result.eligible, true);
  assert.ok(result.score >= 50, `expected a solid score, got ${result.score}`);
});

test("BreakoutVolumeStrategy rejects a false breakout on weak volume", () => {
  const benchmark = risingCandles(260, 20_000, 8, 5, 50_000_000);
  // Price clears the prior high, but volume stays at the ~5M baseline (well
  // under the required breakoutVolumeMultiplier x 20-day average).
  const stock = breakoutSeries(500, 5_100_000);
  const context = contextFor(stock, benchmark);
  const result = BreakoutVolumeStrategy.evaluate(context);
  assert.equal(result.eligible, false);
  assert.match(result.reason ?? "", /volume/i);
});

test("previous-20-day-high used for the breakout check EXCLUDES the current candle", () => {
  // Construct a series whose current candle's own high is the highest ever
  // seen. If highestHigh wrongly included the current candle, close would
  // never exceed it and the strategy would incorrectly reject every case;
  // proving eligibility here proves the current candle was excluded.
  const benchmark = risingCandles(260, 20_000, 8, 5, 50_000_000);
  const base = risingCandles(240, 200, 0.6, 1, 5_000_000);
  const priorHigh = Math.max(...base.slice(-20).map((c) => c.high));
  const breakoutClose = priorHigh + 5;
  const current = candle(240, breakoutClose, {
    // The candle's own high (breakoutClose + 50) is far above priorHigh;
    // if the window included this candle, close could never clear its own high.
    high: breakoutClose + 50,
    low: breakoutClose - 1,
    volume: 20_000_000,
  });
  const stock = [...base, current];
  const context = contextFor(stock, benchmark);
  assert.equal(
    context.snapshot.highestHigh20ExcludingCurrent,
    priorHigh,
    "highestHigh20ExcludingCurrent must equal the prior window's max, not the current candle's own (much larger) high",
  );
  const result = BreakoutVolumeStrategy.evaluate(context);
  assert.equal(result.eligible, true);
});

test("BreakoutVolumeStrategy is ineligible in a BEARISH regime by default", () => {
  const benchmark = fallingCandles(260, 30_000, 8, 5, 50_000_000);
  const stock = breakoutSeries(500, 20_000_000);
  const context = contextFor(stock, benchmark);
  assert.equal(context.regime.regime, "BEARISH");
  const result = BreakoutVolumeStrategy.evaluate(context);
  assert.equal(result.eligible, false);
  assert.match(result.reason ?? "", /regime/i);
});

test("BreakoutVolumeStrategy is ineligible on an illiquid instrument", () => {
  const benchmark = risingCandles(260, 20_000, 8, 5, 50_000_000);
  const stock = breakoutSeries(500, 20_000_000).map((c) => ({ ...c, volume: 100 }));
  const context = contextFor(stock, benchmark);
  const result = BreakoutVolumeStrategy.evaluate(context);
  assert.equal(result.eligible, false);
});
