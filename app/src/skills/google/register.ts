import type { AppConfig } from "../../config/environment.js";
import { GoogleDriveClient } from "../../tools/drive/client.js";
import { GoogleUserOAuthAccessTokenProvider } from "../../tools/expenses/google-user-oauth.js";
import { GoogleSheetsClient } from "../../tools/sheets/client.js";
import type { SkillRegistry } from "../registry.js";
import { createSheetsAddTabSkill } from "../sheets-add-tab/skill.js";
import { createSheetsCreateSkill } from "../sheets-create/skill.js";
import { createSheetsFindSkill } from "../sheets-find/skill.js";
import { createSheetsReadSkill } from "../sheets-read/skill.js";
import { createSheetsUpdateSkill } from "../sheets-update/skill.js";

export function registerGoogleSkills(
  registry: SkillRegistry,
  config: AppConfig,
): void {
  const tokenProvider = config.googleUserOAuth
    ? new GoogleUserOAuthAccessTokenProvider(config.googleUserOAuth)
    : undefined;
  const sheetsClient = tokenProvider
    ? new GoogleSheetsClient({
        accessTokenProvider: tokenProvider,
        // Shared with the expense-sheet adapter; both are Google Sheets calls.
        requestTimeoutMs: config.expenseSheetRequestTimeoutMs,
      })
    : undefined;
  // Uses the same OAuth token as sheetsClient. Finding a sheet by name needs
  // Drive scope (e.g. drive or drive.readonly) in addition to spreadsheets;
  // if the refresh token predates that grant, sheets_find will fail closed
  // with an auth error rather than silently doing nothing.
  const driveClient = tokenProvider
    ? new GoogleDriveClient({
        accessTokenProvider: tokenProvider,
        requestTimeoutMs: config.expenseSheetRequestTimeoutMs,
      })
    : undefined;

  registry.register(createSheetsCreateSkill(sheetsClient));
  registry.register(createSheetsReadSkill(sheetsClient));
  registry.register(createSheetsUpdateSkill(sheetsClient));
  registry.register(createSheetsAddTabSkill(sheetsClient));
  registry.register(createSheetsFindSkill(driveClient));
}
