import type { TradingConfig, TradingExecutionMode } from "./types";

/** Thrown by loadTradingConfigFromEnv on any invalid TradingConfig value. */
export class TradingConfigurationError extends Error {
  override readonly name = "TradingConfigurationError";
}

/**
 * Safe, conservative defaults. staticUniverseSymbols is a small illustrative
 * example list only — operators MUST configure TRADING_UNIVERSE_SYMBOLS (or
 * a custom InstrumentUniverseProvider) for real use. This scanner never
 * hardcodes NIFTY 500 or any other index membership in source.
 */
export const DEFAULT_TRADING_CONFIG: TradingConfig = {
  benchmarkSymbol: "NIFTY 50",

  emaFastPeriod: 20,
  emaMediumPeriod: 50,
  emaSlowPeriod: 200,
  rsiPeriod: 14,
  atrPeriod: 14,
  adxPeriod: 14,

  rsiMomentumLowerBound: 55,
  rsiMomentumUpperBound: 75,

  adxBullishThreshold: 20,
  adxSidewaysThreshold: 18,

  breakoutLookback: 20,
  breakoutVolumeMultiplier: 1.5,
  breakoutAdxThreshold: 20,

  momentum1MLookbackDays: 21,
  momentum3MLookbackDays: 63,

  minimumAverageTradedValue: 10_000_000,
  minimumAverageVolume: 100_000,
  minimumStockPrice: 20,

  atrPreferredRangeLowPct: 1.5,
  atrPreferredRangeHighPct: 5,

  relativeStrengthThreshold: 0,

  minimumOpportunityScore: 70,
  scannerConcurrency: 5,

  allowSidewaysForTrendMomentum: false,
  allowSidewaysForBreakout: false,

  executionMode: "PAPER",

  // Example/placeholder universe only — operator must configure
  // TRADING_UNIVERSE_SYMBOLS (comma-separated tradingsymbols) for real use.
  staticUniverseSymbols: ["RELIANCE", "TCS", "HDFCBANK", "INFY", "ICICIBANK"],

  trendMomentumWeights: {
    trendStructure: 30,
    relativeStrength: 25,
    momentum3M: 20,
    volumeQuality: 10,
    volatilityQuality: 10,
    liquidity: 5,
  },

  breakoutWeights: {
    breakoutStrength: 25,
    volumeExpansion: 20,
    trendQuality: 15,
    adxStrength: 15,
    relativeStrength: 10,
    volatilityQuality: 10,
    liquidity: 5,
  },
};

type EnvironmentLike = Readonly<Record<string, string | undefined>>;

const EXECUTION_MODES: readonly TradingExecutionMode[] = [
  "BACKTEST",
  "PAPER",
  "LIVE",
];

/**
 * Overlays TRADING_* environment variables onto DEFAULT_TRADING_CONFIG and
 * validates the result. Pure function: never reads process.env itself, and
 * never touches Date.now(), the DB, or a live broker connection.
 */
