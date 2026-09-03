# Trading — deterministic equity trade-opportunity scanner

This scanner identifies potential long-equity trade candidates for review.
It does not place orders, and no LLM is involved in generating scores or
signals — all output is deterministic and reproducible from market data.

It ships as a separate scoped agent process, `trading-agent`, mirroring the
existing `google-agent` pattern in this repo. Shiva's Core runtime never runs
scanner code itself and never gets a trading-specific skill of its own — Core
only knows about `trading-agent` through the generic `delegate_to_agent`
skill (see "How this differs from a Core skill" below).

## Pipeline

```
InstrumentUniverseProvider           MarketDataProvider
  (static list or Kite dump)           (Kite Connect, read-only)
        |                                     |
        v                                     v
   TradingInstrument[]  ---------->  Candle[] per instrument
                                     + benchmark Candle[]
                                            |
                                            v
                              detectMarketRegime(benchmarkCandles)
                                 BULLISH / SIDEWAYS / BEARISH / UNKNOWN
                                            |
        for each instrument (bounded concurrency, isolated failures)
                                            v
                          buildTechnicalSnapshot(candles, benchmark)
                        EMA20/50/200, RSI14, ATR14, ADX14, momentum,
                              relative strength vs benchmark
                                            v
                    [TrendMomentumStrategy, BreakoutVolumeStrategy, ...]
                       .evaluate({instrument, candles, snapshot, regime})
                                            v
                         StrategyEvaluationResult (eligible?, score, components)
                                            v
                    buildTradeOpportunity(...) -> TradeOpportunity | undefined
                       finalScore = HIGHEST eligible strategy score
                                            v
                              TradingScanResult (ranked opportunities)
                                            v
                    DrizzleTradingRepository.saveScan (Postgres)
```

The scanner (`scanner/trading-scanner-service.ts`) iterates over an array of
registered `TradeStrategy` instances — it never hardcodes "exactly two
strategies" — so a future strategy (e.g. mean-reversion) can be added without
touching `TradeStrategy`, `StrategyEvaluationContext`, or the scanner itself.

Nothing under `app/src/trading/` reads `Date.now()`, live Kite/broker state,
HTTP request state, or DB state directly — all market state (candles,
config, "now") is passed in explicitly, which is what keeps the pipeline
pure-function testable today and backtest-replayable later.

## Market regime rules

Computed once per scan from the benchmark's candles only
(`regime/market-regime-engine.ts`):

- **UNKNOWN** — insufficient benchmark history to compute EMA50/EMA200/ADX.
- **BULLISH** — close > EMA50 > EMA200 **and** ADX ≥ `adxBullishThreshold`.
- **BEARISH** — close < EMA50 < EMA200.
- **SIDEWAYS** — ADX < `adxSidewaysThreshold` and neither of the above holds
  (also the fallback for an ambiguous EMA structure that isn't clearly
  trending either way).

