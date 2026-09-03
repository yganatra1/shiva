import { and, desc, eq, gte, sql } from "drizzle-orm";

import type { ShivaDatabase } from "../database/pool.js";
import { tradeOpportunities, tradingOrders, tradingScans } from "../database/schema.js";
import type {
  ListOpportunitiesFilter,
  MarketRegime,
  PersistScanInput,
  RecordOrderInput,
  TradeOpportunity,
  TradingRepositoryPort,
  TradingScanResult,
} from "./types";

const MAX_LIST_LIMIT = 200;
const DEFAULT_LIST_LIMIT = 50;

type ScanRow = typeof tradingScans.$inferSelect;
type OpportunityRow = typeof tradeOpportunities.$inferSelect;

/** PostgreSQL-backed persistence for trading scans and their opportunities. */
export class DrizzleTradingRepository implements TradingRepositoryPort {
  constructor(private readonly database: ShivaDatabase) {}

  async saveScan(input: PersistScanInput): Promise<TradingScanResult> {
    const { result } = input;
    return this.database.transaction(async (transaction) => {
      const [scanRow] = await transaction
        .insert(tradingScans)
        .values({
          startedAt: new Date(result.startedAt),
          completedAt: new Date(result.completedAt),
          benchmark: result.benchmark,
          marketRegime: result.marketRegime.regime,
          totalInstruments: result.totalInstruments,
          analyzedInstruments: result.analyzedInstruments,
          skippedInstruments: result.skippedInstruments,
          failedInstruments: result.failedInstruments,
        })
        .returning();
      const scan = requiredRow(scanRow, "trading scan");

      if (result.opportunities.length > 0) {
        await transaction.insert(tradeOpportunities).values(
          result.opportunities.map((opportunity) => ({
            scanId: scan.id,
            instrumentToken: opportunity.instrumentToken,
            exchange: opportunity.exchange,
            tradingsymbol: opportunity.tradingsymbol,
            primaryStrategy: opportunity.primaryStrategy,
            finalScore: opportunity.finalScore,
            regime: opportunity.regime,
            reasonsJson: opportunity.reasons,
            metricsJson: opportunity.metrics,
          })),
        );
      }

      return {
        ...result,
        scanId: scan.id,
      };
    });
  }

  async getLatestScan(): Promise<TradingScanResult | null> {
    const [scan] = await this.database
      .select()
      .from(tradingScans)
      .orderBy(desc(tradingScans.startedAt))
      .limit(1);
    if (!scan) return null;
    const opportunities = await this.database
      .select()
      .from(tradeOpportunities)
      .where(eq(tradeOpportunities.scanId, scan.id))
      .orderBy(desc(tradeOpportunities.finalScore));
    return mapScan(scan, opportunities);
  }

  async listOpportunities(
    filter: ListOpportunitiesFilter = {},
  ): Promise<readonly TradeOpportunity[]> {
    const limit = assertLimit(filter.limit ?? DEFAULT_LIST_LIMIT);
    const latest = await this.database
      .select({ id: tradingScans.id })
      .from(tradingScans)
      .orderBy(desc(tradingScans.startedAt))
      .limit(1);
    const latestScanId = latest[0]?.id;
    if (!latestScanId) return [];

    const conditions = [eq(tradeOpportunities.scanId, latestScanId)];
    if (filter.minScore !== undefined) {
      conditions.push(gte(tradeOpportunities.finalScore, filter.minScore));
    }
    if (filter.strategy) {
      conditions.push(eq(tradeOpportunities.primaryStrategy, filter.strategy));
    }

    const rows = await this.database
      .select()
      .from(tradeOpportunities)
      .where(and(...conditions))
      .orderBy(desc(tradeOpportunities.finalScore))
      .limit(limit);
    return rows.map(mapOpportunity);
  }

  async getOpportunity(tradingsymbol: string): Promise<TradeOpportunity | null> {
    const symbol = requiredText(tradingsymbol, "tradingsymbol");
    const [row] = await this.database
      .select()
      .from(tradeOpportunities)
      .where(
        sql`upper(${tradeOpportunities.tradingsymbol}) = upper(${symbol})`,
      )
      .orderBy(desc(tradeOpportunities.createdAt))
      .limit(1);
    return row ? mapOpportunity(row) : null;
  }

  async recordOrder(input: RecordOrderInput): Promise<void> {
    await this.database.insert(tradingOrders).values({
      ...(input.kiteOrderId ? { kiteOrderId: input.kiteOrderId } : {}),
      tradingsymbol: input.tradingsymbol,
      exchange: input.exchange,
      transactionType: input.transactionType,
      quantity: input.quantity,
      orderType: input.orderType,
      product: input.product,
      ...(input.price !== undefined ? { price: input.price } : {}),
      status: input.status,
      ...(input.errorMessage ? { errorMessage: input.errorMessage } : {}),
    });
  }
}

function mapScan(
  scan: ScanRow,
  opportunityRows: readonly OpportunityRow[],
): TradingScanResult {
  return {
    scanId: scan.id,
    startedAt: scan.startedAt.toISOString(),
    completedAt: scan.completedAt.toISOString(),
    benchmark: scan.benchmark,
    marketRegime: {
      regime: scan.marketRegime as MarketRegime,
      reasons: [],
      asOf: scan.startedAt.toISOString(),
    },
    totalInstruments: scan.totalInstruments,
    analyzedInstruments: scan.analyzedInstruments,
    skippedInstruments: scan.skippedInstruments,
    failedInstruments: scan.failedInstruments,
    opportunities: opportunityRows.map(mapOpportunity),
    failures: [],
  };
}

function mapOpportunity(row: OpportunityRow): TradeOpportunity {
  return {
    instrumentToken: row.instrumentToken,
    exchange: row.exchange,
    tradingsymbol: row.tradingsymbol,
    primaryStrategy: row.primaryStrategy,
    finalScore: row.finalScore,
    regime: row.regime as MarketRegime,
    reasons: [...row.reasonsJson],
    metrics: { ...row.metricsJson },
    asOf: row.createdAt.toISOString(),
  };
}

function assertLimit(limit: number): number {
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_LIST_LIMIT) {
    throw new RangeError(`limit must be an integer between 1 and ${MAX_LIST_LIMIT}.`);
  }
  return limit;
}

function requiredText(value: string, name: string): string {
  const trimmed = value.trim();
  if (!trimmed) throw new TypeError(`${name} cannot be empty.`);
  return trimmed;
}

function requiredRow<T>(row: T | undefined, name: string): T {
  if (!row) throw new Error(`The database did not return the inserted ${name}.`);
  return row;
}
