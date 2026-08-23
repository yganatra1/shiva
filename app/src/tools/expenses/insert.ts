import type { SkillContext } from "../../skills/types";
import type { ExpenseRepositoryPort, ExpenseRecord } from "./types";

export interface ExpenseInsertToolInput {
  readonly amount: string;
  readonly currency: string;
  readonly description: string;
  readonly category: string | null;
  readonly occurredAt: Date;
}

export class ExpenseInsertTool {
  readonly name = "expense.insert";

  constructor(private readonly repository: ExpenseRepositoryPort) {}

  execute(
    input: ExpenseInsertToolInput,
    context: SkillContext,
  ): Promise<ExpenseRecord> {
    return this.repository.insertExpense({
      userId: context.userId,
      amount: input.amount,
      currency: input.currency,
      description: input.description,
      category: input.category,
      occurredAt: input.occurredAt,
      source: "Shiva",
      ...(context.signal ? { signal: context.signal } : {}),
    });
  }
}