Every classification carries deterministic, human-readable `reasons`
strings (e.g. "Benchmark close (24,150.00) is above EMA50 (23,800.00) and
EMA200 (22,900.00).").

## Strategy #1 — Trend + Momentum

Eligible only in a **BULLISH** regime by default (`allowSidewaysForTrendMomentum`
opts SIDEWAYS in). Ineligible in BEARISH/UNKNOWN, on an illiquid instrument,
or without enough history to compute every indicator it scores — it returns
`eligible: false` with a reason rather than fabricating a score.

| Component | Weight | What it measures |
|---|---|---|
| trendStructure | 30 | close>EMA20>EMA50>EMA200 ordering (graduated by margin) with RSI14-in-[`rsiMomentumLowerBound`,`rsiMomentumUpperBound`] folded in as partial credit |
| relativeStrength | 25 | stock 3M return − benchmark 3M return vs `relativeStrengthThreshold`, graduated above it |
| momentum3M | 20 | stock's own 3-month momentum magnitude |
| volumeQuality | 10 | current / 20-day-average volume ratio |
| volatilityQuality | 10 | ATR/close vs the preferred band (`atrPreferredRangeLowPct`–`atrPreferredRangeHighPct`) |
| liquidity | 5 | graduated bonus for being comfortably above the liquidity minimums |

## Strategy #2 — Breakout + Volume Expansion

Eligible only in a **BULLISH** regime by default (`allowSidewaysForBreakout`
opts SIDEWAYS in). All of the following must hold, or the strategy returns
`eligible: false` (these are gates, not scored components):

- close > highest high of the prior `breakoutLookback` candles, **excluding
  the current candle** (see "Look-ahead bias" below).
- current volume ≥ `breakoutVolumeMultiplier` × the 20-day average volume,
  also excluding the current candle from that average.
- close > EMA50 > EMA200.
- ADX ≥ `breakoutAdxThreshold`.
- Liquidity filter passes.

| Component | Weight | What it measures |
|---|---|---|
| breakoutStrength | 25 | % close is above the prior high |
| volumeExpansion | 20 | volume ratio vs the 20-day average |
| trendQuality | 15 | close>EMA50>EMA200 margin |
| adxStrength | 15 | ADX magnitude above the breakout threshold |
| relativeStrength | 10 | stock 3M return − benchmark 3M return |
| volatilityQuality | 10 | ATR/close vs the preferred band |
| liquidity | 5 | graduated bonus above the liquidity minimums |

## Look-ahead bias

Two indicators are deliberately computed **excluding the most recent
candle**: the prior-N-day high used for breakout detection
(`indicators/volume.ts#highestHigh`) and the average volume used both for
breakout volume expansion and the liquidity filter
(`indicators/volume.ts#averageVolume`). A stock cannot be screened against a
window that includes its own still-forming/same-day candle. See
`test/trading/indicators.test.ts` for dedicated proofs of both, and
`test/trading/breakout-volume-strategy.test.ts` for a strategy-level proof.

## Scoring: finalScore is the best strategy, not an average

`scoring/opportunity-aggregation.ts#buildTradeOpportunity` sets
`finalScore` to the **highest** score among strategies eligible for that
instrument — never an average. A stock that is a strong breakout candidate
but a mediocre trend-momentum fit should be ranked on its best qualifying
setup. Below `minimumOpportunityScore` the instrument produces no
opportunity at all. Ties are broken deterministically: score desc, then
relative-strength desc, then liquidity/avg-traded-value desc, then
tradingsymbol.

## Configuration

All of these live in `TradingConfig` (`config.ts`), loaded via
`loadTradingConfigFromEnv` from `TRADING_*` environment variables (see
`.env.trading-agent.example` at the repo root). Every value has a safe
default; nothing is required to run in PAPER mode against a small universe.

| Env var | Meaning | Default |
|---|---|---|
| `TRADING_BENCHMARK_SYMBOL` | Benchmark used for regime + relative strength | `NIFTY 50` |
| `TRADING_EMA_FAST_PERIOD` | EMA fast period | `20` |
| `TRADING_EMA_MEDIUM_PERIOD` | EMA medium period | `50` |
| `TRADING_EMA_SLOW_PERIOD` | EMA slow period | `200` |
| `TRADING_RSI_PERIOD` | RSI period | `14` |
| `TRADING_ATR_PERIOD` | ATR period | `14` |
| `TRADING_ADX_PERIOD` | ADX period | `14` |
| `TRADING_RSI_MOMENTUM_LOWER_BOUND` | RSI band lower bound | `55` |
| `TRADING_RSI_MOMENTUM_UPPER_BOUND` | RSI band upper bound | `75` |
| `TRADING_ADX_BULLISH_THRESHOLD` | ADX ≥ this ⇒ trending (bullish check) | `20` |
| `TRADING_ADX_SIDEWAYS_THRESHOLD` | ADX < this ⇒ non-trending | `18` |
| `TRADING_BREAKOUT_LOOKBACK` | Prior-high/avg-volume window (days) | `20` |
| `TRADING_BREAKOUT_VOLUME_MULTIPLIER` | Required volume vs 20-day average | `1.5` |
| `TRADING_BREAKOUT_ADX_THRESHOLD` | Minimum ADX for a breakout | `20` |
| `TRADING_MOMENTUM_1M_LOOKBACK_DAYS` | 1-month momentum window (trading days) | `21` |
| `TRADING_MOMENTUM_3M_LOOKBACK_DAYS` | 3-month momentum window (trading days) | `63` |
| `TRADING_MIN_AVERAGE_TRADED_VALUE` | Liquidity gate (₹) | `10000000` (₹1cr) |
| `TRADING_MIN_AVERAGE_VOLUME` | Liquidity gate (shares) | `100000` |
| `TRADING_MIN_STOCK_PRICE` | Minimum price filter | `20` |
| `TRADING_ATR_PREFERRED_RANGE_LOW_PCT` | ATR/close preferred band low | `1.5` |
| `TRADING_ATR_PREFERRED_RANGE_HIGH_PCT` | ATR/close preferred band high | `5` |
| `TRADING_RELATIVE_STRENGTH_THRESHOLD` | Min 3M outperformance vs benchmark to score | `0` |
| `TRADING_MIN_OPPORTUNITY_SCORE` | Minimum finalScore to appear as an opportunity | `70` |
| `TRADING_SCANNER_CONCURRENCY` | Instruments evaluated in parallel | `5` |
| `TRADING_ALLOW_SIDEWAYS_FOR_TREND_MOMENTUM` | Allow SIDEWAYS regime for strategy #1 | `false` |
| `TRADING_ALLOW_SIDEWAYS_FOR_BREAKOUT` | Allow SIDEWAYS regime for strategy #2 | `false` |
| `TRADING_EXECUTION_MODE` | `BACKTEST` \| `PAPER` \| `LIVE` (informational only — no order placement exists) | `PAPER` |
| `TRADING_UNIVERSE_SYMBOLS` | Comma-separated tradingsymbols to scan | example placeholder list — **configure your own** |
| `TRADING_WEIGHT_TREND_*` (6 vars) | Trend+Momentum score weights (must sum to 100) | `30,25,20,10,10,5` |
| `TRADING_WEIGHT_BREAKOUT_*` (7 vars) | Breakout score weights (must sum to 100) | `25,20,15,15,10,10,5` |

`TRADING_UNIVERSE_SYMBOLS` is never hardcoded to NIFTY 500 or any other index
in source — `StaticInstrumentUniverseProvider` reads whatever list is
configured, and `KiteInstrumentUniverseProvider` (below) filters Kite's own
instrument dump to that same configured list.

### Kite Connect (read-only market data)

`app/src/tools/kite` is a read-only Kite Connect client — it never places an
order and exposes no CE/PE/options/short-selling surface. Configure it via:

| Env var | Meaning | Default |
|---|---|---|
| `KITE_API_KEY` | Kite Connect API key | — |
| `KITE_API_SECRET` | Only used by the manual session-generation script | — |
| `KITE_ACCESS_TOKEN` | Daily access token (see below) | — |
| `KITE_BASE_URL` | Override for testing | `https://api.kite.trade` |
| `KITE_REQUEST_TIMEOUT_MS` | HTTP timeout | `15000` |

**Kite access tokens expire daily** and require an interactive browser
login — this backend does not and cannot automate that login. Once a day:

1. Visit `https://kite.trade/connect/login?api_key=<KITE_API_KEY>&v=3` in a
   browser and log in. Kite redirects to your registered redirect URL with
   `?request_token=...` in the query string.
2. Run:
   ```
   KITE_API_KEY=... KITE_API_SECRET=... \
     npm run kite:generate-session -- <request_token>
   ```
3. Set the printed `KITE_ACCESS_TOKEN` for the `trading-agent` (and
   `shiva-api`, if it also runs scans) process and restart it.

**Without `KITE_API_KEY`/`KITE_ACCESS_TOKEN` configured, the scanner still
runs** — it falls back to an in-memory placeholder market data source that
returns zero candles per instrument, so every instrument is gracefully
skipped (`skippedInstruments`) rather than the scan crashing. A scan in this
state completes with zero opportunities; this is documented degraded mode,
not an error.

## Running a scan

```bash
# via the trading-agent process directly
cd app && npm run agent:trading      # foreground, one-shot worker process
cd app && npm run dev:trading-agent  # watch mode for local development

# via the internal HTTP API (requires TRADING_API_TOKEN)
curl -X POST http://127.0.0.1:3000/trading/scans \
  -H "Authorization: Bearer $TRADING_API_TOKEN"
```

## API

All routes require `Authorization: Bearer $TRADING_API_TOKEN` (same
timing-safe comparison as `/internal/scheduler/execute`) and are only
registered when both `DATABASE_URL` and `TRADING_API_TOKEN` are configured.

### `POST /trading/scans`

Triggers a fresh scan and persists it.

```json
{
  "scan": {
    "scanId": "b2b0...",
    "startedAt": "2026-09-03T03:45:00.000Z",
    "completedAt": "2026-09-03T03:45:12.000Z",
    "benchmark": "NIFTY 50",
    "marketRegime": { "regime": "BULLISH", "reasons": ["..."], "asOf": "..." },
    "totalInstruments": 5,
    "analyzedInstruments": 5,
    "skippedInstruments": 0,
    "failedInstruments": 0,
    "opportunities": [ { "tradingsymbol": "RELIANCE", "finalScore": 82.4, "...": "..." } ],
    "failures": []
  }
}
```

### `GET /trading/scans/latest`

Same shape as above, for the most recently persisted scan. `404
TRADING_SCAN_NOT_FOUND` if none has ever run.

### `GET /trading/opportunities?minScore=70&strategy=trend-momentum&limit=25`

```json
{ "opportunities": [ { "tradingsymbol": "TCS", "finalScore": 88.1, "primaryStrategy": "trend-momentum", "reasons": ["..."], "metrics": {"...": "..."} } ] }
```

### `GET /trading/opportunities/:symbol`

```json
{ "opportunity": { "tradingsymbol": "TCS", "finalScore": 88.1, "reasons": ["..."], "metrics": {"componentScores": {"trendStructure": {"score": 24.5, "maxScore": 30}}} } }
```

`404 TRADING_OPPORTUNITY_NOT_FOUND` if that symbol has no opportunity in the
latest scan.

## Portfolio reads and order placement (trading-agent skills)

Beyond the deterministic scanner, `trading-agent` exposes five more skills
that talk to Kite directly (not through the scanner pipeline):

| Skill | mutability / impact | What it does |
|---|---|---|
| `trading_get_holdings` | read / normal | Current holdings + total P&L |
| `trading_get_positions` | read / normal | Net + day positions |
| `trading_get_orders` | read / normal | Today's order statuses ("did my order fill") |
| `trading_place_order` | write / **sensitive** | Places a real BUY/SELL equity order |
| `trading_cancel_order` | write / **sensitive** | Cancels a real order |

**Order placement always executes live against Kite — there is no
paper/simulation mode.** It requires one explicit user confirmation (Shiva's
standard sensitive-action approval) before the order is sent. Keep account
balances/margins low as your own additional risk control.

`trading_place_order` and `trading_cancel_order` declare
`execution: { mutability: "write", impact: "sensitive", confirmationReason: "..." }`
— the same pattern `developer_pm2_restart` and other high-consequence skills
in this codebase already use. That metadata is all either skill declares;
Shiva's existing executor/policy-engine confirmation flow (not any
trading-specific code) is what actually blocks the call until the user
confirms it. No CE/PE/options and no short selling exist anywhere in this
surface — `transactionType` is a plain `BUY`/`SELL` on an equity
`tradingsymbol`.

