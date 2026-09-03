import assert from "node:assert/strict";
import { test } from "node:test";

import { ExecutionPolicyEngine } from "../src/security/policy-engine.js";
import {
  ExecutionStateService,
  InMemoryExecutionStateStore,
} from "../src/security/execution-state.js";
import { ExpenseReportSkill } from "../src/skills/expense-report/skill.js";
import { SkillExecutor } from "../src/skills/executor.js";
import { RecordExpenseSkill } from "../src/skills/record-expense/skill.js";
import { SkillRegistry } from "../src/skills/registry.js";
import type { SkillContext } from "../src/skills/types.js";
import { ExpenseInsertTool } from "../src/tools/expenses/insert.js";
import { ExpenseListTool } from "../src/tools/expenses/list.js";
import type {
  ExpenseRecord,
  ExpenseRepositoryPort,
  InsertExpenseInput,
  ListExpensesInput,
} from "../src/tools/expenses/types.js";

class InMemoryExpenseSheet implements ExpenseRepositoryPort {
  readonly rows: ExpenseRecord[] = [];
  failInsert = false;
  listCalls = 0;
  requiresProvisioning = false;
  private sequence = 1;

  async listRequiresProvisioning(): Promise<boolean> {
    return this.requiresProvisioning;
  }

  async insertExpense(input: InsertExpenseInput): Promise<ExpenseRecord> {
    if (this.failInsert) throw new Error("private Google Sheets failure");
    const expense: ExpenseRecord = {
      expenseId: `expense-${this.sequence++}`,
      amount: input.amount,
      currency: input.currency,
      description: input.description,
      category: input.category,
      occurredAt: input.occurredAt,
      source: input.source,
    };
    this.rows.push(expense);
    return expense;
  }

  async listExpenses(input: ListExpensesInput): Promise<readonly ExpenseRecord[]> {
    this.listCalls += 1;
    return this.rows
      .filter(
        (expense) =>
          (!input.from || expense.occurredAt >= input.from) &&
          (!input.until || expense.occurredAt < input.until),
      );
  }
}

const context: SkillContext = {
  agentRunId: "10000000-0000-4000-8000-000000000001",
  conversationId: "20000000-0000-4000-8000-000000000002",
  userId: "30000000-0000-4000-8000-000000000003",
  userName: "Yash",
  timeZone: "Asia/Kolkata",
  now: () => new Date("2026-08-20T00:30:00Z"),
};

test("record_expense appends to the sheet before reporting success", async () => {
  const sheet = new InMemoryExpenseSheet();
  const executor = expenseExecutor(sheet);

  const result = await executor.execute(
    "record_expense",
    { amount: 450, description: "Pizza", category: "Food" },
    context,
    { userAuthorized: true },
  );

  assert.equal(result.success, true);
  assert.deepEqual(sheet.rows, [
    {
      expenseId: "expense-1",
      amount: "450.00",
      currency: "INR",
      description: "Pizza",
      category: "Food",
      occurredAt: new Date("2026-08-20T00:30:00Z"),
      source: "Shiva",
    },
  ]);
  assert.deepEqual(result, { success: true, data: { expense: sheet.rows[0] } });
});

test("expense_report reads the sheet afresh and totals currencies exactly", async () => {
  const sheet = new InMemoryExpenseSheet();
  const executor = expenseExecutor(sheet);
  await executor.execute(
    "record_expense",
    { amount: 10.1, currency: "inr", description: "Coffee" },
    context,
    { userAuthorized: true },
  );
  await executor.execute(
    "record_expense",
    { amount: 20.25, description: "Lunch" },
    context,
    { userAuthorized: true },
  );

  const first = await executor.execute("expense_report", { limit: 1 }, context);
  assert.equal(first.success, true);
  if (!first.success) return;
  assert.equal((first.data as { matchedCount: number }).matchedCount, 2);
  assert.equal((first.data as { expenses: readonly unknown[] }).expenses.length, 1);
  assert.deepEqual(
    (first.data as { totalsByCurrency: Readonly<Record<string, string>> })
      .totalsByCurrency,
    { INR: "30.35" },
  );

  sheet.rows.push({
    expenseId: "outside-writer",
    occurredAt: new Date("2026-08-20T01:00:00Z"),
    amount: "5.00",
    currency: "USD",
    description: "External sheet row",
    category: null,
    source: "Manual",
  });
  const second = await executor.execute("expense_report", { limit: 10 }, context);
  assert.equal(second.success, true);
  assert.equal(sheet.listCalls, 2);
  if (!second.success) return;
  assert.deepEqual(
    (second.data as { totalsByCurrency: Readonly<Record<string, string>> })
      .totalsByCurrency,
    { INR: "30.35", USD: "5.00" },
  );
});

