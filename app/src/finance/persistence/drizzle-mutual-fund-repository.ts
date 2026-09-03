import { and, desc, eq } from "drizzle-orm";

import type { ShivaDatabase } from "../../database/pool";
import {
  mutualFundAnalytics,
  mutualFundNavHistory,
  mutualFundSchemeListCache,
} from "../../database/schema";
import type { MutualFund, MutualFundAnalysis, MutualFundHistory } from "../types";
import type {
  MutualFundRepository,
  StoredAnalytics,
  StoredNavHistory,
  StoredSchemeList,
} from "./mutual-fund-repository";

const SCHEME_LIST_CACHE_ID = "mfapi";

export class DrizzleMutualFundRepository implements MutualFundRepository {
  constructor(private readonly db: ShivaDatabase) {}

  async getSchemeList(): Promise<StoredSchemeList | undefined> {
    const rows = await this.db
      .select()
      .from(mutualFundSchemeListCache)
      .where(eq(mutualFundSchemeListCache.id, SCHEME_LIST_CACHE_ID))
      .limit(1);
    const row = rows[0];
    if (!row) return undefined;
    return {
      fetchedAt: row.fetchedAt,
      funds: row.fundsJson,
    };
  }

  async saveSchemeList(funds: readonly MutualFund[], fetchedAt: Date): Promise<void> {
    await this.db
      .insert(mutualFundSchemeListCache)
      .values({
        id: SCHEME_LIST_CACHE_ID,
        fetchedAt,
        fundsJson: funds as MutualFund[],
        updatedAt: fetchedAt,
      })
      .onConflictDoUpdate({
        target: mutualFundSchemeListCache.id,
        set: {
          fetchedAt,
          fundsJson: funds as MutualFund[],
          updatedAt: fetchedAt,
        },
      });
  }

  async getLatestNavHistory(
    schemeCode: number,
  ): Promise<StoredNavHistory | undefined> {
    const rows = await this.db
      .select()
      .from(mutualFundNavHistory)
      .where(eq(mutualFundNavHistory.schemeCode, schemeCode))
      .orderBy(desc(mutualFundNavHistory.latestNavDate))
      .limit(1);
    const row = rows[0];
    if (!row) return undefined;
    return {
      schemeCode: row.schemeCode,
      latestNavDate: row.latestNavDate,
      inceptionDate: row.inceptionDate,
      navObservationCount: row.navObservationCount,
      fetchedAt: row.fetchedAt,
      history: row.historyJson,
    };
  }

  async saveNavHistory(history: MutualFundHistory, fetchedAt: Date): Promise<void> {
    const first = history.nav[0];
    const last = history.nav[history.nav.length - 1];
    if (!first || !last) return;
    await this.db
      .insert(mutualFundNavHistory)
      .values({
        schemeCode: history.fund.schemeCode,
        latestNavDate: last.date,
        inceptionDate: first.date,
        navObservationCount: history.nav.length,
        historyJson: history,
        fetchedAt,
        updatedAt: fetchedAt,
      })
      .onConflictDoUpdate({
        target: [
          mutualFundNavHistory.schemeCode,
          mutualFundNavHistory.latestNavDate,
        ],
        set: {
          inceptionDate: first.date,
          navObservationCount: history.nav.length,
          historyJson: history,
          fetchedAt,
          updatedAt: fetchedAt,
        },
      });
  }

  async getAnalytics(input: {
    readonly schemeCode: number;
    readonly latestNavDate: string;
    readonly calculationVersion: string;
  }): Promise<StoredAnalytics | undefined> {
    const rows = await this.db
      .select()
      .from(mutualFundAnalytics)
      .where(
        and(
          eq(mutualFundAnalytics.schemeCode, input.schemeCode),
          eq(mutualFundAnalytics.latestNavDate, input.latestNavDate),
          eq(mutualFundAnalytics.calculationVersion, input.calculationVersion),
        ),
      )
      .limit(1);
    const row = rows[0];
    if (!row) return undefined;
    return {
      schemeCode: row.schemeCode,
      latestNavDate: row.latestNavDate,
      calculationVersion: row.calculationVersion,
      riskFreeRate: row.riskFreeRate,
      navObservationCount: row.navObservationCount,
      calculatedAt: row.calculatedAt,
      assumptions: row.assumptionsJson,
      snapshot: row.snapshotJson,
    };
  }

  async saveAnalytics(record: StoredAnalytics): Promise<void> {
    await this.db
      .insert(mutualFundAnalytics)
      .values({
        schemeCode: record.schemeCode,
        latestNavDate: record.latestNavDate,
        calculationVersion: record.calculationVersion,
        riskFreeRate: record.riskFreeRate,
        navObservationCount: record.navObservationCount,
        assumptionsJson: record.assumptions,
        snapshotJson: record.snapshot,
        calculatedAt: record.calculatedAt,
      })
      .onConflictDoUpdate({
        target: [
          mutualFundAnalytics.schemeCode,
          mutualFundAnalytics.latestNavDate,
          mutualFundAnalytics.calculationVersion,
        ],
        set: {
          riskFreeRate: record.riskFreeRate,
          navObservationCount: record.navObservationCount,
          assumptionsJson: record.assumptions,
          snapshotJson: record.snapshot,
          calculatedAt: record.calculatedAt,
        },
      });
  }
}

export type { MutualFundAnalysis };
