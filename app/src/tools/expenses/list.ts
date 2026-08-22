import type {
  SkillContext,
  SkillExecutionMetadata,
} from "../../skills/types.js";
import type { ExpenseRepositoryPort, ExpenseRecord } from "./types.js";

export interface ExpenseListToolInput {
  readonly from?: Date;
  readonly until?: Date;
}

export class ExpenseListTool {
  readonly name = "expense.list";

  constructor(private readonly repository: ExpenseRepositoryPort) {}

  async classifyExecution(
    context: SkillContext,
  ): Promise<SkillExecutionMetadata> {
    const requiresProvisioning =
      (await this.repository.listRequiresProvisioning?.(context.userId)) ??
      false;
    return {
      mutability: requiresProvisioning ? "write" : "read",
      impact: "normal",
    };
  }

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
