import type { AppConfig } from "../../config/environment";
import { GoogleCalendarClient } from "../../tools/calendar/client";
import { GoogleDriveClient } from "../../tools/drive/client";
import { GoogleUserOAuthAccessTokenProvider } from "../../tools/expenses/google-user-oauth";
import { GoogleGmailClient } from "../../tools/gmail/client";
import { GoogleSheetsClient } from "../../tools/sheets/client";
import type { SkillRegistry } from "../registry";
import { createCalendarCreateSkill } from "../calendar-create/skill";
import { createCalendarDeleteSkill } from "../calendar-delete/skill";
import { createCalendarReadSkill } from "../calendar-read/skill";
import { createCalendarUpdateSkill } from "../calendar-update/skill";
import { createDriveListSkill } from "../drive-list/skill";
import { createDriveReadSkill } from "../drive-read/skill";
import { createDriveSearchSkill } from "../drive-search/skill";
import { createGmailReadSkill } from "../gmail-read/skill";
import { createGmailReplySkill } from "../gmail-reply/skill";
import { createGmailSearchSkill } from "../gmail-search/skill";
import { createGmailSendSkill } from "../gmail-send/skill";
import { createSheetsAddTabSkill } from "../sheets-add-tab/skill";
import { createSheetsCreateSkill } from "../sheets-create/skill";
import { createSheetsFindSkill } from "../sheets-find/skill";
import { createSheetsReadSkill } from "../sheets-read/skill";
import { createSheetsUpdateSkill } from "../sheets-update/skill";

export function registerGoogleSkills(
  registry: SkillRegistry,
  config: Pick<
    AppConfig,
    "googleUserOAuth" | "expenseSheetRequestTimeoutMs"
  >,
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
  // Same OAuth token as sheets/drive; Gmail/Calendar just need their scopes
  // included in the underlying refresh token's original consent.
  const gmailClient = tokenProvider
    ? new GoogleGmailClient({
        accessTokenProvider: tokenProvider,
        requestTimeoutMs: config.expenseSheetRequestTimeoutMs,
      })
    : undefined;
  const calendarClient = tokenProvider
    ? new GoogleCalendarClient({
        accessTokenProvider: tokenProvider,
        requestTimeoutMs: config.expenseSheetRequestTimeoutMs,
      })
    : undefined;

  registry.register(createSheetsCreateSkill(sheetsClient));
  registry.register(createSheetsReadSkill(sheetsClient));
  registry.register(createSheetsUpdateSkill(sheetsClient));
  registry.register(createSheetsAddTabSkill(sheetsClient));
  registry.register(createSheetsFindSkill(driveClient));
  registry.register(createDriveSearchSkill(driveClient));
  registry.register(createDriveListSkill(driveClient));
  registry.register(createDriveReadSkill(driveClient));
  registry.register(createGmailSearchSkill(gmailClient));
  registry.register(createGmailReadSkill(gmailClient));
  registry.register(createGmailSendSkill(gmailClient));
  registry.register(createGmailReplySkill(gmailClient));
  registry.register(createCalendarReadSkill(calendarClient));
  registry.register(createCalendarCreateSkill(calendarClient));
  registry.register(createCalendarUpdateSkill(calendarClient));
  registry.register(createCalendarDeleteSkill(calendarClient));
}
