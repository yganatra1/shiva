import { z } from "zod";

import { defineSkill } from "../define-skill.js";
import type { SkillContext, SkillResult } from "../types.js";
import {
  GoogleSheetsClient,
  sheetsErrorToFailure,
} from "../../tools/sheets/client.js";

const cellSchema = z.union([
  z.string().max(5_000),
  z.number().finite(),
  z.boolean(),
  z.null(),
]);
const inputSchema = z
  .object({
    spreadsheetId: z.string().trim().min(5).max(256),
    name: z.string().trim().min(1).max(200),
    headers: z.array(z.string().trim().min(1).max(200)).min(1).max(50),
    rows: z.array(z.array(cellSchema).max(50)).max(500).optional(),
    columnOptions: z
      .record(z.string(), z.array(z.string().trim().min(1).max(200)).min(1).max(100))
      .optional(),
  })
  .strict();

export type SheetsAddTabInput = z.infer<typeof inputSchema>;
export interface SheetsAddTabOutput {
  readonly name: string;
  readonly sheetId: number;
}

export function createSheetsAddTabSkill(client?: GoogleSheetsClient) {
  return defineSkill<SheetsAddTabInput, SheetsAddTabOutput>({
    name: "sheets_add_tab",
    description:
      "Adds a new tab to an existing Google Sheet (found via sheets_find or a previously known spreadsheetId), with its own headers, optional starting rows, and optional dropdown-restricted columns. Use this for e.g. adding next month's tab to an existing tracker rather than creating a whole new spreadsheet.",
    inputDescription:
      '{ "spreadsheetId": string, "name": string, "headers": string[], "rows"?: (string|number|boolean|null)[][], "columnOptions"?: { [header]: string[] } }',
    pack: "google",
    inputSchema,
    execution: { mutability: "write", impact: "normal" },
    configured: client !== undefined,
    async execute(
      input: SheetsAddTabInput,
      context: SkillContext,
    ): Promise<SkillResult<SheetsAddTabOutput>> {
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
        const tab = await client.addTab({
          spreadsheetId: input.spreadsheetId,
          name: input.name,
          headers: input.headers,
          ...(input.rows ? { rows: input.rows } : {}),
          ...(input.columnOptions ? { columnOptions: input.columnOptions } : {}),
          ...(context.signal ? { signal: context.signal } : {}),
        });
        return { success: true, data: tab };
      } catch (error: unknown) {
        if (context.signal?.aborted) throw error;
        return { success: false, error: sheetsErrorToFailure(error) };
      }
    },
  });
}
