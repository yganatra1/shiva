import type { AppConfig } from "../../config/environment";
import type { ShivaDatabase } from "../../database/pool";
import { ExpenseInsertTool } from "../../tools/expenses/insert";
import { ExpenseListTool } from "../../tools/expenses/list";
import { GoogleAuthAccessTokenProvider } from "../../tools/expenses/google-sheets";
import { ManagedGoogleSheetsExpenseRepository } from "../../tools/expenses/google-sheets-manager";
import { GoogleUserOAuthAccessTokenProvider } from "../../tools/expenses/google-user-oauth";
import { DrizzleExpenseSheetBindingStore } from "../../tools/expenses/sheet-binding-repository";
import { ExpenseReportSkill } from "../expense-report/skill";
import { RecordExpenseSkill } from "../record-expense/skill";
import type { SkillRegistry } from "../registry";

export function registerFinanceSkills(
  registry: SkillRegistry,
  config: AppConfig,
  database: ShivaDatabase,
): void {
  if (config.googleUserOAuth || config.expenseSheetId) {
    const accessTokenProvider = config.googleUserOAuth
      ? new GoogleUserOAuthAccessTokenProvider(config.googleUserOAuth)
      : new GoogleAuthAccessTokenProvider();
    const expenses = new ManagedGoogleSheetsExpenseRepository({
      bindingStore: new DrizzleExpenseSheetBindingStore(database),
      accessTokenProvider,
      requestTimeoutMs: config.expenseSheetRequestTimeoutMs,
      ...(config.expenseSheetId
        ? { bootstrapSpreadsheetId: config.expenseSheetId }
        : {}),
    });
    registry.register(new RecordExpenseSkill(new ExpenseInsertTool(expenses)));
    registry.register(new ExpenseReportSkill(new ExpenseListTool(expenses)));
  } else {
    registry.register(new RecordExpenseSkill());
    registry.register(new ExpenseReportSkill());
  }
}
