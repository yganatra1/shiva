import type { MutualFund, MutualFundAnalysis, MutualFundHistory } from "../types";

export interface StoredSchemeList {
  readonly fetchedAt: Date;
  readonly funds: readonly MutualFund[];
}

export interface StoredNavHistory {
  readonly schemeCode: number;
  readonly latestNavDate: string;
  readonly inceptionDate: string;
  readonly navObservationCount: number;
  readonly history: MutualFundHistory;
  readonly fetchedAt: Date;
}

export interface StoredAnalytics {
  readonly schemeCode: number;
  readonly latestNavDate: string;
  readonly calculationVersion: string;
  readonly riskFreeRate: number;
  readonly navObservationCount: number;
  readonly calculatedAt: Date;
  readonly assumptions: MutualFundAnalysis["assumptions"];
  readonly snapshot: MutualFundAnalysis;
}

export interface MutualFundRepository {
  getSchemeList(): Promise<StoredSchemeList | undefined>;
  saveSchemeList(funds: readonly MutualFund[], fetchedAt: Date): Promise<void>;
  getLatestNavHistory(schemeCode: number): Promise<StoredNavHistory | undefined>;
  saveNavHistory(history: MutualFundHistory, fetchedAt: Date): Promise<void>;
  getAnalytics(input: {
    readonly schemeCode: number;
    readonly latestNavDate: string;
    readonly calculationVersion: string;
  }): Promise<StoredAnalytics | undefined>;
  saveAnalytics(record: StoredAnalytics): Promise<void>;
}

export class InMemoryMutualFundRepository implements MutualFundRepository {
  private schemeList: StoredSchemeList | undefined;
  private readonly nav = new Map<number, StoredNavHistory>();
  private readonly analytics = new Map<string, StoredAnalytics>();

  async getSchemeList(): Promise<StoredSchemeList | undefined> {
    return this.schemeList;
  }

  async saveSchemeList(funds: readonly MutualFund[], fetchedAt: Date): Promise<void> {
    this.schemeList = { funds, fetchedAt };
  }

  async getLatestNavHistory(
    schemeCode: number,
  ): Promise<StoredNavHistory | undefined> {
    return this.nav.get(schemeCode);
  }

  async saveNavHistory(history: MutualFundHistory, fetchedAt: Date): Promise<void> {
    const first = history.nav[0];
    const last = history.nav[history.nav.length - 1];
    if (!first || !last) return;
    this.nav.set(history.fund.schemeCode, {
      schemeCode: history.fund.schemeCode,
      latestNavDate: last.date,
      inceptionDate: first.date,
      navObservationCount: history.nav.length,
      history,
      fetchedAt,
    });
  }

  async getAnalytics(input: {
    readonly schemeCode: number;
    readonly latestNavDate: string;
    readonly calculationVersion: string;
  }): Promise<StoredAnalytics | undefined> {
    return this.analytics.get(analyticsKey(input));
  }

  async saveAnalytics(record: StoredAnalytics): Promise<void> {
    this.analytics.set(
      analyticsKey({
        schemeCode: record.schemeCode,
        latestNavDate: record.latestNavDate,
        calculationVersion: record.calculationVersion,
      }),
      record,
    );
  }
}

function analyticsKey(input: {
  readonly schemeCode: number;
  readonly latestNavDate: string;
  readonly calculationVersion: string;
}): string {
  return `${input.schemeCode}:${input.latestNavDate}:${input.calculationVersion}`;
}
