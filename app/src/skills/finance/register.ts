import type { AppConfig } from "../../config/environment.js";
import type { ShivaDatabase } from "../../database/pool.js";
import { ExpenseInsertTool } from "../../tools/expenses/insert.js";
import { ExpenseListTool } from "../../tools/expenses/list.js";
import { GoogleAuthAccessTokenProvider } from "../../tools/expenses/google-sheets.js";
import { ManagedGoogleSheetsExpenseRepository } from "../../tools/expenses/google-sheets-manager.js";
import { GoogleUserOAuthAccessTokenProvider } from "../../tools/expenses/google-user-oauth.js";
import { DrizzleExpenseSheetBindingStore } from "../../tools/expenses/sheet-binding-repository.js";
import { ExpenseReportSkill } from "../expense-report/skill.js";
import { RecordExpenseSkill } from "../record-expense/skill.js";
import type { SkillRegistry } from "../registry.js";

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
