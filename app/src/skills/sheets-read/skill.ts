import { z } from "zod";

import { defineSkill } from "../define-skill.js";
import type { SkillContext, SkillResult } from "../types.js";
import {
  GoogleSheetsClient,
  sheetsErrorToFailure,
  type CellValue,
} from "../../tools/sheets/client.js";

const inputSchema = z.object({
  spreadsheetId: z.string().trim().min(5).max(256),
  range: z.string().trim().min(1).max(300),
});

export type SheetsReadInput = z.infer<typeof inputSchema>;
export interface SheetsReadOutput {
  readonly range: string;
  readonly values: readonly (readonly CellValue[])[];
}

export function createSheetsReadSkill(client?: GoogleSheetsClient) {
  return defineSkill<SheetsReadInput, SheetsReadOutput>({
    name: "sheets_read",
    description:
      "Reads the current values of a range from an existing Google Sheet (spreadsheetId + A1-notation range, e.g. 'Sheet1!A1:F50' or just 'Sheet1' for the whole tab). Use this to inspect a sheet's current structure/content before updating it, or to compute an answer over its data yourself.",
    inputDescription:
      '{ "spreadsheetId": string, "range": "A1 notation, e.g. Sheet1!A1:F50" }',
    pack: "google",
    inputSchema,
    execution: { mutability: "read", impact: "normal" },
    configured: client !== undefined,
    async execute(
      input: SheetsReadInput,
      context: SkillContext,
    ): Promise<SkillResult<SheetsReadOutput>> {
      if (!client) {
        return {
          success: false,
          error: {
            code: "GOOGLE_SHEETS_UNAVAILABLE",
            message: "Google Sheets is not configured.",
          },
        };
      }
      try {
        const result = await client.getValues({
          spreadsheetId: input.spreadsheetId,
          range: input.range,
          ...(context.signal ? { signal: context.signal } : {}),
        });
        return { success: true, data: result };
      } catch (error: unknown) {
        if (context.signal?.aborted) throw error;
        return { success: false, error: sheetsErrorToFailure(error) };
      }
    },
  });
}