export function loadTradingConfigFromEnv(
  env: EnvironmentLike,
): TradingConfig {
  const config: TradingConfig = {
    benchmarkSymbol: stringOr(
      env.TRADING_BENCHMARK_SYMBOL,
      DEFAULT_TRADING_CONFIG.benchmarkSymbol,
    ),

    emaFastPeriod: intOr(env.TRADING_EMA_FAST_PERIOD, DEFAULT_TRADING_CONFIG.emaFastPeriod),
    emaMediumPeriod: intOr(
      env.TRADING_EMA_MEDIUM_PERIOD,
      DEFAULT_TRADING_CONFIG.emaMediumPeriod,
    ),
    emaSlowPeriod: intOr(env.TRADING_EMA_SLOW_PERIOD, DEFAULT_TRADING_CONFIG.emaSlowPeriod),
    rsiPeriod: intOr(env.TRADING_RSI_PERIOD, DEFAULT_TRADING_CONFIG.rsiPeriod),
    atrPeriod: intOr(env.TRADING_ATR_PERIOD, DEFAULT_TRADING_CONFIG.atrPeriod),
    adxPeriod: intOr(env.TRADING_ADX_PERIOD, DEFAULT_TRADING_CONFIG.adxPeriod),

    rsiMomentumLowerBound: numberOr(
      env.TRADING_RSI_MOMENTUM_LOWER_BOUND,
      DEFAULT_TRADING_CONFIG.rsiMomentumLowerBound,
    ),
    rsiMomentumUpperBound: numberOr(
      env.TRADING_RSI_MOMENTUM_UPPER_BOUND,
      DEFAULT_TRADING_CONFIG.rsiMomentumUpperBound,
    ),

    adxBullishThreshold: numberOr(
      env.TRADING_ADX_BULLISH_THRESHOLD,
      DEFAULT_TRADING_CONFIG.adxBullishThreshold,
    ),
    adxSidewaysThreshold: numberOr(
      env.TRADING_ADX_SIDEWAYS_THRESHOLD,
      DEFAULT_TRADING_CONFIG.adxSidewaysThreshold,
    ),

    breakoutLookback: intOr(
      env.TRADING_BREAKOUT_LOOKBACK,
      DEFAULT_TRADING_CONFIG.breakoutLookback,
    ),
    breakoutVolumeMultiplier: numberOr(
      env.TRADING_BREAKOUT_VOLUME_MULTIPLIER,
      DEFAULT_TRADING_CONFIG.breakoutVolumeMultiplier,
    ),
    breakoutAdxThreshold: numberOr(
      env.TRADING_BREAKOUT_ADX_THRESHOLD,
      DEFAULT_TRADING_CONFIG.breakoutAdxThreshold,
    ),

    momentum1MLookbackDays: intOr(
      env.TRADING_MOMENTUM_1M_LOOKBACK_DAYS,
      DEFAULT_TRADING_CONFIG.momentum1MLookbackDays,
    ),
    momentum3MLookbackDays: intOr(
      env.TRADING_MOMENTUM_3M_LOOKBACK_DAYS,
      DEFAULT_TRADING_CONFIG.momentum3MLookbackDays,
    ),

    minimumAverageTradedValue: numberOr(
      env.TRADING_MIN_AVERAGE_TRADED_VALUE,
      DEFAULT_TRADING_CONFIG.minimumAverageTradedValue,
    ),
    minimumAverageVolume: numberOr(
      env.TRADING_MIN_AVERAGE_VOLUME,
      DEFAULT_TRADING_CONFIG.minimumAverageVolume,
    ),
    minimumStockPrice: numberOr(
      env.TRADING_MIN_STOCK_PRICE,
      DEFAULT_TRADING_CONFIG.minimumStockPrice,
    ),

    atrPreferredRangeLowPct: numberOr(
      env.TRADING_ATR_PREFERRED_RANGE_LOW_PCT,
      DEFAULT_TRADING_CONFIG.atrPreferredRangeLowPct,
    ),
    atrPreferredRangeHighPct: numberOr(
      env.TRADING_ATR_PREFERRED_RANGE_HIGH_PCT,
      DEFAULT_TRADING_CONFIG.atrPreferredRangeHighPct,
    ),

    relativeStrengthThreshold: numberOr(
      env.TRADING_RELATIVE_STRENGTH_THRESHOLD,
      DEFAULT_TRADING_CONFIG.relativeStrengthThreshold,
    ),

    minimumOpportunityScore: numberOr(
      env.TRADING_MIN_OPPORTUNITY_SCORE,
      DEFAULT_TRADING_CONFIG.minimumOpportunityScore,
    ),
    scannerConcurrency: intOr(
      env.TRADING_SCANNER_CONCURRENCY,
      DEFAULT_TRADING_CONFIG.scannerConcurrency,
    ),

    allowSidewaysForTrendMomentum: boolOr(
      env.TRADING_ALLOW_SIDEWAYS_FOR_TREND_MOMENTUM,
      DEFAULT_TRADING_CONFIG.allowSidewaysForTrendMomentum,
    ),
    allowSidewaysForBreakout: boolOr(
      env.TRADING_ALLOW_SIDEWAYS_FOR_BREAKOUT,
      DEFAULT_TRADING_CONFIG.allowSidewaysForBreakout,
    ),

    executionMode: executionModeOr(
      env.TRADING_EXECUTION_MODE,
      DEFAULT_TRADING_CONFIG.executionMode,
    ),

    staticUniverseSymbols: symbolListOr(
      env.TRADING_UNIVERSE_SYMBOLS,
      DEFAULT_TRADING_CONFIG.staticUniverseSymbols,
    ),

    trendMomentumWeights: {
      trendStructure: numberOr(
        env.TRADING_WEIGHT_TREND_STRUCTURE,
        DEFAULT_TRADING_CONFIG.trendMomentumWeights.trendStructure,
      ),
      relativeStrength: numberOr(
        env.TRADING_WEIGHT_TREND_RELATIVE_STRENGTH,
        DEFAULT_TRADING_CONFIG.trendMomentumWeights.relativeStrength,
      ),
      momentum3M: numberOr(
        env.TRADING_WEIGHT_TREND_MOMENTUM_3M,
        DEFAULT_TRADING_CONFIG.trendMomentumWeights.momentum3M,
      ),
      volumeQuality: numberOr(
        env.TRADING_WEIGHT_TREND_VOLUME_QUALITY,
        DEFAULT_TRADING_CONFIG.trendMomentumWeights.volumeQuality,
      ),
      volatilityQuality: numberOr(
        env.TRADING_WEIGHT_TREND_VOLATILITY_QUALITY,
        DEFAULT_TRADING_CONFIG.trendMomentumWeights.volatilityQuality,
      ),
      liquidity: numberOr(
        env.TRADING_WEIGHT_TREND_LIQUIDITY,
        DEFAULT_TRADING_CONFIG.trendMomentumWeights.liquidity,
      ),
    },

    breakoutWeights: {
      breakoutStrength: numberOr(
        env.TRADING_WEIGHT_BREAKOUT_STRENGTH,
        DEFAULT_TRADING_CONFIG.breakoutWeights.breakoutStrength,
      ),
      volumeExpansion: numberOr(
        env.TRADING_WEIGHT_BREAKOUT_VOLUME_EXPANSION,
        DEFAULT_TRADING_CONFIG.breakoutWeights.volumeExpansion,
      ),
      trendQuality: numberOr(
        env.TRADING_WEIGHT_BREAKOUT_TREND_QUALITY,
        DEFAULT_TRADING_CONFIG.breakoutWeights.trendQuality,
      ),
      adxStrength: numberOr(
        env.TRADING_WEIGHT_BREAKOUT_ADX_STRENGTH,
        DEFAULT_TRADING_CONFIG.breakoutWeights.adxStrength,
      ),
      relativeStrength: numberOr(
        env.TRADING_WEIGHT_BREAKOUT_RELATIVE_STRENGTH,
        DEFAULT_TRADING_CONFIG.breakoutWeights.relativeStrength,
      ),
      volatilityQuality: numberOr(
        env.TRADING_WEIGHT_BREAKOUT_VOLATILITY_QUALITY,
        DEFAULT_TRADING_CONFIG.breakoutWeights.volatilityQuality,
      ),
      liquidity: numberOr(
        env.TRADING_WEIGHT_BREAKOUT_LIQUIDITY,
        DEFAULT_TRADING_CONFIG.breakoutWeights.liquidity,
      ),
    },
  };

  validateTradingConfig(config);
  return config;
}

