/**
 * Shared domain types for Shiva's deterministic equity trade-opportunity
 * scanner. Nothing in this file (or anywhere under app/src/trading/) may
 * depend on Date.now(), live broker state, HTTP request state, or DB state —
 * all market state is passed explicitly so the pipeline stays pure-function
 * testable and, later, backtest-replayable. No LLM/chat provider is ever
 * consulted to produce a score or signal; see app/src/trading/README.md.
 */

/** One OHLCV daily candle. */
export interface Candle {
  readonly timestamp: string; // ISO-8601
  readonly open: number;
  readonly high: number;
  readonly low: number;
  readonly close: number;
  readonly volume: number;
}

/** One tradable instrument in the configured universe. */
export interface TradingInstrument {
  readonly instrumentToken: number;
  readonly exchange: string;
  readonly tradingsymbol: string;
  readonly name?: string;
}

export interface HistoricalCandleRequest {
  readonly instrumentToken: number;
  readonly exchange: string;
  readonly tradingsymbol: string;
  readonly fromDate: string; // ISO-8601 date
  readonly toDate: string; // ISO-8601 date
  readonly interval: "day";
}

export interface MarketQuote {
  readonly instrumentToken: number;
  readonly lastPrice: number;
  readonly timestamp: string; // ISO-8601
}

/** Pluggable source of the instrument universe to scan. Never hardcode NIFTY 500 here. */
export interface InstrumentUniverseProvider {
  getUniverse(): Promise<readonly TradingInstrument[]>;
}

/** Pluggable market data source. A real Kite-backed implementation is out of scope for this phase. */
export interface MarketDataProvider {
  getHistoricalCandles(
    request: HistoricalCandleRequest,
  ): Promise<readonly Candle[]>;
  getQuote?(instrumentToken: number): Promise<MarketQuote>;
}

/**
 * Deterministic technical indicator readout for one instrument as of its
 * most recent candle. Every field is optional/undefined when there is not
 * enough candle history to compute it — never a fabricated value.
 */
export interface TechnicalSnapshot {
  readonly close: number;
  readonly ema20?: number;
  readonly ema50?: number;
  readonly ema200?: number;
  readonly rsi14?: number;
  readonly atr14?: number;
  readonly adx14?: number;
  readonly plusDi14?: number;
  readonly minusDi14?: number;
  readonly avgVolume20?: number;
  /** Highest high of the prior N candles, EXCLUDING the current/most recent candle. */
  readonly highestHigh20ExcludingCurrent?: number;
  readonly currentVolume: number;
  readonly momentum1M?: number;
  readonly momentum3M?: number;
  /** Stock 3M return minus benchmark 3M return. NOT the RSI oscillator. */
  readonly relativeStrength3M?: number;
  readonly benchmarkReturn3M?: number;
}

export type MarketRegime = "BULLISH" | "SIDEWAYS" | "BEARISH" | "UNKNOWN";

export interface MarketRegimeResult {
  readonly regime: MarketRegime;
  readonly reasons: readonly string[];
  readonly asOf: string; // ISO-8601, timestamp of the benchmark candle used
}

export type TradingExecutionMode = "BACKTEST" | "PAPER" | "LIVE";

export interface ScoreComponent {
  readonly name: string;
  readonly score: number;
  readonly maxScore: number;
  readonly reason: string;
}

export interface StrategyEvaluationResult {
  readonly strategyId: string;
  readonly eligible: boolean;
  readonly reason?: string;
  /** 0-100. Only meaningful when eligible is true. */
  readonly score: number;
  readonly components: readonly ScoreComponent[];
}

/**
 * Strategy weighting/threshold sub-shape. Every field trading strategies
 * consult lives on TradingConfig directly, so this alias exists purely to
 * give call sites a narrower, self-documenting parameter type.
 */
export type TradingStrategyConfig = TradingConfig;

export interface StrategyEvaluationContext {
  readonly instrument: TradingInstrument;
  readonly candles: readonly Candle[];
  readonly benchmarkCandles: readonly Candle[];
  readonly snapshot: TechnicalSnapshot;
  readonly regime: MarketRegimeResult;
  readonly config: TradingStrategyConfig;
}

/**
 * One pluggable scanning strategy. The scanner iterates over an array of
 * registered TradeStrategy instances — it never assumes there are exactly
 * two, so a future strategy (e.g. mean-reversion) can register alongside
 * these without changing this interface or the scanner.
 */
export interface TradeStrategy {
  readonly id: string;
  readonly name: string;
  evaluate(context: StrategyEvaluationContext): StrategyEvaluationResult;
}

