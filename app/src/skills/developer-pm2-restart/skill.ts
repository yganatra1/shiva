import { z } from "zod";

import { defineSkill } from "../define-skill";
import type { SkillContext, SkillResult } from "../types";
import {
  BuildRestartRunner,
  buildRestartRunnerErrorToFailure,
} from "../../tools/developer/build-restart-runner";

export interface DeveloperPm2RestartOutput {
  readonly repo: string;
  readonly pm2Service: string;
  readonly restarted: boolean;
  readonly restartOutput: string;
  readonly restartDurationMs: number;
  readonly restartTruncated: boolean;
}

/**
 * A repo is selectable here only if it appears in both DEVELOPER_AGENT_REPOS
 * and DEVELOPER_AGENT_PM2_SERVICES, matching developer_build_restart and
 * developer_pm2_status — the model can only ever pick a name from that
 * intersection, never a raw PM2 process name.
 */
export function createDeveloperPm2RestartSkill(
  repos: Readonly<Record<string, string>>,
  pm2Services: Readonly<Record<string, string>>,
  runner?: BuildRestartRunner,
) {
  const repoNames = Object.keys(repos).filter(
    (name) => pm2Services[name] !== undefined,
  );
  const inputSchema = z.object({
    repo:
      repoNames.length > 0
        ? z.enum(repoNames as [string, ...string[]])
        : z.string(),
  });
  type DeveloperPm2RestartInput = z.infer<typeof inputSchema>;

  return defineSkill<DeveloperPm2RestartInput, DeveloperPm2RestartOutput>({
    name: "developer_pm2_restart",
    description:
      `Restarts one configured repository's PM2 service ("pm2 restart") directly, without building it first. Configured repositories: ${
        repoNames.length > 0 ? repoNames.join(", ") : "(none)"
      }. Only call this when the user's original request explicitly asked to restart the running service and did not ask for a build or code change to be applied — use developer_build_restart instead when a fresh build must be restarted into.`,
    inputDescription: `{ "repo": ${
      repoNames.length > 0
        ? repoNames.map((name) => `"${name}"`).join(" | ")
        : "string"
    } }`,
    inputSchema,
    execution: {
      mutability: "write",
      impact: "sensitive",
      confirmationReason:
        "Restarts this repository's real running PM2 service without rebuilding it.",
    },
    configured: repoNames.length > 0 && runner !== undefined,
    async execute(
      input: DeveloperPm2RestartInput,
      context: SkillContext,
    ): Promise<SkillResult<DeveloperPm2RestartOutput>> {
      const pm2Service = pm2Services[input.repo];
      if (!runner || !pm2Service) {
        return {
          success: false,
          error: {
            code: "DEVELOPER_PM2_RESTART_UNAVAILABLE",
            message:
              "Developer Agent PM2 restart is not configured for that repository.",
          },
        };
      }
      try {
        const result = await runner.restart(pm2Service, context.signal);
        return {
          success: true,
          data: {
            repo: input.repo,
            pm2Service,
            restarted: true,
            restartOutput: result.restartOutput,
            restartDurationMs: result.restartDurationMs,
            restartTruncated: result.restartTruncated,
          },
        };
      } catch (error: unknown) {
        if (context.signal?.aborted) throw error;
        return { success: false, error: buildRestartRunnerErrorToFailure(error) };
      }
    },
  });
}
