import assert from "node:assert/strict";
import { test } from "node:test";

import { AgentLoop } from "../src/agent/agent-loop.js";
import type {
  AgentDecision,
  AgentPlanner,
  AgentRequest,
} from "../src/agent/types.js";
import { ExecutionPolicyEngine } from "../src/security/policy-engine.js";
import {
  ExecutionStateService,
  InMemoryExecutionStateStore,
} from "../src/security/execution-state.js";
import { SkillExecutor } from "../src/skills/executor.js";
import { RecordExpenseSkill } from "../src/skills/record-expense/skill.js";
import { SkillRegistry } from "../src/skills/registry.js";
import { WebResearchSkill } from "../src/skills/web-research/skill.js";
import { ExpenseInsertTool } from "../src/tools/expenses/insert.js";
import type {
  ExpenseRecord,
  ExpenseRepositoryPort,
  InsertExpenseInput,
  ListExpensesInput,
} from "../src/tools/expenses/types.js";

class CrossSkillExpenseSheet implements ExpenseRepositoryPort {
  readonly rows: ExpenseRecord[] = [];

  async insertExpense(input: InsertExpenseInput): Promise<ExpenseRecord> {
    const created: ExpenseRecord = {
      expenseId: "sheet-expense-1",
      occurredAt: input.occurredAt,
      amount: input.amount,
      currency: input.currency,
      description: input.description,
      category: input.category,
      source: input.source,
    };
    this.rows.push(created);
    return created;
  }

  async listExpenses(input: ListExpensesInput): Promise<readonly ExpenseRecord[]> {
    input.signal?.throwIfAborted();
    return this.rows;
  }
}

test("agent chains web research into an authorized ordinary expense write before responding", async () => {
  const expenseSheet = new CrossSkillExpenseSheet();
  const registry = new SkillRegistry();
  registry.register(
    new WebResearchSkill(
      {
        async search() {
          return [
            {
              title: "GPU market",
              url: "https://example.com/gpu-pricing",
              description: "RTX 3090 rental pricing comparison.",
            },
          ];
        },
      },
      {
        async open(input) {
          return {
            url: input.url,
            title: "GPU market",
            content: "The cheapest current RTX 3090 rental is INR 45 per hour.",
          };
        },
      },
    ),
  );
  registry.register(
    new RecordExpenseSkill(new ExpenseInsertTool(expenseSheet)),
  );

  let step = 0;
  const planner: AgentPlanner = {
    async decide(context) {
      step += 1;
      if (step === 1) {
        return {
          type: "skill_call",
          skill: "web_research",
          selectedSkills: ["record_expense", "web_research"],
          arguments: { query: "latest RTX 3090 rental pricing in INR" },
          authorization: "user_authorized",
        };
      }
      if (step === 2) {
        const research = context.observations[0]?.result;
        assert.equal(research?.success, true);
        assert.match(JSON.stringify(research), /INR 45 per hour/);
        return {
          type: "skill_call",
          skill: "record_expense",
          selectedSkills: ["record_expense", "web_research"],
          arguments: {
            amount: 45,
            currency: "INR",
            description: "Shiva RTX 3090 hourly GPU cost",
            category: "Infrastructure",
          },
          authorization: "user_authorized",
        };
      }

      const expense = context.observations[1]?.result;
      assert.equal(expense?.success, true);
      return {
        type: "respond",
        message:
          "I found INR 45/hour as the cheapest cited price and recorded it as Shiva's GPU cost.",
      };
    },
  };
  const loop = new AgentLoop(
    planner,
    new SkillExecutor(registry, autoPolicy()),
    registry,
    8,
    () => new Date("2026-08-20T01:30:00Z"),
    () => "40000000-0000-4000-8000-000000000004",
  );
  const request: AgentRequest = {
    userMessage:
      "Research today's RTX 3090 rental pricing and record the cheapest price as a Shiva infrastructure expense.",
    conversationId: "10000000-0000-4000-8000-000000000001",
    userId: "20000000-0000-4000-8000-000000000002",
    userName: "Yash",
    timeZone: "Asia/Kolkata",
    contextMessages: [],
  };

  const result = await loop.run(request);

  assert.equal(result.steps, 3);
  assert.deepEqual(
    result.observations.map((observation) => observation.skill),
    ["web_research", "record_expense"],
  );
  assert.equal(expenseSheet.rows.length, 1);
  assert.equal(expenseSheet.rows[0]?.amount, "45.00");
  assert.equal(result.kind, "response");
  assert.match(result.response, /found.*recorded/i);
});

test("a planner cannot claim a failed sheet write was confirmed by the executor", async () => {
  const repository = new CrossSkillExpenseSheet();
  repository.insertExpense = async () => {
    throw new Error("private Google Sheets failure");
  };
  const registry = new SkillRegistry();
  registry.register(
    new RecordExpenseSkill(new ExpenseInsertTool(repository)),
  );
  const decisions: AgentDecision[] = [
    {
      type: "skill_call",
      skill: "record_expense",
      selectedSkills: ["record_expense"],
      arguments: { amount: 45, description: "GPU" },
      authorization: "user_authorized",
    },
    {
      type: "respond",
      message: "I could not record the expense because the sheet write failed.",
    },
  ];
  const planner: AgentPlanner = {
    async decide(context) {
      if (context.step === 2) {
        assert.deepEqual(context.observations[0]?.result, {
          success: false,
          error: {
            code: "SKILL_EXECUTION_FAILED",
            message: "The skill could not complete its operation.",
          },
        });
      }
      const decision = decisions.shift();
      if (!decision) throw new Error("Missing fake decision.");
      return decision;
    },
  };
  const loop = new AgentLoop(
    planner,
    new SkillExecutor(registry, autoPolicy()),
    registry,
  );

  const result = await loop.run({
    userMessage: "Record INR 45 for GPU.",
    conversationId: "10000000-0000-4000-8000-000000000001",
    userId: "20000000-0000-4000-8000-000000000002",
    userName: "Yash",
    timeZone: "Asia/Kolkata",
    contextMessages: [],
  });

  assert.equal(result.kind, "response");
  assert.match(result.response, /could not record/i);
  assert.equal(repository.rows.length, 0);
});

function autoPolicy(): ExecutionPolicyEngine {
  return new ExecutionPolicyEngine(
    new ExecutionStateService(
      new InMemoryExecutionStateStore({ executionMode: "AUTO" }),
      "FULL_ACCESS",
    ),
  );
}
