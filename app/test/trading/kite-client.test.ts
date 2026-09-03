import assert from "node:assert/strict";
import { test } from "node:test";

import { generateSession, KiteClient } from "../../src/tools/kite/client.js";
import { KiteClientError } from "../../src/tools/kite/types.js";

const CSV = [
  "instrument_token,exchange_token,tradingsymbol,name,last_price,expiry,strike,tick_size,lot_size,instrument_type,segment,exchange",
  "128083204,500325,RELIANCE,RELIANCE INDUSTRIES,0,,0,0.05,1,EQ,NSE,NSE",
  "738561,2885,TCS,TATA CONSULTANCY SERVICES,0,,0,0.05,1,EQ,NSE,NSE",
].join("\n");

function fakeFetch(
  handler: (url: URL, init: RequestInit | undefined) => { status: number; body: string; contentType: string },
): typeof fetch {
  return (async (input: string | URL | Request, init?: RequestInit) => {
    const url = input instanceof URL ? input : new URL(String(input));
    const result = handler(url, init);
    return new Response(result.body, {
      status: result.status,
      headers: { "content-type": result.contentType },
    });
  }) as typeof fetch;
}

test("KiteClient.getInstruments parses the CSV response into typed records", async () => {
  let capturedUrl: URL | undefined;
  let capturedAuth: string | undefined;
  const client = new KiteClient({
    apiKey: "key123",
    accessToken: "token456",
    requestTimeoutMs: 5_000,
    fetchFunction: fakeFetch((url, init) => {
      capturedUrl = url;
      capturedAuth = (init?.headers as Record<string, string> | undefined)?.["Authorization"];
      return { status: 200, body: CSV, contentType: "text/csv" };
    }),
  });

  const instruments = await client.getInstruments("NSE");

  assert.equal(capturedUrl?.pathname, "/instruments/NSE");
  assert.equal(capturedAuth, "token key123:token456");
  assert.equal(instruments.length, 2);
  assert.deepEqual(instruments[0], {
    instrumentToken: 128083204,
    tradingsymbol: "RELIANCE",
    name: "RELIANCE INDUSTRIES",
    exchange: "NSE",
    instrumentType: "EQ",
    segment: "NSE",
  });
});

test("KiteClient.getQuote unwraps data and builds the i= query string per key", async () => {
  let capturedUrl: URL | undefined;
  const client = new KiteClient({
    apiKey: "key123",
    accessToken: "token456",
    requestTimeoutMs: 5_000,
    fetchFunction: fakeFetch((url) => {
      capturedUrl = url;
      return {
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          status: "success",
          data: {
            "NSE:INFY": { instrument_token: 408065, last_price: 1500.5, timestamp: "2024-01-01 10:00:00" },
            "NSE:TCS": { instrument_token: 738561, last_price: 3800.25 },
          },
        }),
      };
    }),
  });

  const quotes = await client.getQuote(["NSE:INFY", "NSE:TCS"]);

  assert.equal(capturedUrl?.searchParams.getAll("i").join(","), "NSE:INFY,NSE:TCS");
  assert.equal(quotes["NSE:INFY"]?.lastPrice, 1500.5);
  assert.equal(quotes["NSE:TCS"]?.instrumentToken, 738561);
});

test("KiteClient.getHistoricalCandles builds from/to query params and unwraps candles", async () => {
  let capturedUrl: URL | undefined;
  const client = new KiteClient({
    apiKey: "key123",
    accessToken: "token456",
    requestTimeoutMs: 5_000,
    fetchFunction: fakeFetch((url) => {
      capturedUrl = url;
      return {
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          status: "success",
          data: {
            candles: [
              ["2024-01-01T00:00:00+0530", 100, 105, 95, 102, 10_000],
              ["2024-01-02T00:00:00+0530", 102, 108, 100, 106, 12_000],
            ],
          },
        }),
      };
    }),
  });

  const candles = await client.getHistoricalCandles(408065, "day", "2024-01-01", "2024-01-02");

  assert.equal(capturedUrl?.pathname, "/instruments/historical/408065/day");
  assert.equal(capturedUrl?.searchParams.get("from"), "2024-01-01");
  assert.equal(capturedUrl?.searchParams.get("to"), "2024-01-02");
  assert.equal(candles.length, 2);
  assert.equal(candles[0]?.[4], 102);
});