export function validateTradingConfig(config: TradingConfig): void {
  requirePositiveInt(config.emaFastPeriod, "emaFastPeriod");
  requirePositiveInt(config.emaMediumPeriod, "emaMediumPeriod");
  requirePositiveInt(config.emaSlowPeriod, "emaSlowPeriod");
  requirePositiveInt(config.rsiPeriod, "rsiPeriod");
  requirePositiveInt(config.atrPeriod, "atrPeriod");
  requirePositiveInt(config.adxPeriod, "adxPeriod");
  requirePositiveInt(config.breakoutLookback, "breakoutLookback");
  requirePositiveInt(config.momentum1MLookbackDays, "momentum1MLookbackDays");
  requirePositiveInt(config.momentum3MLookbackDays, "momentum3MLookbackDays");
  requirePositiveInt(config.scannerConcurrency, "scannerConcurrency");

  if (!(config.emaFastPeriod < config.emaMediumPeriod && config.emaMediumPeriod < config.emaSlowPeriod)) {
    throw new TradingConfigurationError(
      "emaFastPeriod < emaMediumPeriod < emaSlowPeriod must hold.",
    );
  }
  requireRange(config.rsiMomentumLowerBound, 0, 100, "rsiMomentumLowerBound");
  requireRange(config.rsiMomentumUpperBound, 0, 100, "rsiMomentumUpperBound");
  if (config.rsiMomentumLowerBound >= config.rsiMomentumUpperBound) {
    throw new TradingConfigurationError(
      "rsiMomentumLowerBound must be less than rsiMomentumUpperBound.",
    );
  }
  requireRange(config.adxBullishThreshold, 0, 100, "adxBullishThreshold");
  requireRange(config.adxSidewaysThreshold, 0, 100, "adxSidewaysThreshold");
  if (config.adxSidewaysThreshold >= config.adxBullishThreshold) {
    throw new TradingConfigurationError(
      "adxSidewaysThreshold must be less than adxBullishThreshold.",
    );
  }
  requirePositive(config.breakoutVolumeMultiplier, "breakoutVolumeMultiplier");
  requireRange(config.breakoutAdxThreshold, 0, 100, "breakoutAdxThreshold");
  requireNonNegative(config.minimumAverageTradedValue, "minimumAverageTradedValue");
  requireNonNegative(config.minimumAverageVolume, "minimumAverageVolume");
  requireNonNegative(config.minimumStockPrice, "minimumStockPrice");
  requirePositive(config.atrPreferredRangeLowPct, "atrPreferredRangeLowPct");
  requirePositive(config.atrPreferredRangeHighPct, "atrPreferredRangeHighPct");
  if (config.atrPreferredRangeLowPct >= config.atrPreferredRangeHighPct) {
    throw new TradingConfigurationError(
      "atrPreferredRangeLowPct must be less than atrPreferredRangeHighPct.",
    );
  }
  requireRange(config.minimumOpportunityScore, 0, 100, "minimumOpportunityScore");
  if (!config.benchmarkSymbol.trim()) {
    throw new TradingConfigurationError("benchmarkSymbol cannot be empty.");
  }
  if (!EXECUTION_MODES.includes(config.executionMode)) {
    throw new TradingConfigurationError(
      `executionMode must be one of ${EXECUTION_MODES.join(", ")}.`,
    );
  }
  if (config.staticUniverseSymbols.length === 0) {
    throw new TradingConfigurationError(
      "staticUniverseSymbols cannot be empty when no other instrument universe provider is configured.",
    );
  }
  for (const [label, weights] of [
    ["trendMomentumWeights", config.trendMomentumWeights],
    ["breakoutWeights", config.breakoutWeights],
  ] as const) {
    const total = Object.values(weights).reduce((sum, value) => sum + value, 0);
    if (Math.abs(total - 100) > 0.001) {
      throw new TradingConfigurationError(
        `${label} must sum to 100 (got ${total}).`,
      );
    }
    for (const [key, value] of Object.entries(weights)) {
      requireNonNegative(value, `${label}.${key}`);
    }
  }
}

