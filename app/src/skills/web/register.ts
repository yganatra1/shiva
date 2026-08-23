import type { AppConfig } from "../../config/environment";
import { WebOpenTool } from "../../tools/web/open";
import { BraveWebSearchTool } from "../../tools/web/search";
import type { SkillRegistry } from "../registry";
import { WebResearchSkill } from "../web-research/skill";

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
