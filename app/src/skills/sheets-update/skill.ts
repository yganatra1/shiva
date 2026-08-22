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
const inputSchema = z.object({
  spreadsheetId: z.string().trim().min(5).max(256),
  range: z.string().trim().min(1).max(300),
  values: z.array(z.array(cellSchema).max(50)).min(1).max(500),
  mode: z.enum(["update", "append"]).default("append"),
});

export type SheetsUpdateInput = z.infer<typeof inputSchema>;
export interface SheetsUpdateOutput {
  readonly updatedRange: string;
  readonly updatedRows: number;
  readonly updatedColumns: number;
}

export function createSheetsUpdateSkill(client?: GoogleSheetsClient) {
  return defineSkill<SheetsUpdateInput, SheetsUpdateOutput>({
    name: "sheets_update",
    description:
      "Writes values into an existing Google Sheet at the given spreadsheetId + A1-notation range. mode=\"append\" adds new rows after the sheet's current content (use this for adding entries, e.g. a new expense/log/inventory row); mode=\"update\" overwrites the exact given range in place (use this to correct or replace existing cells). Before appending to an existing sheet, use sheets_read in the same run to inspect its live header/current structure and align the row correctly, unless sheets_create just returned that structure in this run.",
    inputDescription:
      '{ "spreadsheetId": string, "range": "A1 notation", "values": (string|number|boolean|null)[][], "mode"?: "update"|"append" (default "append") }',
    pack: "google",
    inputSchema,
    execution: { mutability: "write", impact: "normal" },
    configured: client !== undefined,
    async execute(
      input: SheetsUpdateInput,
      context: SkillContext,
    ): Promise<SkillResult<SheetsUpdateOutput>> {
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
        const result = await client.writeValues({
          spreadsheetId: input.spreadsheetId,
          range: input.range,
          values: input.values,
          mode: input.mode,
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