test("KiteClient surfaces a 401/403 as an UNAUTHORIZED KiteClientError", async () => {
  const client = new KiteClient({
    apiKey: "key123",
    accessToken: "expired",
    requestTimeoutMs: 5_000,
    fetchFunction: fakeFetch(() => ({ status: 403, contentType: "application/json", body: "{}" })),
  });
  await assert.rejects(
    () => client.getInstruments("NSE"),
    (error: unknown) => {
      assert.ok(error && typeof error === "object" && "code" in error);
      assert.equal((error as { code: string }).code, "UNAUTHORIZED");
      return true;
    },
  );
});

test("KiteClient surfaces Kite's actual error_type/message instead of a bare status code", async () => {
  const client = new KiteClient({
    apiKey: "key123",
    accessToken: "expired",
    requestTimeoutMs: 5_000,
    fetchFunction: fakeFetch(() => ({
      status: 403,
      contentType: "application/json",
      body: JSON.stringify({
        status: "error",
        error_type: "TokenException",
        message: "Incorrect `api_key` or `access_token`.",
      }),
    })),
  });
  await assert.rejects(
    () => client.getInstruments("NSE"),
    (error: unknown) => {
      assert.ok(error instanceof KiteClientError);
      assert.equal(error.kiteErrorType, "TokenException");
      assert.equal(error.httpStatus, 403);
      assert.match(error.message, /TokenException/);
      assert.match(error.message, /Incorrect `api_key` or `access_token`\./);
      return true;
    },
  );
});

test("generateSession computes the SHA-256 checksum and posts form-encoded fields", async () => {
  let capturedBody: string | undefined;
  let capturedUrl: string | undefined;
  const fetchFunction = (async (input: string | URL | Request, init?: RequestInit) => {
    capturedUrl = String(input);
    capturedBody = String(init?.body);
    return new Response(JSON.stringify({ data: { access_token: "abc123" } }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;

  const result = await generateSession({
    apiKey: "key123",
    apiSecret: "secret456",
    requestToken: "reqtoken789",
    fetchFunction,
  });

  assert.equal(result.accessToken, "abc123");
  assert.equal(capturedUrl, "https://api.kite.trade/session/token");
  assert.ok(capturedBody?.includes("api_key=key123"));
  assert.ok(capturedBody?.includes("request_token=reqtoken789"));
  assert.ok(capturedBody?.includes("checksum="));
});

test("KiteClient.getHoldings maps the data array into typed holdings", async () => {
  let capturedUrl: URL | undefined;
  const client = new KiteClient({
    apiKey: "key123",
    accessToken: "token456",
    requestTimeoutMs: 5_000,
    fetchFunction: fakeFetch((url) => {
      capturedUrl = url;
      return {
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          data: [
            {
              tradingsymbol: "RELIANCE",
              exchange: "NSE",
              isin: "INE002A01018",
              quantity: 10,
              average_price: 2500,
              last_price: 2600,
              pnl: 1000,
              product: "CNC",
            },
          ],
        }),
      };
    }),
  });

  const holdings = await client.getHoldings();

  assert.equal(capturedUrl?.pathname, "/portfolio/holdings");
  assert.deepEqual(holdings[0], {
    tradingsymbol: "RELIANCE",
    exchange: "NSE",
    isin: "INE002A01018",
    quantity: 10,
    averagePrice: 2500,
    lastPrice: 2600,
    pnl: 1000,
    product: "CNC",
  });
});

test("KiteClient.getPositions maps net and day arrays into typed positions", async () => {
  let capturedUrl: URL | undefined;
  const client = new KiteClient({
    apiKey: "key123",
    accessToken: "token456",
    requestTimeoutMs: 5_000,
    fetchFunction: fakeFetch((url) => {
      capturedUrl = url;
      return {
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          data: {
            net: [
              {
                tradingsymbol: "TCS",
                exchange: "NSE",
                product: "MIS",
                quantity: 5,
                average_price: 3800,
                last_price: 3820,
                pnl: 100,
              },
            ],
            day: [],
          },
        }),
      };
    }),
  });

  const positions = await client.getPositions();

  assert.equal(capturedUrl?.pathname, "/portfolio/positions");
  assert.equal(positions.net.length, 1);
  assert.equal(positions.net[0]?.tradingsymbol, "TCS");
  assert.equal(positions.day.length, 0);
});

