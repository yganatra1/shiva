import { z } from "zod";

import { defineSkill } from "../define-skill";
import type { SkillContext, SkillResult } from "../types";
import {
  GoogleSheetsClient,
  sheetsErrorToFailure,
} from "../../tools/sheets/client";

const cellSchema = z.union([
  z.string().max(5_000),
  z.number().finite(),
  z.boolean(),
  z.null(),
]);
const inputSchema = z.object({
  spreadsheetId: z.string().trim().min(5).max(256),
  name: z.string().trim().max(200).optional(),
  headers: z.array(z.string().trim().max(200)).max(50).optional(),
  rows: z.array(z.array(cellSchema).max(50)).max(500).optional(),
  columnOptions: z
    .record(z.string(), z.array(z.string().trim().max(200)).max(100))
    .optional(),
});

export type SheetsAddTabInput = z.infer<typeof inputSchema>;
export interface SheetsAddTabOutput {
  readonly name: string;
  readonly sheetId: number;
}

export function createSheetsAddTabSkill(client?: GoogleSheetsClient) {
  return defineSkill<SheetsAddTabInput, SheetsAddTabOutput>({
    name: "sheets_add_tab",
    description:
      'Adds a new tab to an existing Google Sheet (found via sheets_find or a previously known spreadsheetId). Only spreadsheetId is truly required — name/headers/rows/columnOptions are optional and defaulted, so if you are not confident about the full shape, add a bare tab first ({"spreadsheetId":"..."}) and populate it with a follow-up sheets_update. Use this for e.g. adding next month\'s tab to an existing tracker rather than creating a whole new spreadsheet.',
    inputDescription:
      '{ "spreadsheetId": string, "name"?: string, "headers"?: string[], "rows"?: (string|number|boolean|null)[][], "columnOptions"?: { [header]: string[] } }',
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
      const headers = input.headers
        ?.map((header) => header.trim())
        .filter((header) => header.length > 0);
      const hasHeaders = headers !== undefined && headers.length > 0;
      const columnOptions =
        hasHeaders && input.columnOptions
          ? Object.fromEntries(
              Object.entries(input.columnOptions).filter(
                ([header, values]) => headers.includes(header) && values.length > 0,
              ),
            )
          : undefined;
      try {
        const tab = await client.addTab({
          spreadsheetId: input.spreadsheetId,
          name: input.name?.trim() || "New Tab",
          ...(hasHeaders ? { headers } : {}),
          ...(input.rows && input.rows.length > 0 ? { rows: input.rows } : {}),
          ...(columnOptions && Object.keys(columnOptions).length > 0
            ? { columnOptions }
            : {}),
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
