import type { TradingScannerService } from "./scanner/trading-scanner-service";
import type {
  ListOpportunitiesFilter,
  RecordOrderInput,
  TradeOpportunity,
  TradingRepositoryPort,
  TradingScanResult,
} from "./types";

export interface TradingServiceOptions {
  readonly scanner: TradingScannerService;
  readonly repository: TradingRepositoryPort;
}

/**
 * Thin orchestration layer used by both the Fastify routes
 * (app/src/api/trading-route.ts) and the trading-agent skills
 * (app/src/skills/trading/): runs a scan through TradingScannerService,
 * persists it via TradingRepositoryPort, and exposes read methods. Contains
 * no scoring logic of its own — see app/src/trading/scanner and
 * app/src/trading/strategies for the deterministic pipeline.
 */
export class TradingService {
  constructor(private readonly options: TradingServiceOptions) {}

  async runScan(): Promise<TradingScanResult> {
    const result = await this.options.scanner.scan();
    return this.options.repository.saveScan({ result });
  }

  async getLatestScan(): Promise<TradingScanResult | null> {
    return this.options.repository.getLatestScan();
  }

  async listOpportunities(
    filter?: ListOpportunitiesFilter,
  ): Promise<readonly TradeOpportunity[]> {
    return this.options.repository.listOpportunities(filter);
  }

  async getOpportunity(tradingsymbol: string): Promise<TradeOpportunity | null> {
    return this.options.repository.getOpportunity(tradingsymbol);
  }

  async recordOrder(input: RecordOrderInput): Promise<void> {
    await this.options.repository.recordOrder(input);
  }
}
