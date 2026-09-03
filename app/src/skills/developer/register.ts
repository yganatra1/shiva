import type { DeveloperAgentConfig } from "../../config/environment";
import { ClaudeCodeRunner } from "../../tools/developer/claude-code-runner";
import { BuildRestartRunner } from "../../tools/developer/build-restart-runner";
import type { SkillRegistry } from "../registry";
import { createDeveloperExecuteSkill } from "../developer-execute/skill";
import { createDeveloperBuildRestartSkill } from "../developer-build-restart/skill";
import { createDeveloperPm2StatusSkill } from "../developer-pm2-status/skill";
import { createDeveloperPm2RestartSkill } from "../developer-pm2-restart/skill";

export function registerDeveloperSkills(
  registry: SkillRegistry,
  config: Pick<
    DeveloperAgentConfig,
    | "developerAgentRepos"
    | "developerAgentExecutionTimeoutMs"
    | "developerAgentMaxTurns"
    | "developerAgentPermissionMode"
    | "developerAgentAllowedTools"
    | "developerAgentPm2Services"
    | "developerAgentBuildTimeoutMs"
    | "developerAgentRestartTimeoutMs"
  >,
): void {
  const runner =
    Object.keys(config.developerAgentRepos).length > 0
      ? new ClaudeCodeRunner({
          timeoutMs: config.developerAgentExecutionTimeoutMs,
          maxTurns: config.developerAgentMaxTurns,
          permissionMode: config.developerAgentPermissionMode,
          allowedTools: config.developerAgentAllowedTools,
          env: process.env,
        })
      : undefined;

  registry.register(
    createDeveloperExecuteSkill(
      config.developerAgentRepos,
      config.developerAgentPermissionMode,
      config.developerAgentAllowedTools,
      runner,
    ),
  );

  const buildRestartRepoNames = Object.keys(config.developerAgentRepos).filter(
    (name) => config.developerAgentPm2Services[name] !== undefined,
  );
  const buildRestartRunner =
    buildRestartRepoNames.length > 0
      ? new BuildRestartRunner({
          buildTimeoutMs: config.developerAgentBuildTimeoutMs,
          restartTimeoutMs: config.developerAgentRestartTimeoutMs,
          env: process.env,
        })
      : undefined;

  registry.register(
    createDeveloperBuildRestartSkill(
      config.developerAgentRepos,
      config.developerAgentPm2Services,
      buildRestartRunner,
    ),
  );

  registry.register(
    createDeveloperPm2StatusSkill(
      config.developerAgentRepos,
      config.developerAgentPm2Services,
      buildRestartRunner,
    ),
  );

  registry.register(
    createDeveloperPm2RestartSkill(
      config.developerAgentRepos,
      config.developerAgentPm2Services,
      buildRestartRunner,
    ),
  );
}
