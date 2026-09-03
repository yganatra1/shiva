import type {
  Candle,
  HistoricalCandleRequest,
  InstrumentUniverseProvider,
  ListOpportunitiesFilter,
  MarketDataProvider,
  PersistScanInput,
  RecordOrderInput,
  TradeOpportunity,
  TradingInstrument,
  TradingRepositoryPort,
  TradingScanResult,
} from "../../src/trading/types.js";

/** Builds a candle for day `index` (0-based) from a fixed epoch, all fields defaulted from `close`. */
export function candle(
  index: number,
  close: number,
  overrides: Partial<Omit<Candle, "timestamp">> = {},
): Candle {
  const date = new Date(Date.UTC(2024, 0, 1));
  date.setUTCDate(date.getUTCDate() + index);
  return {
    timestamp: date.toISOString(),
    open: overrides.open ?? close,
    high: overrides.high ?? close,
    low: overrides.low ?? close,
    close,
    volume: overrides.volume ?? 1_000_000,
  };
}

/** N candles with a constant close (and default volume), useful for EMA/ATR baseline checks. */
export function flatCandles(count: number, close: number, volume = 1_000_000): Candle[] {
  return Array.from({ length: count }, (_, i) => candle(i, close, { volume }));
}

/** A steadily rising close series: close[i] = start + i*step, high=close+range, low=close-range. */
export function risingCandles(
  count: number,
  start: number,
  step: number,
  range = 1,
  volume = 1_000_000,
): Candle[] {
  return Array.from({ length: count }, (_, i) => {
    const close = start + i * step;
    return candle(i, close, { high: close + range, low: close - range, volume });
  });
}

/** A steadily falling close series. */
export function fallingCandles(
  count: number,
  start: number,
  step: number,
  range = 1,
  volume = 1_000_000,
): Candle[] {
  return risingCandles(count, start, -step, range, volume);
}

export class FakeUniverseProvider implements InstrumentUniverseProvider {
  constructor(private readonly instruments: readonly TradingInstrument[]) {}
  async getUniverse(): Promise<readonly TradingInstrument[]> {
    return this.instruments;
  }
}

export class FakeMarketDataProvider implements MarketDataProvider {
  constructor(
    private readonly candlesByToken: ReadonlyMap<number, readonly Candle[]>,
    private readonly failingTokens: ReadonlySet<number> = new Set(),
  ) {}
  async getHistoricalCandles(
    request: HistoricalCandleRequest,
  ): Promise<readonly Candle[]> {
    if (this.failingTokens.has(request.instrumentToken)) {
      throw new Error(`Simulated market data failure for ${request.tradingsymbol}`);
    }
    return this.candlesByToken.get(request.instrumentToken) ?? [];
  }
}

export class InMemoryTradingRepository implements TradingRepositoryPort {
  private scans: TradingScanResult[] = [];
  private sequence = 1;

  async saveScan(input: PersistScanInput): Promise<TradingScanResult> {
    const scanId = `scan-${this.sequence++}`;
    const saved: TradingScanResult = { ...input.result, scanId };
    this.scans.push(saved);
    return saved;
  }

  async getLatestScan(): Promise<TradingScanResult | null> {
    return this.scans[this.scans.length - 1] ?? null;
  }

  async listOpportunities(
    filter: ListOpportunitiesFilter = {},
  ): Promise<readonly TradeOpportunity[]> {
    const latest = this.scans[this.scans.length - 1];
    if (!latest) return [];
    let opportunities = [...latest.opportunities];
    if (filter.minScore !== undefined) {
      const minScore = filter.minScore;
      opportunities = opportunities.filter((o) => o.finalScore >= minScore);
    }
    if (filter.strategy) {
      opportunities = opportunities.filter((o) => o.primaryStrategy === filter.strategy);
    }
    return opportunities.slice(0, filter.limit ?? 50);
  }

  async getOpportunity(tradingsymbol: string): Promise<TradeOpportunity | null> {
    const latest = this.scans[this.scans.length - 1];
    if (!latest) return null;
    return (
      latest.opportunities.find(
        (o) => o.tradingsymbol.toUpperCase() === tradingsymbol.toUpperCase(),
      ) ?? null
    );
  }

  readonly recordedOrders: RecordOrderInput[] = [];

  async recordOrder(input: RecordOrderInput): Promise<void> {
    this.recordedOrders.push(input);
  }
}