Every order-placement attempt (success or failure) is logged to the
`trading_orders` table as a simple fire-and-log audit row — it is not an
execution gate and it does not track an order's live lifecycle; call
`trading_get_orders` for that.

## How trading-agent differs from a Core skill

`trading-agent` is its own process — its own `SkillRegistry`, `AgentLoop` +
`ShivaAgentPlanner`, and Redis `AgentWorker` — exactly like `google-agent`
and `developer-agent`. Shiva's Core runtime never imports or executes any
trading code; it only knows `trading-agent` exists via one
`agentRegistry.register({ id: "trading-agent", ... })` call in
`app/src/agent/runtime.ts`, and reaches it through the generic
`delegate_to_agent` skill Core already has. There is no
`trading_get_opportunities`-style skill registered on Core's own registry.

Trading-agent's own skills (`app/src/skills/trading/register.ts`) do all the
deterministic computation/DB reads in their `execute()` methods. The LLM
wrapping them (`ShivaAgentPlanner` + `TRADING_AGENT_DOMAIN_RULES`) is strictly
a dispatch/formatting layer: it decides which `trading_get_*`/`trading_run_scan`
tool to call and phrases the already-computed result in prose. It never
invents a score, signal, or reason of its own — see
`app/src/agents/trading/trading-planner-rules.ts`.

## Running the tests

```bash
cd app
npx tsx --test 'test/trading/*.test.ts'   # this domain only
npm test                                    # the full suite
```

Tests use hand-built `Candle[]` fixtures and in-memory fake
providers/repositories (`test/trading/trading-test-support.ts`) — no live
Kite, database, or network access. `test/trading/kite-client.test.ts` injects
a fake `fetch` and never makes a real HTTP call.
