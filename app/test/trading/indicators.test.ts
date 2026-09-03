import assert from "node:assert/strict";
import { test } from "node:test";

import { calculateAdx14 } from "../../src/trading/indicators/adx.js";
import { calculateAtr14 } from "../../src/trading/indicators/atr.js";
import { calculateEma } from "../../src/trading/indicators/ema.js";
import { calculateMomentum } from "../../src/trading/indicators/momentum.js";
import { calculateRelativeStrength } from "../../src/trading/indicators/relative-strength.js";
import { calculateRsi14 } from "../../src/trading/indicators/rsi.js";
import { averageVolume, highestHigh } from "../../src/trading/indicators/volume.js";
import { candle, risingCandles } from "./trading-test-support.js";

test("calculateEma matches a hand-computed value (period=3, seeded SMA then Wilder-style EMA blend)", () => {
  const candles = [1, 2, 3, 4, 5].map((close, i) => candle(i, close));
  // seed = avg(1,2,3) = 2; multiplier = 0.5
  // i=3: 4*0.5 + 2*0.5 = 3
  // i=4: 5*0.5 + 3*0.5 = 4
  assert.equal(calculateEma(candles, 3), 4);
});

test("calculateEma returns undefined with insufficient history", () => {
  const candles = [1, 2].map((close, i) => candle(i, close));
  assert.equal(calculateEma(candles, 3), undefined);
});

test("calculateRsi14 is 100 when every move is a gain", () => {
  const candles = [1, 2, 3, 4, 5, 6].map((close, i) => candle(i, close));
  assert.equal(calculateRsi14(candles, 5), 100);
});

test("calculateRsi14 is 0 when every move is a loss", () => {
  const candles = [6, 5, 4, 3, 2, 1].map((close, i) => candle(i, close));
  assert.equal(calculateRsi14(candles, 5), 0);
});

test("calculateRsi14 matches a hand-computed value for an alternating series", () => {
  // closes: 10, 11, 10, 11, 10 -> deltas +1,-1,+1,-1 -> avgGain=0.5, avgLoss=0.5 -> RSI=50
  const candles = [10, 11, 10, 11, 10].map((close, i) => candle(i, close));
  assert.equal(calculateRsi14(candles, 4), 50);
});

test("calculateAtr14 matches a hand-computed value for a constant true-range series", () => {
  // high=105, low=95, close=100 for every candle -> TR = max(10, |105-100|, |95-100|) = 10
  const candles = Array.from({ length: 6 }, (_, i) =>
    candle(i, 100, { high: 105, low: 95 }),
  );
  assert.equal(calculateAtr14(candles, 5), 10);
});

test("calculateAtr14 returns undefined with insufficient history", () => {
  const candles = Array.from({ length: 3 }, (_, i) => candle(i, 100, { high: 105, low: 95 }));
  assert.equal(calculateAtr14(candles, 5), undefined);
});

test("calculateAdx14 shows a strong uptrend as +DI dominant with insufficient history returning undefined otherwise", () => {
  const trending = risingCandles(40, 100, 2, 1);
  const result = calculateAdx14(trending, 14);
  assert.ok(result, "expected a defined ADX result for a long trending series");
  assert.ok(result.plusDi > result.minusDi, "+DI should dominate in an uptrend");
  assert.ok(result.adx > 0 && result.adx <= 100);

  const short = risingCandles(10, 100, 2, 1);
  assert.equal(calculateAdx14(short, 14), undefined);
});

test("calculateMomentum matches (close_t / close_t-N - 1)", () => {
  const candles = [100, 100, 100, 100, 100, 130].map((close, i) => candle(i, close));
  // 5 candles back from index 5 is index 0 (close=100); 130/100 - 1 = 0.3
  const momentum = calculateMomentum(candles, 5);
  assert.ok(momentum !== undefined);
  assert.ok(Math.abs((momentum as number) - 0.3) < 1e-9);
});

test("calculateMomentum returns undefined without N+1 candles", () => {
  const candles = [100, 110].map((close, i) => candle(i, close));
  assert.equal(calculateMomentum(candles, 5), undefined);
});

test("calculateRelativeStrength is the stock's N-period return minus the benchmark's N-period return, not RSI", () => {
  const stock = [100, 100, 100, 100, 100, 120].map((close, i) => candle(i, close)); // +20%
  const benchmark = [100, 100, 100, 100, 100, 110].map((close, i) => candle(i, close)); // +10%
  const relativeStrength = calculateRelativeStrength(stock, benchmark, 5);
  assert.ok(relativeStrength !== undefined);
  assert.ok(Math.abs((relativeStrength as number) - 0.1) < 1e-9);
});

test("highestHigh EXCLUDES the most recent candle (look-ahead bias)", () => {
  // 5 prior candles with highs 10,11,12,13,14, then a current candle whose
  // high (100) must NOT be included in the window.
  const candles = [10, 11, 12, 13, 14].map((high, i) => candle(i, high - 1, { high }));
  candles.push(candle(5, 200, { high: 1_000 }));
  assert.equal(highestHigh(candles, 5), 14);
});

test("averageVolume EXCLUDES the most recent candle (look-ahead bias)", () => {
  const candles = [1, 2, 3, 4, 5].map((_, i) => candle(i, 100, { volume: 1_000 }));
  candles.push(candle(5, 100, { volume: 1_000_000 }));
  assert.equal(averageVolume(candles, 5), 1_000);
});
