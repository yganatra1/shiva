import { createHash } from "node:crypto";

import {
  KiteClientError,
  type KiteCandleRow,
  type KiteClientPort,
  type KiteHolding,
  type KiteInstrumentRecord,
  type KiteOrder,
  type KitePlaceOrderParams,
  type KitePosition,
  type KiteQuote,
} from "./types";

export interface KiteClientOptions {
  readonly apiKey: string;
  readonly accessToken: string;
  readonly baseUrl?: string;
  readonly requestTimeoutMs: number;
  readonly fetchFunction?: typeof fetch;
}

const DEFAULT_BASE_URL = "https://api.kite.trade";

/**
 * Kite Connect HTTP client covering market data, portfolio reads, and plain
 * equity order placement/cancellation (see KiteClientPort) — no CE/PE,
 * options, or short-selling surface exists here. Mirrors the
 * setTimeout().unref() + injectable fetchFunction shape used throughout
 * app/src/tools (see tools/web/search.ts) so it stays test-friendly without
 * any real network access. Order placement/cancellation is only ever
 * invoked from trading_place_order/trading_cancel_order, which are
 * declared impact:"sensitive" so Shiva's existing confirmation flow gates
 * them before this client is called — this class itself performs no
 * simulation or dry-run, it always calls the real Kite endpoint.
 */
export class KiteClient implements KiteClientPort {
  private readonly baseUrl: string;
  private readonly fetchFunction: typeof fetch;

  constructor(private readonly options: KiteClientOptions) {
    if (!options.apiKey.trim()) throw new Error("A Kite API key is required.");
    if (!options.accessToken.trim()) throw new Error("A Kite access token is required.");
    this.baseUrl = (options.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, "");
    this.fetchFunction = options.fetchFunction ?? fetch;
  }

  async getInstruments(exchange: string): Promise<readonly KiteInstrumentRecord[]> {
    const url = new URL(`${this.baseUrl}/instruments/${encodeURIComponent(exchange)}`);
    const response = await this.request(url);
    const text = await readText(response);
    return parseInstrumentsCsv(text);
  }

  async getQuote(
    instrumentKeys: readonly string[],
  ): Promise<Readonly<Record<string, KiteQuote>>> {
    // Kite allows up to 500 `i=` params per call; this phase does not chunk
    // requests larger than that — callers must batch accordingly themselves.
    const url = new URL(`${this.baseUrl}/quote`);
    for (const key of instrumentKeys) url.searchParams.append("i", key);
    const response = await this.request(url);
    const payload = await readJson(response);
    const data = (payload as { data?: Record<string, unknown> }).data ?? {};
    const result: Record<string, KiteQuote> = {};
    for (const [key, value] of Object.entries(data)) {
      const row = value as {
        instrument_token?: number;
        last_price?: number;
        timestamp?: string;
      };
      if (typeof row.instrument_token !== "number" || typeof row.last_price !== "number") {
        continue;
      }
      result[key] = {
        instrumentToken: row.instrument_token,
        lastPrice: row.last_price,
        ...(row.timestamp ? { timestamp: row.timestamp } : {}),
      };
    }
    return result;
  }

  async getHistoricalCandles(
    instrumentToken: number,
    interval: string,
    from: string,
    to: string,
  ): Promise<readonly KiteCandleRow[]> {
    const path = `/instruments/historical/${instrumentToken}/${encodeURIComponent(interval)}`;
    const url = new URL(`${this.baseUrl}${path}`);
    url.searchParams.set("from", from);
    url.searchParams.set("to", to);
    const response = await this.request(url);
    const payload = await readJson(response);
    const candles = (payload as { data?: { candles?: unknown } }).data?.candles;
    if (!Array.isArray(candles)) {
      throw new KiteClientError(
        "INVALID_RESPONSE",
        "Kite historical candles response was missing a candles array.",
      );
    }
    return candles as KiteCandleRow[];
  }

  async getHoldings(): Promise<readonly KiteHolding[]> {
    const url = new URL(`${this.baseUrl}/portfolio/holdings`);
    const response = await this.request(url);
    const payload = await readJson(response);
    const rows = (payload as { data?: unknown[] }).data ?? [];
    return (rows as Record<string, unknown>[]).map((row) => ({
      tradingsymbol: String(row.tradingsymbol ?? ""),
      exchange: String(row.exchange ?? ""),
      isin: String(row.isin ?? ""),
      quantity: Number(row.quantity ?? 0),
      averagePrice: Number(row.average_price ?? 0),
      lastPrice: Number(row.last_price ?? 0),
      pnl: Number(row.pnl ?? 0),
      product: String(row.product ?? ""),
    }));
  }

