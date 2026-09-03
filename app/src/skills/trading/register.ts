import type { SkillRegistry } from "../registry";
import type { KiteClientPort } from "../../tools/kite/types";
import type { TradingService } from "../../trading/trading-service";
import { createTradingCancelOrderSkill } from "../trading-cancel-order/skill";
import { createTradingGetHoldingsSkill } from "../trading-get-holdings/skill";
import { createTradingGetLatestScanSkill } from "../trading-get-latest-scan/skill";
import { createTradingGetOpportunitiesSkill } from "../trading-get-opportunities/skill";
import { createTradingGetOpportunityDetailsSkill } from "../trading-get-opportunity-details/skill";
import { createTradingGetOrdersSkill } from "../trading-get-orders/skill";
import { createTradingGetPositionsSkill } from "../trading-get-positions/skill";
import { createTradingPlaceOrderSkill } from "../trading-place-order/skill";
import { createTradingRunScanSkill } from "../trading-run-scan/skill";

/**
 * Registers trading-agent's skills against an already-constructed
 * TradingService, mirroring registerGoogleSkills's shape. `kiteClient` is
 * optional/undefined when Kite is not configured — each skill below reports
 * its own "not configured" failure rather than the registry omitting it.
 */
export function registerTradingSkills(
  registry: SkillRegistry,
  tradingService: TradingService,
  kiteClient?: KiteClientPort,
): void {
  registry.register(createTradingGetOpportunitiesSkill(tradingService));
  registry.register(createTradingGetOpportunityDetailsSkill(tradingService));
  registry.register(createTradingGetLatestScanSkill(tradingService));
  registry.register(createTradingRunScanSkill(tradingService));
  registry.register(createTradingGetHoldingsSkill(kiteClient));
  registry.register(createTradingGetPositionsSkill(kiteClient));
  registry.register(createTradingGetOrdersSkill(kiteClient));
  registry.register(createTradingPlaceOrderSkill(kiteClient, tradingService));
  registry.register(createTradingCancelOrderSkill(kiteClient));
}
