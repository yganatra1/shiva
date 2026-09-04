import type { KiteClientPort } from "../../tools/kite/types";
import type { TradingInstrument } from "../types";

/**
 * Builds a cached resolver for the benchmark's real broker instrument token.
 * Indices (e.g. "NIFTY 50") are not equities, so they are looked up against
 * the same per-exchange instrument dump used by KiteInstrumentUniverseProvider
 * without the `instrument_type === "EQ"` filter that provider applies.
 *
 * If the configured benchmark symbol has no matching row in the dump, this
 * logs a clear error (rather than silently returning a bogus token) and
 * falls back to instrumentToken 0 — scans will keep failing with an
 * explicit "invalid token" error until TRADING_BENCHMARK_SYMBOL is fixed to
 * match Kite's actual tradingsymbol for the intended index.
 */
export function createKiteBenchmarkInstrumentResolver(
  client: KiteClientPort,
  exchange: string,
  tradingsymbol: string,
): () => Promise<TradingInstrument> {
  let cached: TradingInstrument | undefined;
  return async (): Promise<TradingInstrument> => {
    if (cached) return cached;
    const dump = await client.getInstruments(exchange);
    const match = dump.find(
      (record) => record.tradingsymbol.toUpperCase() === tradingsymbol.toUpperCase(),
    );
    if (!match) {
      console.error(
        `[trading] benchmark symbol "${tradingsymbol}" was not found in Kite's ${exchange} instrument dump; ` +
          "falling back to instrumentToken 0, so scans will keep failing with an explicit invalid-token error " +
          "until TRADING_BENCHMARK_SYMBOL matches Kite's actual tradingsymbol for this index.",
      );
      cached = { instrumentToken: 0, exchange, tradingsymbol };
      return cached;
    }
    cached = {
      instrumentToken: match.instrumentToken,
      exchange: match.exchange,
      tradingsymbol: match.tradingsymbol,
      name: match.name,
    };
    return cached;
  };
}
