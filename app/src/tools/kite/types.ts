/**
 * Kite Connect surface used by the trading scanner and, for the portfolio
 * and order-placement skills, by the user's own explicit and confirmed
 * requests. Nothing here exposes CE/PE/options or short selling — orders
 * are plain equity BUY/SELL only.
 */
export interface KiteInstrumentRecord {
  readonly instrumentToken: number;
  readonly tradingsymbol: string;
  readonly name: string;
  readonly exchange: string;
  readonly instrumentType: string;
  readonly segment: string;
}

export interface KiteQuote {
  readonly instrumentToken: number;
  readonly lastPrice: number;
  readonly timestamp?: string;
}

/** [isoTimestamp, open, high, low, close, volume] — Kite may append a 7th OI field for F&O; we ignore it (equities/day candles only). */
export type KiteCandleRow = readonly [string, number, number, number, number, number, ...number[]];

export interface KiteHolding {
  readonly tradingsymbol: string;
  readonly exchange: string;
  readonly isin: string;
  readonly quantity: number;
  readonly averagePrice: number;
  readonly lastPrice: number;
  readonly pnl: number;
  readonly product: string;
}

export interface KitePosition {
  readonly tradingsymbol: string;
  readonly exchange: string;
  readonly product: string;
  readonly quantity: number;
  readonly averagePrice: number;
  readonly lastPrice: number;
  readonly pnl: number;
}

export type KiteTransactionType = "BUY" | "SELL";
export type KiteOrderType = "MARKET" | "LIMIT";
export type KiteProduct = "CNC" | "MIS" | "NRML";

export interface KitePlaceOrderParams {
  readonly tradingsymbol: string;
  readonly exchange: string;
  readonly transactionType: KiteTransactionType;
  readonly orderType: KiteOrderType;
  readonly quantity: number;
  readonly product: KiteProduct;
  readonly price?: number;
  readonly validity?: string;
  readonly variety?: string;
}

export interface KiteOrder {
  readonly orderId: string;
  readonly tradingsymbol: string;
  readonly exchange: string;
  readonly transactionType: string;
  readonly quantity: number;
  readonly orderType: string;
  readonly product: string;
  readonly status: string;
  readonly price: number;
}

export class KiteClientError extends Error {
  override readonly name = "KiteClientError";
  constructor(
    readonly code: "UNAVAILABLE" | "INVALID_RESPONSE" | "TIMEOUT" | "UNAUTHORIZED",
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
  }
}

export interface KiteClientPort {
  getInstruments(exchange: string): Promise<readonly KiteInstrumentRecord[]>;
  getQuote(
    instrumentKeys: readonly string[],
  ): Promise<Readonly<Record<string, KiteQuote>>>;
  getHistoricalCandles(
    instrumentToken: number,
    interval: string,
    from: string,
    to: string,
  ): Promise<readonly KiteCandleRow[]>;
  getHoldings(): Promise<readonly KiteHolding[]>;
  getPositions(): Promise<{ readonly net: readonly KitePosition[]; readonly day: readonly KitePosition[] }>;
  placeOrder(params: KitePlaceOrderParams): Promise<{ readonly orderId: string }>;
  cancelOrder(orderId: string, variety?: string): Promise<void>;
  getOrders(): Promise<readonly KiteOrder[]>;
}
