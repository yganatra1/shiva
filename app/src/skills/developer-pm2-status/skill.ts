import { z } from "zod";

import { defineSkill } from "../define-skill";
import type { SkillContext, SkillResult } from "../types";
import {
  BuildRestartRunner,
  buildRestartRunnerErrorToFailure,
} from "../../tools/developer/build-restart-runner";

export interface DeveloperPm2StatusOutput {
  readonly repo: string;
  readonly pm2Service: string;
  readonly status: string;
  readonly pid: number | null;
  readonly restarts: number;
  readonly uptimeMs: number | null;
  readonly truncated: boolean;
}

/**
 * A repo is selectable here only if it appears in both DEVELOPER_AGENT_REPOS
 * and DEVELOPER_AGENT_PM2_SERVICES, matching developer_build_restart — the
 * model can only ever pick a name from that intersection, never a raw PM2
 * process name.
 */
export function createDeveloperPm2StatusSkill(
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
  type DeveloperPm2StatusInput = z.infer<typeof inputSchema>;

  return defineSkill<DeveloperPm2StatusInput, DeveloperPm2StatusOutput>({
    name: "developer_pm2_status",
    description:
      `Checks the live PM2 status ("pm2 list") of one configured repository's service — read-only, does not build or restart anything. Configured repositories: ${
        repoNames.length > 0 ? repoNames.join(", ") : "(none)"
      }. Use this to confirm a service is online, see its restart count, or verify a prior developer_build_restart actually brought it back up.`,
    inputDescription: `{ "repo": ${
      repoNames.length > 0
        ? repoNames.map((name) => `"${name}"`).join(" | ")
        : "string"
    } }`,
    inputSchema,
    execution: { mutability: "read", impact: "normal" },
    configured: repoNames.length > 0 && runner !== undefined,
    async execute(
      input: DeveloperPm2StatusInput,
      context: SkillContext,
    ): Promise<SkillResult<DeveloperPm2StatusOutput>> {
      const pm2Service = pm2Services[input.repo];
      if (!runner || !pm2Service) {
        return {
          success: false,
          error: {
            code: "DEVELOPER_PM2_STATUS_UNAVAILABLE",
            message:
              "Developer Agent PM2 status is not configured for that repository.",
          },
        };
      }
      try {
        const result = await runner.listStatus([pm2Service], context.signal);
        const service = result.services.find((entry) => entry.name === pm2Service);
        if (!service) {
          return {
            success: false,
            error: {
              code: "DEVELOPER_PM2_STATUS_NOT_FOUND",
              message: `PM2 reported no process named "${pm2Service}".`,
            },
          };
        }
        return {
          success: true,
          data: {
            repo: input.repo,
            pm2Service,
            status: service.status,
            pid: service.pid,
            restarts: service.restarts,
            uptimeMs: service.uptimeMs,
            truncated: result.truncated,
          },
        };
      } catch (error: unknown) {
        if (context.signal?.aborted) throw error;
        return { success: false, error: buildRestartRunnerErrorToFailure(error) };
      }
    },
  });
}