function stringOr(value: string | undefined, fallback: string): string {
  const trimmed = value?.trim();
  return trimmed ? trimmed : fallback;
}

function numberOr(value: string | undefined, fallback: number): number {
  if (value === undefined || value.trim() === "") return fallback;
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    throw new TradingConfigurationError(`Invalid numeric value: "${value}".`);
  }
  return parsed;
}

function intOr(value: string | undefined, fallback: number): number {
  const parsed = numberOr(value, fallback);
  if (!Number.isInteger(parsed)) {
    throw new TradingConfigurationError(`Expected an integer value, got "${value}".`);
  }
  return parsed;
}

function boolOr(value: string | undefined, fallback: boolean): boolean {
  if (value === undefined || value.trim() === "") return fallback;
  const normalized = value.trim().toLowerCase();
  if (normalized === "true") return true;
  if (normalized === "false") return false;
  throw new TradingConfigurationError(
    `Expected "true" or "false", got "${value}".`,
  );
}

function executionModeOr(
  value: string | undefined,
  fallback: TradingExecutionMode,
): TradingExecutionMode {
  if (value === undefined || value.trim() === "") return fallback;
  const normalized = value.trim().toUpperCase();
  if (!EXECUTION_MODES.includes(normalized as TradingExecutionMode)) {
    throw new TradingConfigurationError(
      `executionMode must be one of ${EXECUTION_MODES.join(", ")}, got "${value}".`,
    );
  }
  return normalized as TradingExecutionMode;
}

function symbolListOr(
  value: string | undefined,
  fallback: readonly string[],
): readonly string[] {
  if (value === undefined || value.trim() === "") return fallback;
  const symbols = value
    .split(",")
    .map((symbol) => symbol.trim().toUpperCase())
    .filter((symbol) => symbol.length > 0);
  if (symbols.length === 0) return fallback;
  return symbols;
}

function requirePositiveInt(value: number, name: string): void {
  if (!Number.isInteger(value) || value <= 0) {
    throw new TradingConfigurationError(`${name} must be a positive integer.`);
  }
}

function requirePositive(value: number, name: string): void {
  if (!Number.isFinite(value) || value <= 0) {
    throw new TradingConfigurationError(`${name} must be a positive number.`);
  }
}

function requireNonNegative(value: number, name: string): void {
  if (!Number.isFinite(value) || value < 0) {
    throw new TradingConfigurationError(`${name} must be a non-negative number.`);
  }
}

function requireRange(value: number, min: number, max: number, name: string): void {
  if (!Number.isFinite(value) || value < min || value > max) {
    throw new TradingConfigurationError(`${name} must be between ${min} and ${max}.`);
  }
}