  async getPositions(): Promise<{
    readonly net: readonly KitePosition[];
    readonly day: readonly KitePosition[];
  }> {
    const url = new URL(`${this.baseUrl}/portfolio/positions`);
    const response = await this.request(url);
    const payload = await readJson(response);
    const data = (payload as { data?: { net?: unknown[]; day?: unknown[] } }).data ?? {};
    return { net: mapPositions(data.net), day: mapPositions(data.day) };
  }

  async placeOrder(params: KitePlaceOrderParams): Promise<{ readonly orderId: string }> {
    const variety = params.variety ?? "regular";
    const url = new URL(`${this.baseUrl}/orders/${encodeURIComponent(variety)}`);
    const body = new URLSearchParams({
      tradingsymbol: params.tradingsymbol,
      exchange: params.exchange,
      transaction_type: params.transactionType,
      order_type: params.orderType,
      quantity: String(params.quantity),
      product: params.product,
      validity: params.validity ?? "DAY",
      ...(params.orderType === "LIMIT" && params.price !== undefined
        ? { price: String(params.price) }
        : {}),
    });
    const response = await this.request(url, {
      method: "POST",
      body: body.toString(),
      headers: { "content-type": "application/x-www-form-urlencoded" },
    });
    const payload = await readJson(response);
    const orderId = (payload as { data?: { order_id?: string } }).data?.order_id;
    if (!orderId) {
      throw new KiteClientError(
        "INVALID_RESPONSE",
        "Kite order placement response was missing an order_id.",
      );
    }
    return { orderId };
  }

  async cancelOrder(orderId: string, variety = "regular"): Promise<void> {
    const url = new URL(
      `${this.baseUrl}/orders/${encodeURIComponent(variety)}/${encodeURIComponent(orderId)}`,
    );
    await this.request(url, { method: "DELETE" });
  }

  async getOrders(): Promise<readonly KiteOrder[]> {
    const url = new URL(`${this.baseUrl}/orders`);
    const response = await this.request(url);
    const payload = await readJson(response);
    const rows = (payload as { data?: unknown[] }).data ?? [];
    return (rows as Record<string, unknown>[]).map((row) => ({
      orderId: String(row.order_id ?? ""),
      tradingsymbol: String(row.tradingsymbol ?? ""),
      exchange: String(row.exchange ?? ""),
      transactionType: String(row.transaction_type ?? ""),
      quantity: Number(row.quantity ?? 0),
      orderType: String(row.order_type ?? ""),
      product: String(row.product ?? ""),
      status: String(row.status ?? ""),
      price: Number(row.price ?? 0),
    }));
  }

  private async request(
    url: URL,
    init?: { readonly method?: string; readonly body?: string; readonly headers?: Record<string, string> },
  ): Promise<Response> {
    const deadline = new AbortController();
    const timeout = setTimeout(() => deadline.abort(), this.options.requestTimeoutMs);
    timeout.unref();
    try {
      const response = await this.fetchFunction(url, {
        method: init?.method ?? "GET",
        ...(init?.body !== undefined ? { body: init.body } : {}),
        headers: {
          Authorization: `token ${this.options.apiKey}:${this.options.accessToken}`,
          "X-Kite-Version": "3",
          ...(init?.headers ?? {}),
        },
        signal: deadline.signal,
      });
      if (response.status === 403 || response.status === 401) {
        await discardBody(response);
        throw new KiteClientError(
          "UNAUTHORIZED",
          `Kite Connect returned HTTP status ${response.status}; the access token may be expired (it expires daily).`,
        );
      }
      if (!response.ok) {
        await discardBody(response);
        throw new KiteClientError(
          "UNAVAILABLE",
          `Kite Connect returned HTTP status ${response.status}.`,
        );
      }
      return response;
    } catch (error: unknown) {
      if (error instanceof KiteClientError) throw error;
      if (deadline.signal.aborted) {
        throw new KiteClientError(
          "TIMEOUT",
          "Kite Connect did not respond before its deadline.",
          { cause: error },
        );
      }
      throw new KiteClientError("UNAVAILABLE", "Kite Connect request failed.", {
        cause: error,
      });
    } finally {
      clearTimeout(timeout);
    }
  }
}

