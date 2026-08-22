import { z } from "zod";

import { defineSkill } from "../define-skill.js";
import type { SkillContext, SkillResult } from "../types.js";
import {
  GoogleSheetsClient,
  SheetsClientError,
  sheetsErrorToFailure,
  type CellValue,
  type CreatedTab,
} from "../../tools/sheets/client.js";

const inputSchema = z.object({
  spreadsheetId: z.string().trim().min(5).max(256),
  range: z.string().trim().min(1).max(300).optional(),
});

export type SheetsReadInput = z.infer<typeof inputSchema>;
export type SheetsReadOutput =
  | {
      readonly tabs: readonly CreatedTab[];
      readonly rejectedRange?: string;
    }
  | {
      readonly range: string;
      readonly values: readonly (readonly CellValue[])[];
    };

export function createSheetsReadSkill(client?: GoogleSheetsClient) {
  return defineSkill<SheetsReadInput, SheetsReadOutput>({
    name: "sheets_read",
    description:
      "Inspects an existing Google Sheet. When its tab names are unknown, call with only spreadsheetId to list the exact tabs first; never guess a tab such as Sheet1. Then call again with spreadsheetId + an A1-notation range using an exact returned tab name (e.g. 'August 2026'!A1:F50) to read its live headers and values before updating it.",
    inputDescription:
      '{ "spreadsheetId": string, "range"?: "A1 notation using an exact known tab name; omit to list tabs" }',
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
        const result = input.range
          ? await client.getValues({
              spreadsheetId: input.spreadsheetId,
              range: input.range,
              ...(context.signal ? { signal: context.signal } : {}),
            })
          : await client.listTabs({
              spreadsheetId: input.spreadsheetId,
              ...(context.signal ? { signal: context.signal } : {}),
            });
        return { success: true, data: result };
      } catch (error: unknown) {
        if (context.signal?.aborted) throw error;
        if (
          input.range &&
          error instanceof SheetsClientError &&
          error.failure === "INVALID_INPUT"
        ) {
          try {
            const result = await client.listTabs({
              spreadsheetId: input.spreadsheetId,
              ...(context.signal ? { signal: context.signal } : {}),
            });
            return {
              success: true,
              data: { ...result, rejectedRange: input.range },
            };
          } catch (recoveryError: unknown) {
            if (context.signal?.aborted) throw recoveryError;
            return {
              success: false,
              error: sheetsErrorToFailure(recoveryError),
            };
          }
        }
        return { success: false, error: sheetsErrorToFailure(error) };
      }
    },
  });
}
