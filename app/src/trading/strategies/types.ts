// Re-exported here (rather than redefined) so strategy files can import
// from a local, strategy-scoped module path while the canonical shapes stay
// defined once in app/src/trading/types.ts.
export type {
  ScoreComponent,
  StrategyEvaluationContext,
  StrategyEvaluationResult,
  TradeStrategy,
} from "../types";
