import type { KiteClientPort } from "../../tools/kite/types";
import type {
  Candle,
  HistoricalCandleRequest,
  MarketDataProvider,
  MarketQuote,
  TradingInstrument,
} from "../types";

export interface KiteMarketDataProviderOptions {
  readonly client: KiteClientPort;
  readonly candleInterval?: string;
}

/**
 * Read-only MarketDataProvider backed by Kite Connect. Never places an
 * order; only reads historical candles and quotes.
 */
export class KiteMarketDataProvider implements MarketDataProvider {
  private readonly interval: string;

  constructor(private readonly options: KiteMarketDataProviderOptions) {
    this.interval = options.candleInterval ?? "day";
  }

  async getHistoricalCandles(
    request: HistoricalCandleRequest,
  ): Promise<readonly Candle[]> {
    const rows = await this.options.client.getHistoricalCandles(
      request.instrumentToken,
      this.interval,
      request.fromDate,
      request.toDate,
    );
    return rows.map((row) => ({
      // Kite's timestamp includes a timezone offset (e.g.
      // "2024-01-01T00:00:00+0530"); `new Date(...)` parses that directly.
      timestamp: new Date(row[0]).toISOString(),
      open: row[1],
      high: row[2],
      low: row[3],
      close: row[4],
      volume: row[5],
    }));
  }

  async getLatestQuote(instrument: TradingInstrument): Promise<MarketQuote | undefined> {
    const key = `${instrument.exchange}:${instrument.tradingsymbol}`;
    const quotes = await this.options.client.getQuote([key]);
    const quote = quotes[key];
    if (!quote) return undefined;
    return {
      instrumentToken: quote.instrumentToken,
      lastPrice: quote.lastPrice,
      timestamp: quote.timestamp ?? new Date().toISOString(),
    };
  }
}