/** One ranked long-candidate opportunity produced by a scan. */
export interface TradeOpportunity {
  readonly instrumentToken: number;
  readonly exchange: string;
  readonly tradingsymbol: string;
  readonly primaryStrategy: string;
  readonly finalScore: number;
  readonly regime: MarketRegime;
  readonly reasons: readonly string[];
  readonly metrics: Record<string, unknown>;
  readonly asOf: string; // ISO-8601
}

export interface TradingScanFailure {
  readonly tradingsymbol: string;
  readonly error: string;
}

export interface TradingScanResult {
  /** Assigned at persistence time; absent for an in-memory, not-yet-persisted scan. */
  readonly scanId?: string;
  readonly startedAt: string; // ISO-8601
  readonly completedAt: string; // ISO-8601
  readonly benchmark: string;
  readonly marketRegime: MarketRegimeResult;
  readonly totalInstruments: number;
  readonly analyzedInstruments: number;
  readonly skippedInstruments: number;
  readonly failedInstruments: number;
  readonly opportunities: readonly TradeOpportunity[];
  readonly failures: readonly TradingScanFailure[];
}

/**
 * All tunable scanner/strategy parameters. See app/src/trading/config.ts for
 * defaults, env-override loading, and validation.
 */
export interface TradingConfig {
  readonly benchmarkSymbol: string;

  readonly emaFastPeriod: number;
  readonly emaMediumPeriod: number;
  readonly emaSlowPeriod: number;
  readonly rsiPeriod: number;
  readonly atrPeriod: number;
  readonly adxPeriod: number;

  readonly rsiMomentumLowerBound: number;
  readonly rsiMomentumUpperBound: number;

  readonly adxBullishThreshold: number;
  readonly adxSidewaysThreshold: number;

  readonly breakoutLookback: number;
  readonly breakoutVolumeMultiplier: number;
  readonly breakoutAdxThreshold: number;

  readonly momentum1MLookbackDays: number;
  readonly momentum3MLookbackDays: number;

  readonly minimumAverageTradedValue: number;
  readonly minimumAverageVolume: number;
  readonly minimumStockPrice: number;

  readonly atrPreferredRangeLowPct: number;
  readonly atrPreferredRangeHighPct: number;

  readonly relativeStrengthThreshold: number;

  readonly minimumOpportunityScore: number;
  readonly scannerConcurrency: number;

  readonly allowSidewaysForTrendMomentum: boolean;
  readonly allowSidewaysForBreakout: boolean;

  readonly executionMode: TradingExecutionMode;

  /** Operator-configured symbol list. NOT hardcoded to NIFTY 500 anywhere in source. */
  readonly staticUniverseSymbols: readonly string[];

  readonly trendMomentumWeights: {
    readonly trendStructure: number;
    readonly relativeStrength: number;
    readonly momentum3M: number;
    readonly volumeQuality: number;
    readonly volatilityQuality: number;
    readonly liquidity: number;
  };

  readonly breakoutWeights: {
    readonly breakoutStrength: number;
    readonly volumeExpansion: number;
    readonly trendQuality: number;
    readonly adxStrength: number;
    readonly relativeStrength: number;
    readonly volatilityQuality: number;
    readonly liquidity: number;
  };
}

// --- Repository port -------------------------------------------------------

export interface ListOpportunitiesFilter {
  readonly minScore?: number;
  readonly strategy?: string;
  readonly limit?: number;
}

export interface PersistScanInput {
  readonly result: TradingScanResult;
}

/** Fire-and-log audit record of one order-placement attempt. See app/src/database/schema.ts#tradingOrders. */
export interface RecordOrderInput {
  readonly kiteOrderId?: string;
  readonly tradingsymbol: string;
  readonly exchange: string;
  readonly transactionType: "BUY" | "SELL";
  readonly quantity: number;
  readonly orderType: "MARKET" | "LIMIT";
  readonly product: "CNC" | "MIS" | "NRML";
  readonly price?: number;
  readonly status: "submitted" | "failed";
  readonly errorMessage?: string;
}

export interface TradingRepositoryPort {
  /** Persists a completed scan and its opportunities; returns the scan with its assigned scanId. */
  saveScan(input: PersistScanInput): Promise<TradingScanResult>;
  getLatestScan(): Promise<TradingScanResult | null>;
  listOpportunities(
    filter?: ListOpportunitiesFilter,
  ): Promise<readonly TradeOpportunity[]>;
  getOpportunity(tradingsymbol: string): Promise<TradeOpportunity | null>;
  /** Fire-and-log only — not an execution gate, and no order-lifecycle tracking. */
  recordOrder(input: RecordOrderInput): Promise<void>;
}
