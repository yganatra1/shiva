import { buildTechnicalSnapshot } from "../indicators/technical-snapshot";
import { detectMarketRegime } from "../regime/market-regime-engine";
import { buildTradeOpportunity, compareOpportunities } from "../scoring/opportunity-aggregation";
import type {
  Candle,
  InstrumentUniverseProvider,
  MarketDataProvider,
  TradeOpportunity,
  TradeStrategy,
  TradingConfig,
  TradingInstrument,
  TradingScanFailure,
  TradingScanResult,
} from "../types";

export interface TradingScannerServiceOptions {
  readonly universeProvider: InstrumentUniverseProvider;
  readonly marketDataProvider: MarketDataProvider;
  readonly strategies: readonly TradeStrategy[];
  readonly config: TradingConfig;
  /**
   * The benchmark instrument to fetch candles for (config.benchmarkSymbol is
   * just a display name; resolving it to a broker instrument token is a
   * deployment concern, not something this scanner hardcodes). May be a
   * static value (tests, or when no broker is configured) or an async
   * resolver — e.g. one backed by a live instrument dump — resolved once per
   * scan(); callers typically cache the result themselves.
   */
  readonly benchmarkInstrument: TradingInstrument | (() => Promise<TradingInstrument>);
  /** Injected for deterministic, replayable tests; defaults to the wall clock. */
  readonly now?: () => Date;
  /** How many trading days of history to request per instrument. */
  readonly historyDays?: number;
}

const DEFAULT_HISTORY_DAYS = 400;

/**
 * Orchestrates one full scan: universe -> candles -> regime -> per-instrument
 * indicators -> strategies -> opportunities. Every instrument is evaluated
 * independently under bounded concurrency; one instrument's failure never
 * aborts the scan, it is recorded in `failures` instead.
 */
export class TradingScannerService {
  constructor(private readonly options: TradingScannerServiceOptions) {}

  async scan(): Promise<TradingScanResult> {
    const now = this.options.now ?? (() => new Date());
    const startedAt = now().toISOString();
    const historyDays = this.options.historyDays ?? DEFAULT_HISTORY_DAYS;
    const config = this.options.config;

    const benchmarkInstrument =
      typeof this.options.benchmarkInstrument === "function"
        ? await this.options.benchmarkInstrument()
        : this.options.benchmarkInstrument;

    const [universe, benchmarkCandles] = await Promise.all([
      this.options.universeProvider.getUniverse(),
      this.fetchCandles(benchmarkInstrument, historyDays),
    ]);

    const marketRegime = detectMarketRegime(benchmarkCandles, config);

    const opportunities: TradeOpportunity[] = [];
    const failures: TradingScanFailure[] = [];
    let skipped = 0;
    let analyzed = 0;

    await mapWithConcurrency(
      universe,
      config.scannerConcurrency,
      async (instrument) => {
        try {
          const candles = await this.fetchCandles(instrument, historyDays);
          if (candles.length === 0) {
            skipped += 1;
            return;
          }
          analyzed += 1;
          const snapshot = buildTechnicalSnapshot(candles, benchmarkCandles, config);
          const strategyResults = this.options.strategies.map((strategy) =>
            strategy.evaluate({
              instrument,
              candles,
              benchmarkCandles,
              snapshot,
              regime: marketRegime,
              config,
            }),
          );
          const opportunity = buildTradeOpportunity(
            strategyResults,
            instrument,
            marketRegime,
            now().toISOString(),
            config.minimumOpportunityScore,
            snapshot,
          );
          if (opportunity) opportunities.push(opportunity);
        } catch (error: unknown) {
          failures.push({
            tradingsymbol: instrument.tradingsymbol,
            error: error instanceof Error ? error.message : String(error),
          });
        }
      },
    );

    opportunities.sort(compareOpportunities);

    return {
      startedAt,
      completedAt: now().toISOString(),
      benchmark: config.benchmarkSymbol,
      marketRegime,
      totalInstruments: universe.length,
      analyzedInstruments: analyzed,
      skippedInstruments: skipped,
      failedInstruments: failures.length,
      opportunities,
      failures,
    };
  }

  private async fetchCandles(
    instrument: TradingInstrument,
    historyDays: number,
  ): Promise<readonly Candle[]> {
    const to = this.options.now ? this.options.now() : new Date();
    const from = new Date(to);
    from.setDate(from.getDate() - historyDays);
    return this.options.marketDataProvider.getHistoricalCandles({
      instrumentToken: instrument.instrumentToken,
      exchange: instrument.exchange,
      tradingsymbol: instrument.tradingsymbol,
      fromDate: from.toISOString().slice(0, 10),
      toDate: to.toISOString().slice(0, 10),
      interval: "day",
    });
  }
}

/**
 * Minimal bounded-concurrency map helper (no new dependency). Runs `worker`
 * over `items` with at most `concurrency` in flight at once; each item's
 * failure is the worker's own responsibility to catch — this helper only
 * bounds parallelism, it never itself throws for one item's rejection.
 */
async function mapWithConcurrency<T>(
  items: readonly T[],
  concurrency: number,
  worker: (item: T, index: number) => Promise<void>,
): Promise<void> {
  const limit = Math.max(1, concurrency);
  let cursor = 0;
  async function run(): Promise<void> {
    for (;;) {
      const index = cursor;
      cursor += 1;
      if (index >= items.length) return;
      await worker(items[index] as T, index);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, run));
}
