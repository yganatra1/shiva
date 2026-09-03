import assert from "node:assert/strict";
import { test } from "node:test";

import { SkillRegistry } from "../../../src/skills/registry.js";
import { createMutualFundRankSkill } from "../../../src/skills/mutual-fund-rank/skill.js";
import { createMutualFundCompareSkill } from "../../../src/skills/mutual-fund-compare/skill.js";
import { createMutualFundAnalyzeSkill } from "../../../src/skills/mutual-fund-analyze/skill.js";
import type { MutualFundAnalysisService } from "../../../src/finance/services/mutual-fund-analysis.service.js";
import type { MutualFundRankingService } from "../../../src/finance/services/mutual-fund-ranking.service.js";

test("mutual_fund_rank rejects an oversized limit and unknown horizon", async () => {
  const registry = new SkillRegistry();
  registry.register(
    createMutualFundRankSkill({} as MutualFundRankingService),
  );
  const skill = registry.get("mutual_fund_rank");
  const invalidLimit = skill.inputSchema.safeParse({
    category: "ELSS",
    limit: 26,
  });
  assert.equal(invalidLimit.success, false);
  const invalidHorizon = skill.inputSchema.safeParse({
    category: "ELSS",
    timeHorizonYears: 4,
  });
  assert.equal(invalidHorizon.success, false);
});

test("mutual_fund_compare rejects more than 10 schemes", () => {
  const skill = createMutualFundCompareSkill({} as MutualFundAnalysisService);
  const parsed = skill.inputSchema.safeParse({
    schemeCodes: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11],
  });
  assert.equal(parsed.success, false);
});

test("mutual_fund_analyze requires a positive integer scheme code", () => {
  const skill = createMutualFundAnalyzeSkill({} as MutualFundAnalysisService);
  assert.equal(skill.inputSchema.safeParse({ schemeCode: 0 }).success, false);
  assert.equal(skill.inputSchema.safeParse({ schemeCode: 120503 }).success, true);
});
