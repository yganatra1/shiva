import type { AppConfig } from "../../config/environment.js";
import { WebOpenTool } from "../../tools/web/open.js";
import { BraveWebSearchTool } from "../../tools/web/search.js";
import type { SkillRegistry } from "../registry.js";
import { WebResearchSkill } from "../web-research/skill.js";

export function registerWebSkills(
  registry: SkillRegistry,
  config: AppConfig,
): void {
  if (config.braveSearchApiKey) {
    registry.register(
      new WebResearchSkill(
        new BraveWebSearchTool({
          apiKey: config.braveSearchApiKey,
          baseUrl: config.braveSearchUrl,
          requestTimeoutMs: config.webRequestTimeoutMs,
        }),
        new WebOpenTool({
          requestTimeoutMs: config.webRequestTimeoutMs,
          maxContentBytes: config.webMaxContentBytes,
        }),
      ),
    );
  } else {
    registry.register(new WebResearchSkill());
  }
}
