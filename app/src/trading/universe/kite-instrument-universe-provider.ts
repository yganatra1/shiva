import type { KiteClientPort, KiteInstrumentRecord } from "../../tools/kite/types";
import type { InstrumentUniverseProvider, TradingInstrument } from "../types";

export interface KiteInstrumentUniverseProviderOptions {
  readonly client: KiteClientPort;
  readonly exchange: string;
  /** From TradingConfig.staticUniverseSymbols — reuse that config field, do not add a second one. */
  readonly tradingsymbols: readonly string[];
  /** Re-fetch the full exchange instrument dump if the cached copy is older than this. */
  readonly cacheTtlMs?: number;
  readonly now?: () => Date;
}

const DEFAULT_CACHE_TTL_MS = 6 * 60 * 60 * 1_000;

/**
 * Read-only instrument universe backed by Kite Connect's instrument dump,
 * filtered to the operator-configured tradingsymbol list and equity
 * (`instrument_type === "EQ"`) rows only — never derivatives/options. The
 * full per-exchange dump is cached in memory for the configured TTL so one
 * scan does not refetch it per instrument.
 */
export class KiteInstrumentUniverseProvider implements InstrumentUniverseProvider {
  private readonly cacheTtlMs: number;
  private readonly now: () => Date;
  private cachedAt: number | undefined;
  private cachedDump: readonly KiteInstrumentRecord[] | undefined;

  constructor(private readonly options: KiteInstrumentUniverseProviderOptions) {
    this.cacheTtlMs = options.cacheTtlMs ?? DEFAULT_CACHE_TTL_MS;
    this.now = options.now ?? (() => new Date());
  }

  async getUniverse(): Promise<readonly TradingInstrument[]> {
    const dump = await this.instrumentDump();
    const wanted = new Set(this.options.tradingsymbols.map((symbol) => symbol.toUpperCase()));
    return dump
      .filter(
        (record) =>
          wanted.has(record.tradingsymbol.toUpperCase()) &&
          record.instrumentType === "EQ",
      )
      .map((record) => ({
        instrumentToken: record.instrumentToken,
        exchange: record.exchange,
        tradingsymbol: record.tradingsymbol,
        name: record.name,
      }));
  }

  private async instrumentDump(): Promise<readonly KiteInstrumentRecord[]> {
    const nowMs = this.now().getTime();
    if (this.cachedDump && this.cachedAt !== undefined && nowMs - this.cachedAt < this.cacheTtlMs) {
      return this.cachedDump;
    }
    const dump = await this.options.client.getInstruments(this.options.exchange);
    this.cachedDump = dump;
    this.cachedAt = nowMs;
    return dump;
  }
}
