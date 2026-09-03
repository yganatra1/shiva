import { classifySchemeVariant } from "../calculations/scheme-variant";
import { normalizeNavHistory } from "../calculations/nav-history";
import { MutualFundError } from "../errors";
import type { FinanceLogSink } from "../logging";
import type { MutualFund, MutualFundDataProvider, MutualFundHistory } from "../types";
import {
  MfApiClient,
  type MfApiSchemeHistory,
  type MfApiSchemeListItem,
} from "./mfapi.client";

export class MfApiMutualFundProvider implements MutualFundDataProvider {
  constructor(
    private readonly client: MfApiClient,
    private readonly logger: FinanceLogSink,
  ) {}

  async searchFunds(
    query: string,
    signal?: AbortSignal,
  ): Promise<readonly MutualFund[]> {
    const started = Date.now();
    const items = await this.client.searchSchemes(query, signal);
    this.logger.info(
      {
        tool: "mutual_fund_search",
        provider: "mfapi",
        queryLength: query.length,
        resultCount: items.length,
        apiLatencyMs: Date.now() - started,
        cache: "miss",
      },
      "mfapi search completed",
    );
    return items.map(listItemToFund);
  }

  async listFunds(signal?: AbortSignal): Promise<readonly MutualFund[]> {
    const started = Date.now();
    const items = await this.client.listSchemes(signal);
    this.logger.info(
      {
        provider: "mfapi",
        resultCount: items.length,
        apiLatencyMs: Date.now() - started,
        cache: "miss",
      },
      "mfapi scheme list completed",
    );
    return items.map(listItemToFund);
  }

  async getFundHistory(
    schemeCode: number,
    signal?: AbortSignal,
  ): Promise<MutualFundHistory> {
    const started = Date.now();
    const payload = await this.client.getSchemeHistory(schemeCode, signal);
    const history = historyToFund(payload);
    this.logger.info(
      {
        provider: "mfapi",
        schemeCode,
        navRecords: history.nav.length,
        apiLatencyMs: Date.now() - started,
        cache: "miss",
      },
      "mfapi history fetched",
    );
    return history;
  }

  probe(signal?: AbortSignal): Promise<boolean> {
    return this.client.probe(signal);
  }
}

export function listItemToFund(item: MfApiSchemeListItem): MutualFund {
  return {
    schemeCode: item.schemeCode,
    schemeName: item.schemeName,
    variant: classifySchemeVariant(item.schemeName),
    ...(item.isinGrowth !== undefined ? { isinGrowth: item.isinGrowth } : {}),
    ...(item.isinDivReinvestment !== undefined
      ? { isinDividendReinvestment: item.isinDivReinvestment }
      : {}),
  };
}

export function historyToFund(payload: MfApiSchemeHistory): MutualFundHistory {
  const normalized = normalizeNavHistory(payload.data);
  if (normalized.nav.length === 0) {
    throw new MutualFundError(
      "INSUFFICIENT_NAV_HISTORY",
      `Scheme ${payload.meta.scheme_code} has no usable NAV observations.`,
    );
  }
  const fund: MutualFund = {
    schemeCode: payload.meta.scheme_code,
    schemeName: payload.meta.scheme_name,
    variant: classifySchemeVariant(payload.meta.scheme_name),
    ...(payload.meta.fund_house ? { fundHouse: payload.meta.fund_house } : {}),
    ...(payload.meta.scheme_type ? { schemeType: payload.meta.scheme_type } : {}),
    ...(payload.meta.scheme_category
      ? { schemeCategory: payload.meta.scheme_category }
      : {}),
    ...(payload.meta.isin_growth !== undefined
      ? { isinGrowth: payload.meta.isin_growth }
      : {}),
    ...(payload.meta.isin_div_reinvestment !== undefined
      ? { isinDividendReinvestment: payload.meta.isin_div_reinvestment }
      : {}),
  };
  return { fund, nav: normalized.nav };
}
