import { z } from "zod";

import { defineSkill } from "../define-skill";
import type { SkillContext, SkillResult } from "../types";
import {
  BuildRestartRunner,
  buildRestartRunnerErrorToFailure,
} from "../../tools/developer/build-restart-runner";

export interface DeveloperBuildRestartOutput {
  readonly repo: string;
  readonly buildDir: string;
  readonly buildOutput: string;
  readonly buildDurationMs: number;
  readonly buildTruncated: boolean;
  readonly pm2Service: string;
  readonly restarted: boolean;
  readonly restartOutput: string;
  readonly restartDurationMs: number;
  readonly restartTruncated: boolean;
}

/**
 * A repo is selectable here only if it appears in both DEVELOPER_AGENT_REPOS
 * and DEVELOPER_AGENT_PM2_SERVICES — the model can only ever pick a name from
 * that intersection, never supply a path or PM2 process name directly.
 */
export function createDeveloperBuildRestartSkill(
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
  type DeveloperBuildRestartInput = z.infer<typeof inputSchema>;

  return defineSkill<DeveloperBuildRestartInput, DeveloperBuildRestartOutput>({
    name: "developer_build_restart",
    description:
      `Runs "npm run build" in the directory containing package.json inside one configured repository, then restarts that repo's PM2 service — but only if the build succeeds; a failed build leaves the running service untouched. Configured repositories: ${
        repoNames.length > 0 ? repoNames.join(", ") : "(none)"
      }. Only call this when the user's original request explicitly asked to build, restart, deploy, or apply a code change to the running service — never infer that permission from a plain code-change instruction.`,
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
        "Builds this repository and restarts its real running PM2 service.",
    },
    configured: repoNames.length > 0 && runner !== undefined,
    async execute(
      input: DeveloperBuildRestartInput,
      context: SkillContext,
    ): Promise<SkillResult<DeveloperBuildRestartOutput>> {
      const repoPath = repos[input.repo];
      const pm2Service = pm2Services[input.repo];
      if (!runner || !repoPath || !pm2Service) {
        return {
          success: false,
          error: {
            code: "DEVELOPER_BUILD_RESTART_UNAVAILABLE",
            message:
              "Developer Agent build/restart is not configured for that repository.",
          },
        };
      }
      try {
        const result = await runner.run({
          repoPath,
          pm2ServiceName: pm2Service,
          ...(context.signal ? { signal: context.signal } : {}),
        });
        return {
          success: true,
          data: {
            repo: input.repo,
            buildDir: result.buildDir,
            buildOutput: result.buildOutput,
            buildDurationMs: result.buildDurationMs,
            buildTruncated: result.buildTruncated,
            pm2Service,
            restarted: result.restarted,
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
