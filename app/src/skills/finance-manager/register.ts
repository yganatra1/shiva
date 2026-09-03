import type { SkillRegistry } from "../registry";
import type { MutualFundAnalysisService } from "../../finance/services/mutual-fund-analysis.service";
import type { MutualFundRankingService } from "../../finance/services/mutual-fund-ranking.service";
import type { MutualFundService } from "../../finance/services/mutual-fund.service";
import { createMutualFundAnalyzeSkill } from "../mutual-fund-analyze/skill";
import { createMutualFundCompareSkill } from "../mutual-fund-compare/skill";
import { createMutualFundDetailsSkill } from "../mutual-fund-details/skill";
import { createMutualFundRankSkill } from "../mutual-fund-rank/skill";
import { createMutualFundSearchSkill } from "../mutual-fund-search/skill";

export function registerFinanceManagerSkills(
  registry: SkillRegistry,
  funds: MutualFundService,
  analysis: MutualFundAnalysisService,
  ranking: MutualFundRankingService,
): void {
  registry.register(createMutualFundSearchSkill(funds));
  registry.register(createMutualFundDetailsSkill(analysis));
  registry.register(createMutualFundAnalyzeSkill(analysis));
  registry.register(createMutualFundCompareSkill(analysis));
  registry.register(createMutualFundRankSkill(ranking));
}
