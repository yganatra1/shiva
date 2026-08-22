export interface ExpenseRecord {
  readonly expenseId: string;
  readonly occurredAt: Date;
  readonly amount: string;
  readonly currency: string;
  readonly description: string;
  readonly category: string | null;
  readonly source: string;
}

export interface InsertExpenseInput {
  /** Shiva user whose private expense ledger owns this row. */
  readonly userId: string;
  readonly amount: string;
  readonly currency: string;
  readonly description: string;
  readonly category: string | null;
  readonly occurredAt: Date;
  readonly source: string;
  readonly signal?: AbortSignal;
}

export interface ListExpensesInput {
  /** Shiva user whose private expense ledger is queried. */
  readonly userId: string;
  readonly from?: Date;
  readonly until?: Date;
  readonly signal?: AbortSignal;
}

/**
 * Data-source-neutral expense boundary. The current implementation is a private
 * Google Sheet; callers must not assume database-generated metadata exists.
 */
export interface ExpenseRepositoryPort {
  /** True when a list call must first create or upgrade provider resources. */
  listRequiresProvisioning?(userId: string): Promise<boolean>;
  insertExpense(input: InsertExpenseInput): Promise<ExpenseRecord>;
  listExpenses(input: ListExpensesInput): Promise<readonly ExpenseRecord[]>;
}
