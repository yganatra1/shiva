import type { InstrumentUniverseProvider, TradingInstrument } from "../types";

export interface StaticInstrumentUniverseProviderOptions {
  /** Tradingsymbols to scan. Comes from TradingConfig.staticUniverseSymbols; never hardcode a symbol list here. */
  readonly symbols: readonly string[];
  readonly exchange?: string;
  /**
   * Optional tradingsymbol -> real broker instrumentToken lookup. When a
   * symbol has no entry, a stable placeholder token is derived from the
   * symbol so the pipeline stays runnable in development/tests; a real
   * deployment should supply the actual Kite (or other broker) instrument
   * tokens here, since a Kite-backed MarketDataProvider is out of scope for
   * this phase.
   */
  readonly instrumentTokens?: Readonly<Record<string, number>>;
}

/**
 * Configurable/pluggable instrument universe backed by a static, operator-
 * supplied symbol list (see TradingConfig.staticUniverseSymbols /
 * TRADING_UNIVERSE_SYMBOLS). Deliberately does NOT hardcode NIFTY 500 or any
 * other index membership — a future provider (e.g. one that reads an index
 * constituent file, or queries a broker) can implement the same
 * InstrumentUniverseProvider interface without any scanner changes.
 */
export class StaticInstrumentUniverseProvider
  implements InstrumentUniverseProvider
{
  private readonly instruments: readonly TradingInstrument[];

  constructor(options: StaticInstrumentUniverseProviderOptions) {
    const exchange = options.exchange ?? "NSE";
    this.instruments = options.symbols.map((tradingsymbol) => ({
      instrumentToken:
        options.instrumentTokens?.[tradingsymbol] ?? placeholderToken(tradingsymbol),
      exchange,
      tradingsymbol,
    }));
  }

  async getUniverse(): Promise<readonly TradingInstrument[]> {
    return this.instruments;
  }
}

/** Deterministic, stable (but not broker-real) token so the pipeline is runnable without a live instrument master. */
function placeholderToken(symbol: string): number {
  let hash = 0;
  for (let i = 0; i < symbol.length; i += 1) {
    hash = (hash * 31 + symbol.charCodeAt(i)) >>> 0;
  }
  return hash;
}
