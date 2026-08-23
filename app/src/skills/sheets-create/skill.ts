import { z } from "zod";

import { defineSkill } from "../define-skill";
import type { SkillContext, SkillResult } from "../types";
import {
  GoogleSheetsClient,
  sheetsErrorToFailure,
  type TabDefinition,
} from "../../tools/sheets/client";

const cellSchema = z.union([
  z.string().max(5_000),
  z.number().finite(),
  z.boolean(),
  z.null(),
]);
const rowSchema = z.array(cellSchema).max(50);
// Deliberately lenient: only a tab existing at all is required. Everything
// else (name, headers, rows, columnOptions) is optional and defaulted/
// dropped rather than rejected, and unrecognized keys are silently ignored
// instead of failing the whole call — a struggling model should be able to
// create a bare, correct spreadsheet on the first try, then add structure
// with a follow-up sheets_update rather than needing every field right away.
const tabSchema = z.object({
  name: z.string().trim().max(200).optional(),
  headers: z.array(z.string().trim().max(200)).max(50).optional(),
  rows: z.array(rowSchema).max(500).optional(),
  /** Header text -> allowed values. Adds an enforced dropdown to that column. */
  columnOptions: z
    .record(z.string(), z.array(z.string().trim().max(200)).max(100))
    .optional(),
});
const inputSchema = z.object({
  title: z.string().trim().max(200).optional(),
  tabs: z.array(tabSchema).max(20).optional(),
});

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
      'Creates a brand-new Google Sheet. The only thing that ever matters is getting something created — every field is optional and defaulted, so the simplest valid call is just {"title":"My Sheet"}. Optionally add tabs (one per month, etc.), each with a name, headers, starting rows, and dropdown-restricted columns (columnOptions: header -> allowed values). If you are not confident about headers/rows/columnOptions, leave them out and call sheets_update afterward to add them — that two-step path is more reliable than trying to get the full nested shape right in one call. Applies a bold colored header row automatically when headers are given.',
    inputDescription:
      '{ "title"?: string, "tabs"?: [{ "name"?: string, "headers"?: string[], "rows"?: (string|number|boolean|null)[][], "columnOptions"?: { [header]: string[] } }] } — everything is optional',
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
          title: input.title?.trim() || "Untitled Spreadsheet",
          tabs: normalizeTabs(input.tabs),
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

function normalizeTabs(
  tabs: SheetsCreateInput["tabs"],
): readonly TabDefinition[] {
  const source = tabs && tabs.length > 0 ? tabs : [{}];
  return source.map((tab, index) => {
    const name = tab.name?.trim() || `Sheet${index + 1}`;
    const headers = tab.headers
      ?.map((header) => header.trim())
      .filter((header) => header.length > 0);
    const hasHeaders = headers !== undefined && headers.length > 0;
    // A dropdown on a header that doesn't exist (missing/renamed/typo'd) is
    // dropped rather than failing spreadsheet creation over one bad column.
    const columnOptions =
      hasHeaders && tab.columnOptions
        ? Object.fromEntries(
            Object.entries(tab.columnOptions).filter(([header, values]) =>
              headers.includes(header) && values.length > 0,
            ),
          )
        : undefined;
    return {
      name,
      ...(hasHeaders ? { headers } : {}),
      ...(tab.rows && tab.rows.length > 0 ? { rows: tab.rows } : {}),
      ...(columnOptions && Object.keys(columnOptions).length > 0
        ? { columnOptions }
        : {}),
    };
  });
}
