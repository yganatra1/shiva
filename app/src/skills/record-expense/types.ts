import type { ExpenseRecord } from "../../tools/expenses/types";

export interface RecordExpenseInput {
  readonly amount: number;
  readonly currency?: string | undefined;
  readonly description: string;
  readonly category?: string | undefined;
  readonly occurredAt?: string | undefined;
}

export interface RecordExpenseOutput {
  readonly expense: ExpenseRecord;
}