test("KiteClient logs holdings response diagnostics without leaking portfolio values", async () => {
  const logs: { level: string; fields: Record<string, unknown>; message: string }[] = [];
  const logger = {
    info: (fields: Record<string, unknown>, message: string) => logs.push({ level: "info", fields, message }),
    warn: (fields: Record<string, unknown>, message: string) => logs.push({ level: "warn", fields, message }),
  };
  const client = new KiteClient({
    apiKey: "key123",
    accessToken: "token456",
    requestTimeoutMs: 5_000,
    logger,
    fetchFunction: fakeFetch(() => ({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        data: [
          {
            tradingsymbol: "RELIANCE",
            exchange: "NSE",
            isin: "INE002A01018",
            quantity: 10,
            average_price: 2500,
            last_price: 2600,
            pnl: 1000,
            product: "CNC",
          },
        ],
      }),
    })),
  });

  await client.getHoldings();

  assert.equal(logs.length, 1);
  assert.equal(logs[0]?.level, "info");
  assert.equal(logs[0]?.fields.endpoint, "portfolio/holdings");
  assert.equal(logs[0]?.fields.status, 200);
  assert.deepEqual(logs[0]?.fields.body, { recordCount: 1 });
  const serialized = JSON.stringify(logs[0]?.fields);
  assert.ok(!serialized.includes("INE002A01018"), "ISIN must not appear in the log");
  assert.ok(!serialized.includes("2500"), "portfolio values must not appear in the log");
  assert.ok(!serialized.includes("token456"), "access token must not appear in the log");
});

test("KiteClient logs positions error responses with a sanitized body and redacted headers only", async () => {
  const logs: { level: string; fields: Record<string, unknown>; message: string }[] = [];
  const logger = {
    info: (fields: Record<string, unknown>, message: string) => logs.push({ level: "info", fields, message }),
    warn: (fields: Record<string, unknown>, message: string) => logs.push({ level: "warn", fields, message }),
  };
  const client = new KiteClient({
    apiKey: "key123",
    accessToken: "expired",
    requestTimeoutMs: 5_000,
    logger,
    fetchFunction: async () =>
      new Response(
        JSON.stringify({ status: "error", error_type: "TokenException", message: "Invalid access token." }),
        {
          status: 403,
          headers: {
            "content-type": "application/json",
            "set-cookie": "session=abc123; HttpOnly",
            "x-request-id": "req-42",
          },
        },
      ),
  });

  await assert.rejects(() => client.getPositions());

  assert.equal(logs.length, 1);
  assert.equal(logs[0]?.level, "warn");
  assert.equal(logs[0]?.fields.endpoint, "portfolio/positions");
  assert.equal(logs[0]?.fields.status, 403);
  assert.deepEqual(logs[0]?.fields.headers, {
    "content-type": "application/json",
    "x-request-id": "req-42",
  });
  assert.deepEqual(logs[0]?.fields.body, {
    status: "error",
    error_type: "TokenException",
    message: "Invalid access token.",
  });
});

