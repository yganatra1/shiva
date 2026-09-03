import { createHash } from "node:crypto";

import { sanitizeAuditPayload } from "../../security/audit-sanitizer";
import {
  KiteClientError,
  type KiteCandleRow,
  type KiteClientPort,
  type KiteHolding,
  type KiteInstrumentRecord,
  type KiteLogSink,
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
  /** Diagnostic sink for portfolio holdings/positions requests only (see request()'s `diagnostics` param); other Kite calls are unaffected. */
  readonly logger?: KiteLogSink;
}

/** Headers safe to log verbatim — no auth/session/cookie material is ever in this list. */
const SAFE_RESPONSE_HEADER_ALLOWLIST = [
  "content-type",
  "content-length",
  "date",
  "x-request-id",
  "request-id",
  "retry-after",
] as const;

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
    const response = await this.request(url, undefined, { endpoint: "portfolio/holdings" });
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
    const response = await this.request(url, undefined, { endpoint: "portfolio/positions" });
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
    diagnostics?: { readonly endpoint: string },
  ): Promise<Response> {
    const deadline = new AbortController();
    const timeout = setTimeout(() => deadline.abort(), this.options.requestTimeoutMs);
    timeout.unref();
    const startedAt = Date.now();
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
      if (!response.ok) {
        const detail = await readErrorDetail(response);
        const code = response.status === 401 || response.status === 403
          ? "UNAUTHORIZED"
          : "UNAVAILABLE";
        const suffix = response.status === 401 || response.status === 403
          ? " The access token may be expired (it expires daily) or the request may be missing a required header/scope."
          : "";
        const message = detail.kiteErrorType || detail.kiteMessage
          ? `Kite Connect ${url.pathname} returned HTTP ${response.status} (${detail.kiteErrorType ?? "unknown_error_type"}): ${detail.kiteMessage ?? detail.raw}.${suffix}`
          : `Kite Connect ${url.pathname} returned HTTP ${response.status}: ${detail.raw || "<empty body>"}.${suffix}`;
        // eslint-disable-next-line no-console -- KiteClient has no injected logger; this is the only place Kite's actual error detail is ever visible in process logs.
        console.error("[kite] request failed", {
          method: init?.method ?? "GET",
          path: url.pathname,
          status: response.status,
          kiteErrorType: detail.kiteErrorType,
          kiteMessage: detail.kiteMessage,
        });
        throw new KiteClientError(code, message, {
          httpStatus: response.status,
          ...(detail.kiteErrorType ? { kiteErrorType: detail.kiteErrorType } : {}),
        });
      }
      return response;
    } catch (error: unknown) {
      if (error instanceof KiteClientError) throw error;
      if (deadline.signal.aborted) {
        console.error("[kite] request timed out", { path: url.pathname, timeoutMs: this.options.requestTimeoutMs });
        throw new KiteClientError(
          "TIMEOUT",
          `Kite Connect ${url.pathname} did not respond within ${this.options.requestTimeoutMs}ms.`,
          { cause: error },
        );
      }
      console.error("[kite] request failed before a response was received", {
        path: url.pathname,
        error: error instanceof Error ? error.message : String(error),
      });
      throw new KiteClientError("UNAVAILABLE", `Kite Connect ${url.pathname} request failed.`, {
        cause: error,
      });
    } finally {
      clearTimeout(timeout);
    }
  }

  /**
   * Logs the raw Kite response for portfolio holdings/positions calls, cloning the
   * response so the caller's own body read (readJson/discardBody) is unaffected.
   * Successful bodies are summarized (record counts only) rather than logged verbatim
   * because holdings/positions payloads are the user's personal financial data
   * (ISIN, quantities, P&L); error bodies are logged through sanitizeAuditPayload
   * since Kite error payloads are just {status,error_type,message} with no PII, and
   * the sanitizer strips any secret-looking fields as a safety net.
   */
  private async logResponse(
    endpoint: string,
    method: string,
    response: Response,
    startedAt: number,
  ): Promise<void> {
    if (!this.options.logger) return;
    const elapsedMs = Date.now() - startedAt;
    const headers = safeResponseHeaders(response.headers);
    const body = await summarizeResponseBody(response);
    const fields = {
      tool: "kite_connect",
      endpoint,
      method,
      status: response.status,
      ok: response.ok,
      elapsedMs,
      headers,
      body,
    };
    if (response.ok) {
      this.options.logger.info(fields, `Kite Connect ${endpoint} responded`);
    } else {
      this.options.logger.warn(fields, `Kite Connect ${endpoint} returned an error response`);
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
    const detail = await readErrorDetail(response);
    console.error("[kite] session generation failed", {
      status: response.status,
      kiteErrorType: detail.kiteErrorType,
      kiteMessage: detail.kiteMessage,
    });
    const message = detail.kiteErrorType || detail.kiteMessage
      ? `Kite session generation returned HTTP ${response.status} (${detail.kiteErrorType ?? "unknown_error_type"}): ${detail.kiteMessage ?? detail.raw}.`
      : `Kite session generation returned HTTP ${response.status}: ${detail.raw || "<empty body>"}.`;
    throw new KiteClientError("UNAVAILABLE", message, {
      httpStatus: response.status,
      ...(detail.kiteErrorType ? { kiteErrorType: detail.kiteErrorType } : {}),
    });
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

/**
 * Reads a failed response's body once and pulls out Kite's own
 * `{ error_type, message }` shape when present, falling back to the raw
 * text (Kite occasionally returns plain-text/HTML for edge-case failures,
 * e.g. upstream gateway errors) so no failure ever collapses to a bare
 * HTTP status with zero detail.
 */
async function readErrorDetail(
  response: Response,
): Promise<{ readonly kiteErrorType?: string; readonly kiteMessage?: string; readonly raw: string }> {
  let raw = "";
  try {
    raw = await response.text();
  } catch {
    return { raw: "" };
  }
  try {
    const parsed = JSON.parse(raw) as { error_type?: string; message?: string };
    return {
      raw,
      ...(typeof parsed.error_type === "string" ? { kiteErrorType: parsed.error_type } : {}),
      ...(typeof parsed.message === "string" ? { kiteMessage: parsed.message } : {}),
    };
  } catch {
    return { raw };
  }
}

function safeResponseHeaders(headers: Headers): Record<string, string> {
  const result: Record<string, string> = {};
  for (const name of SAFE_RESPONSE_HEADER_ALLOWLIST) {
    const value = headers.get(name);
    if (value !== null) result[name] = value;
  }
  return result;
}

/**
 * On error, logs the sanitized body verbatim (Kite error payloads are just
 * {status,error_type,message}). On success, logs record counts only — the
 * body is the user's actual portfolio data and must not be logged raw.
 */
async function summarizeResponseBody(response: Response): Promise<unknown> {
  let text: string;
  try {
    text = await response.clone().text();
  } catch {
    return { readError: true };
  }
  if (!response.ok) {
    return sanitizeAuditPayload(safeJsonParse(text) ?? text);
  }
  const parsed = safeJsonParse(text);
  const data = (parsed as { data?: unknown } | undefined)?.data;
  if (Array.isArray(data)) return { recordCount: data.length };
  if (data && typeof data === "object") {
    return Object.fromEntries(
      Object.entries(data as Record<string, unknown>).map(([key, value]) => [
        key,
        Array.isArray(value) ? { recordCount: value.length } : "[REDACTED]",
      ]),
    );
  }
  return { bytes: text.length };
}

function safeJsonParse(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}
