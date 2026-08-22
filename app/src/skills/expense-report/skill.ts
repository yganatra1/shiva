import { z } from "zod";

import type { ShivaSkill } from "../types.js";
import type { ExpenseListTool } from "../../tools/expenses/list.js";
import type { ExpenseRecord } from "../../tools/expenses/types.js";
import type { ExpenseReportInput, ExpenseReportOutput } from "./types.js";

const timestampSchema = z.string().trim().datetime({ offset: true });
const MAX_DETAIL_ROWS = 25;
const MAX_DETAIL_CHARACTERS = 8_000;
const expenseReportInputSchema = z
  .object({
    from: timestampSchema.optional(),
    until: timestampSchema.optional(),
    limit: z.number().int().min(1).max(MAX_DETAIL_ROWS).default(MAX_DETAIL_ROWS),
  })
  .strict()
  .refine(
    (input) =>
      !input.from ||
      !input.until ||
      new Date(input.until).getTime() > new Date(input.from).getTime(),
    { message: "until must be later than from" },
  );

export class ExpenseReportSkill
  implements ShivaSkill<ExpenseReportInput, ExpenseReportOutput>
{
  readonly name = "expense_report";
  readonly description =
    "Reads fresh rows from the configured expense sheet and calculates exact totals by currency.";
  readonly inputDescription =
    '{ "from"?: inclusive RFC3339 timestamp, "until"?: exclusive RFC3339 timestamp, "limit"?: number of detail rows, 1-25 }';
  readonly inputSchema: z.ZodType<ExpenseReportInput> =
    expenseReportInputSchema;
  readonly execution = { mutability: "read", impact: "normal" } as const;
  readonly configured: boolean;

  constructor(private readonly listTool?: ExpenseListTool) {
    this.configured = listTool !== undefined;
  }

  classifyExecution(
    _input: ExpenseReportInput,
    context: Parameters<ShivaSkill<ExpenseReportInput, ExpenseReportOutput>["execute"]>[1],
  ) {
    return this.listTool?.classifyExecution(context) ?? this.execution;
  }

  async execute(
    input: ExpenseReportInput,
    context: Parameters<ShivaSkill<ExpenseReportInput, ExpenseReportOutput>["execute"]>[1],
  ): ReturnType<ShivaSkill<ExpenseReportInput, ExpenseReportOutput>["execute"]> {
    if (!this.listTool) {
      return Promise.resolve({
        success: false,
        error: {
          code: "EXPENSE_SHEET_UNAVAILABLE",
          message: "The expense sheet is not configured.",
        },
      });
    }
    const expenses = await this.listTool.execute(
      {
        ...(input.from ? { from: new Date(input.from) } : {}),
        ...(input.until ? { until: new Date(input.until) } : {}),
      },
      context,
    );
    const detailLimit = input.limit ?? MAX_DETAIL_ROWS;
    return {
      success: true,
      data: {
        matchedCount: expenses.length,
        expenses: boundedDetails(expenses, detailLimit),
        totalsByCurrency: totalByCurrency(expenses),
      },
    };
  }
}

function boundedDetails(
  expenses: readonly ExpenseRecord[],
  requestedLimit: number,
): readonly ExpenseRecord[] {
  const selected: ExpenseRecord[] = [];
  // JSON array brackets are part of the context/audit payload too.
  let usedCharacters = 2;
  const rowLimit = Math.min(requestedLimit, MAX_DETAIL_ROWS);

  for (const expense of expenses) {
    if (selected.length >= rowLimit) break;
    const serialized = JSON.stringify(expense);
    if (!serialized) break;
    const nextSize =
      usedCharacters + serialized.length + (selected.length > 0 ? 1 : 0);
    if (nextSize > MAX_DETAIL_CHARACTERS) break;
    selected.push(expense);
    usedCharacters = nextSize;
  }
  return selected;
}

function totalByCurrency(
  expenses: readonly ExpenseRecord[],
): Readonly<Record<string, string>> {
  const totals = new Map<string, bigint>();
  for (const expense of expenses) {
    totals.set(
      expense.currency,
      (totals.get(expense.currency) ?? 0n) + decimalToMinor(expense.amount),
    );
  }
  return Object.fromEntries(
    [...totals].map(([currency, minor]) => [currency, minorToDecimal(minor)]),
  );
}

function decimalToMinor(value: string): bigint {
  const [whole = "0", fraction = ""] = value.split(".");
  return BigInt(whole) * 100n + BigInt(fraction.padEnd(2, "0").slice(0, 2));
}

function minorToDecimal(value: bigint): string {
  const whole = value / 100n;
  const fraction = String(value % 100n).padStart(2, "0");
  return `${whole}.${fraction}`;
}
