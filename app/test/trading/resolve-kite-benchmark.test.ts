import assert from "node:assert/strict";
import { test } from "node:test";

import { createKiteBenchmarkInstrumentResolver } from "../../src/trading/universe/resolve-kite-benchmark.js";
import type { KiteClientPort, KiteInstrumentRecord } from "../../src/tools/kite/types.js";

function fakeClient(records: readonly KiteInstrumentRecord[]): KiteClientPort & { calls: number } {
  let calls = 0;
  return {
    calls,
    async getInstruments() {
      calls += 1;
      this.calls = calls;
      return records;
    },
    async getQuote() {
      return {};
    },
    async getHistoricalCandles() {
      return [];
    },
    async getHoldings() {
      return [];
    },
    async getPositions() {
      return { net: [], day: [] };
    },
    async placeOrder() {
      return { orderId: "x" };
    },
    async cancelOrder() {},
    async getOrders() {
      return [];
    },
  };
}

test("resolves the benchmark's real instrument token from the Kite dump, case-insensitively", async () => {
  const client = fakeClient([
    {
      instrumentToken: 256265,
      tradingsymbol: "NIFTY 50",
      name: "NIFTY 50",
      exchange: "NSE",
      instrumentType: "EQ",
      segment: "INDICES",
    },
  ]);
  const resolve = createKiteBenchmarkInstrumentResolver(client, "NSE", "nifty 50");

  const instrument = await resolve();

  assert.deepEqual(instrument, {
    instrumentToken: 256265,
    exchange: "NSE",
    tradingsymbol: "NIFTY 50",
    name: "NIFTY 50",
  });
});

test("caches the resolved instrument across calls instead of refetching the dump", async () => {
  const client = fakeClient([
    {
      instrumentToken: 256265,
      tradingsymbol: "NIFTY 50",
      name: "NIFTY 50",
      exchange: "NSE",
      instrumentType: "EQ",
      segment: "INDICES",
    },
  ]);
  const resolve = createKiteBenchmarkInstrumentResolver(client, "NSE", "NIFTY 50");

  await resolve();
  await resolve();

  assert.equal(client.calls, 1);
});

test("falls back to instrumentToken 0 with a clear reason when the benchmark symbol is not found", async () => {
  const client = fakeClient([]);
  const resolve = createKiteBenchmarkInstrumentResolver(client, "NSE", "NIFTY 50");

  const instrument = await resolve();

  assert.equal(instrument.instrumentToken, 0);
  assert.equal(instrument.tradingsymbol, "NIFTY 50");
});
