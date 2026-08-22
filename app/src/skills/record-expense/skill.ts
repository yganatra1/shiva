import { z } from "zod";

import type { ShivaSkill } from "../types.js";
import type { ExpenseInsertTool } from "../../tools/expenses/insert.js";
import type {
  RecordExpenseInput,
  RecordExpenseOutput,
} from "./types.js";

const amountSchema = z
  .number()
  .finite()
  .positive()
  .max(1_000_000_000_000)
  .refine((value) => Number.isInteger(value * 100), {
    message: "Amount must have at most two decimal places.",
  });
const timestampSchema = z.string().trim().datetime({ offset: true });
const recordInputSchema = z
  .object({
    amount: amountSchema,
    currency: z
      .string()
      .trim()
      .toUpperCase()
      .regex(/^[A-Z]{3}$/)
      .default("INR"),
    description: z.string().trim().min(1).max(500),
    category: z.string().trim().min(1).max(100).optional(),
    occurredAt: timestampSchema.optional(),
  })
  .strict();

export class RecordExpenseSkill
  implements ShivaSkill<RecordExpenseInput, RecordExpenseOutput>
{
  readonly name = "record_expense";
  readonly description =
    "Appends a personal expense to the configured expense sheet and verifies the stored row.";
  readonly inputDescription =
    '{ "amount": positive number, "currency"?: "INR", "description": string, "category"?: string, "occurredAt"?: RFC3339 }';
  readonly inputSchema: z.ZodType<RecordExpenseInput> = recordInputSchema;
  readonly pack = "finance";
  readonly execution = { mutability: "write", impact: "normal" } as const;
  readonly configured: boolean;

  constructor(private readonly insertTool?: ExpenseInsertTool) {
    this.configured = insertTool !== undefined;
  }

  async execute(
    input: RecordExpenseInput,
    context: Parameters<ShivaSkill<RecordExpenseInput, RecordExpenseOutput>["execute"]>[1],
  ): ReturnType<ShivaSkill<RecordExpenseInput, RecordExpenseOutput>["execute"]> {
    if (!this.insertTool) {
      return Promise.resolve({
        success: false,
        error: {
          code: "EXPENSE_SHEET_UNAVAILABLE",
          message: "The expense sheet is not configured.",
        },
      });
    }
    const expense = await this.insertTool.execute(
      {
        amount: input.amount.toFixed(2),
        currency: input.currency ?? "INR",
        description: input.description,
        category: input.category ?? null,
        occurredAt: input.occurredAt
          ? new Date(input.occurredAt)
          : context.now(),
      },
      context,
    );
    return {
      success: true,
      data: { expense },
    };
  }
}