test("KiteClient.placeOrder posts a form-encoded body to /orders/<variety> and returns the order id", async () => {
  let capturedUrl: URL | undefined;
  let capturedMethod: string | undefined;
  let capturedBody: string | undefined;
  let capturedContentType: string | undefined;
  const client = new KiteClient({
    apiKey: "key123",
    accessToken: "token456",
    requestTimeoutMs: 5_000,
    fetchFunction: fakeFetch((url, init) => {
      capturedUrl = url;
      capturedMethod = init?.method;
      capturedBody = String(init?.body);
      capturedContentType = (init?.headers as Record<string, string> | undefined)?.["content-type"];
      return {
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ data: { order_id: "231000000123456" } }),
      };
    }),
  });

  const result = await client.placeOrder({
    tradingsymbol: "RELIANCE",
    exchange: "NSE",
    transactionType: "BUY",
    orderType: "LIMIT",
    quantity: 5,
    product: "CNC",
    price: 2500.5,
  });

  assert.equal(result.orderId, "231000000123456");
  assert.equal(capturedUrl?.pathname, "/orders/regular");
  assert.equal(capturedMethod, "POST");
  assert.equal(capturedContentType, "application/x-www-form-urlencoded");
  const body = new URLSearchParams(capturedBody);
  assert.equal(body.get("tradingsymbol"), "RELIANCE");
  assert.equal(body.get("transaction_type"), "BUY");
  assert.equal(body.get("order_type"), "LIMIT");
  assert.equal(body.get("quantity"), "5");
  assert.equal(body.get("product"), "CNC");
  assert.equal(body.get("price"), "2500.5");
  assert.equal(body.get("validity"), "DAY");
});

test("KiteClient.placeOrder omits price for a MARKET order", async () => {
  let capturedBody: string | undefined;
  const client = new KiteClient({
    apiKey: "key123",
    accessToken: "token456",
    requestTimeoutMs: 5_000,
    fetchFunction: fakeFetch((_url, init) => {
      capturedBody = String(init?.body);
      return {
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ data: { order_id: "abc" } }),
      };
    }),
  });

  await client.placeOrder({
    tradingsymbol: "TCS",
    exchange: "NSE",
    transactionType: "SELL",
    orderType: "MARKET",
    quantity: 1,
    product: "MIS",
  });

  const body = new URLSearchParams(capturedBody);
  assert.equal(body.has("price"), false);
});

test("KiteClient.cancelOrder issues a DELETE to /orders/<variety>/<orderId>", async () => {
  let capturedUrl: URL | undefined;
  let capturedMethod: string | undefined;
  const client = new KiteClient({
    apiKey: "key123",
    accessToken: "token456",
    requestTimeoutMs: 5_000,
    fetchFunction: fakeFetch((url, init) => {
      capturedUrl = url;
      capturedMethod = init?.method;
      return { status: 200, contentType: "application/json", body: JSON.stringify({ data: {} }) };
    }),
  });

  await client.cancelOrder("231000000123456");

  assert.equal(capturedUrl?.pathname, "/orders/regular/231000000123456");
  assert.equal(capturedMethod, "DELETE");
});

test("KiteClient.getOrders maps the data array into typed orders", async () => {
  const client = new KiteClient({
    apiKey: "key123",
    accessToken: "token456",
    requestTimeoutMs: 5_000,
    fetchFunction: fakeFetch(() => ({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        data: [
          {
            order_id: "231000000123456",
            tradingsymbol: "RELIANCE",
            exchange: "NSE",
            transaction_type: "BUY",
            quantity: 5,
            order_type: "LIMIT",
            product: "CNC",
            status: "COMPLETE",
            price: 2500.5,
          },
        ],
      }),
    })),
  });

  const orders = await client.getOrders();

  assert.equal(orders.length, 1);
  assert.equal(orders[0]?.orderId, "231000000123456");
  assert.equal(orders[0]?.status, "COMPLETE");
});
