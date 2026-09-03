import assert from "node:assert/strict";
import { test } from "node:test";

import { createTradingPlaceOrderSkill } from "../../src/skills/trading-place-order/skill.js";
import type {
  KiteClientPort,
  KiteHolding,
  KiteInstrumentRecord,
  KiteOrder,
  KitePlaceOrderParams,
  KitePosition,
  KiteQuote,
} from "../../src/tools/kite/types.js";
import type { TradingScannerService } from "../../src/trading/scanner/trading-scanner-service.js";
import { TradingService } from "../../src/trading/trading-service.js";
import { InMemoryTradingRepository } from "./trading-test-support.js";

function fakeScanner(): TradingScannerService {
  return { scan: async () => { throw new Error("not used in this test"); } } as unknown as TradingScannerService;
}

class FakeKiteClient implements KiteClientPort {
  placedOrders: KitePlaceOrderParams[] = [];
  shouldFail = false;

  async getInstruments(): Promise<readonly KiteInstrumentRecord[]> {
    return [];
  }
  async getQuote(): Promise<Readonly<Record<string, KiteQuote>>> {
    return {};
  }
  async getHistoricalCandles() {
    return [];
  }
  async getHoldings(): Promise<readonly KiteHolding[]> {
    return [];
  }
  async getPositions(): Promise<{ net: readonly KitePosition[]; day: readonly KitePosition[] }> {
    return { net: [], day: [] };
  }
  async placeOrder(params: KitePlaceOrderParams): Promise<{ orderId: string }> {
    this.placedOrders.push(params);
    if (this.shouldFail) throw new Error("Simulated Kite rejection");
    return { orderId: "231000000123456" };
  }
  async cancelOrder(): Promise<void> {}
  async getOrders(): Promise<readonly KiteOrder[]> {
    return [];
  }
}

test("trading_place_order declares impact:sensitive with a confirmationReason", () => {
  const skill = createTradingPlaceOrderSkill(undefined, undefined);
  assert.equal(skill.execution.mutability, "write");
  assert.equal(skill.execution.impact, "sensitive");
  assert.ok(skill.execution.confirmationReason && skill.execution.confirmationReason.length > 0);
});

test("trading_place_order input validation requires price when orderType is LIMIT", () => {
  const skill = createTradingPlaceOrderSkill(undefined, undefined);
  const invalid = skill.inputSchema.safeParse({
    tradingsymbol: "RELIANCE",
    transactionType: "BUY",
    quantity: 1,
    orderType: "LIMIT",
  });
  assert.equal(invalid.success, false);

  const valid = skill.inputSchema.safeParse({
    tradingsymbol: "RELIANCE",
    transactionType: "BUY",
    quantity: 1,
    orderType: "LIMIT",
    price: 2500,
  });
  assert.equal(valid.success, true);

  const validMarket = skill.inputSchema.safeParse({
    tradingsymbol: "RELIANCE",
    transactionType: "BUY",
    quantity: 1,
  });
  assert.equal(validMarket.success, true);
});

test("trading_place_order calls Kite directly (no simulation) and records a submitted audit row on success", async () => {
  const client = new FakeKiteClient();
  const repository = new InMemoryTradingRepository();
  const tradingService = new TradingService({ scanner: fakeScanner(), repository });
  const skill = createTradingPlaceOrderSkill(client, tradingService);

  const result = await skill.execute(
    {
      tradingsymbol: "RELIANCE",
      exchange: "NSE",
      transactionType: "BUY",
      quantity: 5,
      orderType: "MARKET",
      product: "CNC",
    },
    {} as never,
  );

  assert.equal(result.success, true);
  assert.equal(client.placedOrders.length, 1);
  assert.equal(repository.recordedOrders.length, 1);
  assert.equal(repository.recordedOrders[0]?.status, "submitted");
  assert.equal(repository.recordedOrders[0]?.kiteOrderId, "231000000123456");
});

test("trading_place_order records a failed audit row and surfaces the error when Kite rejects the order", async () => {
  const client = new FakeKiteClient();
  client.shouldFail = true;
  const repository = new InMemoryTradingRepository();
  const tradingService = new TradingService({ scanner: fakeScanner(), repository });
  const skill = createTradingPlaceOrderSkill(client, tradingService);

  const result = await skill.execute(
    {
      tradingsymbol: "RELIANCE",
      exchange: "NSE",
      transactionType: "BUY",
      quantity: 5,
      orderType: "MARKET",
      product: "CNC",
    },
    {} as never,
  );

  assert.equal(result.success, false);
  assert.equal(repository.recordedOrders.length, 1);
  assert.equal(repository.recordedOrders[0]?.status, "failed");
});

test("trading_place_order fails clearly when Kite is not configured", async () => {
  const skill = createTradingPlaceOrderSkill(undefined, undefined);
  const result = await skill.execute(
    {
      tradingsymbol: "RELIANCE",
      exchange: "NSE",
      transactionType: "BUY",
      quantity: 1,
      orderType: "MARKET",
      product: "CNC",
    },
    {} as never,
  );
  assert.equal(result.success, false);
});
