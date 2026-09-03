import type { Candle, HistoricalCandleRequest, MarketDataProvider } from "../types";

/**
 * Placeholder MarketDataProvider used when no real broker-backed
 * implementation (e.g. KiteMarketDataProvider) is configured. Deliberately
 * returns an empty candle array rather than throwing: the scanner already
 * treats an empty/insufficient candle history as a graceful per-instrument
 * skip (see TradingScannerService.scan / TradingScanResult.skippedInstruments),
 * so an unconfigured market data source degrades to "scan runs, finds zero
 * candidates" instead of crashing the whole scan.
 */
export class UnconfiguredMarketDataProvider implements MarketDataProvider {
  async getHistoricalCandles(
    _request: HistoricalCandleRequest,
  ): Promise<readonly Candle[]> {
    return [];
  }
}