test("expense_report totals every matching row but returns no more than 25 details", async () => {
  const sheet = new InMemoryExpenseSheet();
  for (let index = 0; index < 40; index += 1) {
    sheet.rows.push({
      expenseId: `bulk-${index}`,
      occurredAt: new Date(`2026-08-20T00:${String(index).padStart(2, "0")}:00Z`),
      amount: index % 2 === 0 ? "1.01" : "0.02",
      currency: index % 2 === 0 ? "INR" : "USD",
      description: `Expense ${index}`,
      category: null,
      source: "Manual",
    });
  }
  const executor = expenseExecutor(sheet);

  const result = await executor.execute("expense_report", {}, context);

  assert.equal(result.success, true);
  if (!result.success) return;
  const report = result.data as {
    matchedCount: number;
    expenses: readonly ExpenseRecord[];
    totalsByCurrency: Readonly<Record<string, string>>;
  };
  assert.equal(report.matchedCount, 40);
  assert.equal(report.expenses.length, 25);
  assert.deepEqual(report.totalsByCurrency, {
    INR: "20.20",
    USD: "0.40",
  });
});

test("expense_report keeps detail JSON within its character budget without truncating totals", async () => {
  const sheet = new InMemoryExpenseSheet();
  for (let index = 0; index < 25; index += 1) {
    sheet.rows.push({
      expenseId: `large-${index}-${"x".repeat(150)}`,
      occurredAt: new Date("2026-08-20T00:00:00Z"),
      amount: "123.45",
      currency: "INR",
      description: `Expense ${index} ${"d".repeat(475)}`,
      category: "c".repeat(100),
      source: "s".repeat(100),
    });
  }
  const executor = expenseExecutor(sheet);

  const result = await executor.execute(
    "expense_report",
    { limit: 25 },
    context,
  );

  assert.equal(result.success, true);
  if (!result.success) return;
  const report = result.data as {
    matchedCount: number;
    expenses: readonly ExpenseRecord[];
    totalsByCurrency: Readonly<Record<string, string>>;
  };
  assert.equal(report.matchedCount, 25);
  assert.ok(report.expenses.length > 0);
  assert.ok(report.expenses.length < 25);
  assert.ok(JSON.stringify(report.expenses).length <= 8_000);
  assert.deepEqual(report.totalsByCurrency, { INR: "3086.25" });
});

test("expense_report classifies first-use provisioning as a write and a ready ledger as a read", async () => {
  const sheet = new InMemoryExpenseSheet();
  const registry = new SkillRegistry();
  registry.register(new ExpenseReportSkill(new ExpenseListTool(sheet)));
  const state = new ExecutionStateService(
    new InMemoryExecutionStateStore({
      executionMode: "SAFE",
      lockdown: false,
      revision: 0,
      updatedAt: context.now(),
      updatedBy: null,
    }),
    "FULL_ACCESS",
  );
  const executor = new SkillExecutor(registry, new ExecutionPolicyEngine(state));

  const readyRead = await executor.execute(
    "expense_report",
    {},
    context,
    { userAuthorized: true },
  );
  assert.equal(readyRead.success, true);
  assert.equal(sheet.listCalls, 1);

  sheet.requiresProvisioning = true;
  const firstUse = await executor.execute(
    "expense_report",
    {},
    context,
    { userAuthorized: true },
  );
  assert.equal(firstUse.success, false);
  if (!firstUse.success) {
    assert.equal(firstUse.error.code, "CONFIRMATION_REQUIRED");
    assert.match(firstUse.error.message, /Safe mode/i);
  }
  assert.equal(sheet.listCalls, 1);
});

function expenseExecutor(repository: ExpenseRepositoryPort): SkillExecutor {
  const registry = new SkillRegistry();
  registry.register(new RecordExpenseSkill(new ExpenseInsertTool(repository)));
  registry.register(new ExpenseReportSkill(new ExpenseListTool(repository)));
  return new SkillExecutor(registry, new ExecutionPolicyEngine());
}
