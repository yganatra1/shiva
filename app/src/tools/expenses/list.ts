import type { SkillContext } from "../../skills/types.js";
import type { ExpenseRepositoryPort, ExpenseRecord } from "./types.js";

export interface ExpenseListToolInput {
  readonly from?: Date;
  readonly until?: Date;
}

export class ExpenseListTool {
  readonly name = "expense.list";

  constructor(private readonly repository: ExpenseRepositoryPort) {}

  execute(
    input: ExpenseListToolInput,
    context: SkillContext,
  ): Promise<readonly ExpenseRecord[]> {
    return this.repository.listExpenses({
      userId: context.userId,
      ...(input.from ? { from: input.from } : {}),
      ...(input.until ? { until: input.until } : {}),
      ...(context.signal ? { signal: context.signal } : {}),
    });
  }
}
