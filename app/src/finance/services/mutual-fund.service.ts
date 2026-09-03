import { MUTUAL_FUND_CALCULATION_VERSION } from "../constants";
import { MutualFundError } from "../errors";
import type { FinanceLogSink } from "../logging";
import type { MutualFundRepository } from "../persistence/mutual-fund-repository";
import type { MutualFundDataProvider, MutualFundHistory } from "../types";

export interface MutualFundServiceOptions {
  readonly provider: MutualFundDataProvider;
  readonly repository: MutualFundRepository;
  readonly logger: FinanceLogSink;
  readonly listCacheTtlMs: number;
  readonly maxConcurrency: number;
}

/**
 * Resolves scheme metadata and NAV history. Analytics never talk to MFapi
 * directly; they go through this service so PostgreSQL can reuse a day's NAV.
 */
export class MutualFundService {
  private readonly inflightHistory = new Map<number, Promise<MutualFundHistory>>();

  constructor(private readonly options: MutualFundServiceOptions) {}

  async search(query: string, signal?: AbortSignal) {
    return this.options.provider.searchFunds(query, signal);
  }

  async listFunds(signal?: AbortSignal) {
    const cached = await this.options.repository.getSchemeList();
    if (
      cached &&
      Date.now() - cached.fetchedAt.getTime() < this.options.listCacheTtlMs
    ) {
      this.options.logger.info(
        {
          resultCount: cached.funds.length,
          cache: "hit",
        },
        "mutual fund scheme list cache hit",
      );
      return cached.funds;
    }
    const funds = await this.options.provider.listFunds(signal);
    await this.options.repository.saveSchemeList(funds, new Date());
    return funds;
  }

  async getHistory(
    schemeCode: number,
    signal?: AbortSignal,
  ): Promise<MutualFundHistory> {
    const existing = this.inflightHistory.get(schemeCode);
    if (existing) return existing;
    const pending = this.loadHistory(schemeCode, signal).finally(() => {
      this.inflightHistory.delete(schemeCode);
    });
    this.inflightHistory.set(schemeCode, pending);
    return pending;
  }

  private async loadHistory(
    schemeCode: number,
    signal?: AbortSignal,
  ): Promise<MutualFundHistory> {
    const cached = await this.options.repository.getLatestNavHistory(schemeCode);
    if (cached && isCurrentNavSnapshot(cached.latestNavDate, cached.fetchedAt)) {
      this.options.logger.info(
        {
          schemeCode,
          navRecords: cached.navObservationCount,
          latestNavDate: cached.latestNavDate,
          cache: "hit",
          calculationVersion: MUTUAL_FUND_CALCULATION_VERSION,
        },
        "mutual fund NAV cache hit",
      );
      return cached.history;
    }

    const history = await this.options.provider.getFundHistory(schemeCode, signal);
    const last = history.nav[history.nav.length - 1];
    if (!last) {
      throw new MutualFundError(
        "INSUFFICIENT_NAV_HISTORY",
        `Scheme ${schemeCode} has no usable NAV observations.`,
      );
    }
    await this.options.repository.saveNavHistory(history, new Date());
    this.options.logger.info(
      {
        schemeCode,
        navRecords: history.nav.length,
        latestNavDate: last.date,
        cache: "miss",
      },
      "mutual fund NAV persisted",
    );
    return history;
  }
}

/**
 * NAV is a once-per-business-day series. A snapshot whose latest date is today
 * (UTC, matching stored ISO dates) or that was fetched after that date's close
 * is treated as current. Older rows are reused only until the next provider fetch.
 */
function isCurrentNavSnapshot(latestNavDate: string, fetchedAt: Date): boolean {
  const today = new Date();
  const iso = `${today.getUTCFullYear()}-${String(today.getUTCMonth() + 1).padStart(2, "0")}-${String(today.getUTCDate()).padStart(2, "0")}`;
  if (latestNavDate >= iso) return true;
  const ageMs = Date.now() - fetchedAt.getTime();
  // Same-day re-fetch guard: if we already pulled after the last known NAV
  // within 6 hours, do not hammer MFapi. Analytics still key off latestNavDate.
  return ageMs < 6 * 60 * 60 * 1000;
}
