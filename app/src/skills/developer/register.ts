import type { DeveloperAgentConfig } from "../../config/environment";
import { ClaudeCodeRunner } from "../../tools/developer/claude-code-runner";
import type { SkillRegistry } from "../registry";
import { createDeveloperExecuteSkill } from "../developer-execute/skill";

export function registerDeveloperSkills(
  registry: SkillRegistry,
  config: Pick<
    DeveloperAgentConfig,
    | "developerAgentRepos"
    | "developerAgentExecutionTimeoutMs"
    | "developerAgentMaxTurns"
  >,
): void {
  const runner =
    Object.keys(config.developerAgentRepos).length > 0
      ? new ClaudeCodeRunner({
          timeoutMs: config.developerAgentExecutionTimeoutMs,
          maxTurns: config.developerAgentMaxTurns,
          env: process.env,
        })
      : undefined;

  registry.register(
    createDeveloperExecuteSkill(config.developerAgentRepos, runner),
  );
}
