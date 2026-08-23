import type { ExpenseRecord } from "../../tools/expenses/types";

export interface ExpenseReportInput {
  readonly from?: string | undefined;
  readonly until?: string | undefined;
  readonly limit?: number | undefined;
}

export interface ExpenseReportOutput {
  readonly matchedCount: number;
  readonly expenses: readonly ExpenseRecord[];
  readonly totalsByCurrency: Readonly<Record<string, string>>;
}
