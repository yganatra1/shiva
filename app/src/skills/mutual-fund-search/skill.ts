import { z } from "zod";

import { defineSkill } from "../define-skill";
import { MutualFundError, mutualFundErrorToFailure } from "../../finance/errors";
import { presentJson } from "../../finance/presentation";
import { rankSearchResults } from "../../finance/search";
import type { MutualFundService } from "../../finance/services/mutual-fund.service";
import type { SkillContext, SkillResult } from "../types";

const inputSchema = z
  .object({
    query: z.string().trim().min(2).max(200),
    limit: z.number().int().min(1).max(25).default(10),
  })
  .strict();

export type MutualFundSearchInput = z.infer<typeof inputSchema>;

export function createMutualFundSearchSkill(funds: MutualFundService) {
  return defineSkill({
    name: "mutual_fund_search",
    description:
      "Resolves an Indian mutual-fund name to MFapi scheme codes. Returns plan/option classification (Direct/Regular, Growth/IDCW). Prefer Direct Growth schemes unless the user asked otherwise. Use this before analyze/compare/rank when the scheme code is unknown.",
    inputDescription:
      '{ "query": "Axis ELSS", "limit"?: 1-25 (default 10) }',
    inputSchema,
    execution: { mutability: "read", impact: "normal" },
    configured: true,
    async execute(
      input: MutualFundSearchInput,
      context: SkillContext,
    ): Promise<SkillResult<unknown>> {
      try {
        const remote = await funds.search(input.query, context.signal);
        let matches = rankSearchResults(input.query, remote, input.limit);
        if (matches.length === 0) {
          const listed = await funds.listFunds(context.signal);
          matches = rankSearchResults(input.query, listed, input.limit);
        }
        return {
          success: true,
          data: presentJson({
            query: input.query,
            matches,
            dataCoverage: {
              navHistory: true,
              expenseRatio: false,
              aum: false,
              holdings: false,
              fundManager: false,
              benchmark: false,
            },
          }),
        };
      } catch (error: unknown) {
        if (context.signal?.aborted) throw error;
        return { success: false, error: mutualFundErrorToFailure(error) };
      }
    },
  });
}

export function isMutualFundError(error: unknown): error is MutualFundError {
  return error instanceof MutualFundError;
}
