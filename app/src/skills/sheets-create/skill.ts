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
const rowSchema = z.array(cellSchema).max(50);
const tabSchema = z
  .object({
    name: z.string().trim().min(1).max(200),
    headers: z.array(z.string().trim().min(1).max(200)).min(1).max(50),
    rows: z.array(rowSchema).max(500).optional(),
    /** Header text -> allowed values. Adds an enforced dropdown to that column. */
    columnOptions: z
      .record(z.string(), z.array(z.string().trim().min(1).max(200)).min(1).max(100))
      .optional(),
  })
  .strict();
const inputSchema = z
  .object({
    title: z.string().trim().min(1).max(200),
    tabs: z.array(tabSchema).min(1).max(20),
  })
  .strict();

export type SheetsCreateInput = z.infer<typeof inputSchema>;
export interface SheetsCreateOutput {
  readonly spreadsheetId: string;
  readonly url: string;
  readonly tabs: readonly { readonly name: string; readonly sheetId: number }[];
}

export function createSheetsCreateSkill(client?: GoogleSheetsClient) {
  return defineSkill<SheetsCreateInput, SheetsCreateOutput>({
    name: "sheets_create",
    description:
      "Creates a brand-new Google Sheet, optionally with several tabs in one call (e.g. one tab per month). Each tab gets its own title, column headers, optional starting rows, and optional dropdown-restricted columns (columnOptions: header -> allowed values, e.g. a Category column). Applies a bold colored header row and sized columns automatically. Decide the tabs/headers/rows/dropdowns yourself based on what the user described; this tool builds and formats whatever structure it's given, it does not design the structure itself.",
    inputDescription:
      '{ "title": string, "tabs": [{ "name": string, "headers": string[], "rows"?: (string|number|boolean|null)[][], "columnOptions"?: { [header]: string[] } }] }',
    pack: "google",
    inputSchema,
    execution: { mutability: "write", impact: "normal" },
    configured: client !== undefined,
    async execute(
      input: SheetsCreateInput,
      context: SkillContext,
    ): Promise<SkillResult<SheetsCreateOutput>> {
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
        const created = await client.createSpreadsheet({
          title: input.title,
          tabs: input.tabs.map((tab) => ({
            name: tab.name,
            headers: tab.headers,
            ...(tab.rows ? { rows: tab.rows } : {}),
            ...(tab.columnOptions ? { columnOptions: tab.columnOptions } : {}),
          })),
          ...(context.signal ? { signal: context.signal } : {}),
        });
        return { success: true, data: created };
      } catch (error: unknown) {
        if (context.signal?.aborted) throw error;
        return { success: false, error: sheetsErrorToFailure(error) };
      }
    },
  });
}