/**
 * One-off session helper: exchanges a `request_token` (captured manually
 * from Kite's interactive browser login redirect — see
 * app/scripts/kite-generate-session.ts and app/src/trading/README.md) for a
 * daily access token. Never called automatically by the app itself.
 */
export async function generateSession(
  options: {
    readonly apiKey: string;
    readonly apiSecret: string;
    readonly requestToken: string;
    readonly baseUrl?: string;
    readonly fetchFunction?: typeof fetch;
  },
): Promise<{ readonly accessToken: string }> {
  const baseUrl = (options.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, "");
  const fetchFunction = options.fetchFunction ?? fetch;
  const checksum = createHash("sha256")
    .update(options.apiKey + options.requestToken + options.apiSecret)
    .digest("hex");
  const body = new URLSearchParams({
    api_key: options.apiKey,
    request_token: options.requestToken,
    checksum,
  });
  const response = await fetchFunction(`${baseUrl}/session/token`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: body.toString(),
  });
  if (!response.ok) {
    throw new KiteClientError(
      "UNAVAILABLE",
      `Kite session generation returned HTTP status ${response.status}.`,
    );
  }
  const payload = (await response.json()) as { data?: { access_token?: string } };
  const accessToken = payload.data?.access_token;
  if (!accessToken) {
    throw new KiteClientError(
      "INVALID_RESPONSE",
      "Kite session generation response was missing an access_token.",
    );
  }
  return { accessToken };
}

function parseInstrumentsCsv(text: string): readonly KiteInstrumentRecord[] {
  const lines = text.split(/\r?\n/).filter((line) => line.length > 0);
  if (lines.length === 0) return [];
  const header = splitCsvLine(lines[0] as string);
  const indexOf = (column: string): number => header.indexOf(column);
  const tokenIndex = indexOf("instrument_token");
  const symbolIndex = indexOf("tradingsymbol");
  const nameIndex = indexOf("name");
  const exchangeIndex = indexOf("exchange");
  const typeIndex = indexOf("instrument_type");
  const segmentIndex = indexOf("segment");

  const records: KiteInstrumentRecord[] = [];
  for (const line of lines.slice(1)) {
    const columns = splitCsvLine(line);
    const instrumentToken = Number(columns[tokenIndex]);
    if (!Number.isFinite(instrumentToken)) continue;
    records.push({
      instrumentToken,
      tradingsymbol: columns[symbolIndex] ?? "",
      name: columns[nameIndex] ?? "",
      exchange: columns[exchangeIndex] ?? "",
      instrumentType: columns[typeIndex] ?? "",
      segment: columns[segmentIndex] ?? "",
    });
  }
  return records;
}

function mapPositions(rows: unknown[] | undefined): readonly KitePosition[] {
  return ((rows ?? []) as Record<string, unknown>[]).map((row) => ({
    tradingsymbol: String(row.tradingsymbol ?? ""),
    exchange: String(row.exchange ?? ""),
    product: String(row.product ?? ""),
    quantity: Number(row.quantity ?? 0),
    averagePrice: Number(row.average_price ?? 0),
    lastPrice: Number(row.last_price ?? 0),
    pnl: Number(row.pnl ?? 0),
  }));
}

/** NSE equity tradingsymbols/names don't contain commas or quotes in practice; still strip stray quotes defensively. */
function splitCsvLine(line: string): string[] {
  return line.split(",").map((value) => value.trim().replace(/^"|"$/g, ""));
}

async function readText(response: Response): Promise<string> {
  try {
    return await response.text();
  } catch (error: unknown) {
    throw new KiteClientError("INVALID_RESPONSE", "Kite Connect returned an unreadable body.", {
      cause: error,
    });
  }
}

async function readJson(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch (error: unknown) {
    throw new KiteClientError("INVALID_RESPONSE", "Kite Connect returned malformed JSON.", {
      cause: error,
    });
  }
}

async function discardBody(response: Response): Promise<void> {
  try {
    await response.body?.cancel();
  } catch {
    // The sanitized upstream status is already the actionable failure.
  }
}
