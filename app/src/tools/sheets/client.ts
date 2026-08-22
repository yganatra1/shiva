import {
  readBoundedGoogleSheetsJson,
  type GoogleAccessTokenProvider,
} from "../expenses/google-sheets.js";

export type { GoogleAccessTokenProvider } from "../expenses/google-sheets.js";

export type CellValue = string | number | boolean | null;

export type SheetsClientFailure =
  | "INVALID_INPUT"
  | "AUTH"
  | "UNAVAILABLE"
  | "TIMEOUT"
  | "CANCELLED"
  | "INVALID_RESPONSE";

export class SheetsClientError extends Error {
  override readonly name = "SheetsClientError";

  constructor(
    readonly failure: SheetsClientFailure,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
  }
}

/**
 * One tab's worth of structure for spreadsheet creation. Only `name` is
 * required — the rest is deliberately optional so a caller struggling to
 * produce the full nested shape in one attempt can create a bare, reliably
 * correct tab first and populate it with a separate writeValues() call
 * afterward, rather than needing every field right on the first try.
 */
export interface TabDefinition {
  readonly name: string;
  readonly headers?: readonly string[];
  readonly rows?: readonly (readonly CellValue[])[];
  /** Header text -> allowed values. Adds an enforced dropdown to that column. Requires headers. */
  readonly columnOptions?: Readonly<Record<string, readonly string[]>>;
}

export interface CreateSpreadsheetInput {
  readonly title: string;
  readonly tabs: readonly TabDefinition[];
  readonly signal?: AbortSignal;
}

export interface CreatedTab {
  readonly name: string;
  readonly sheetId: number;
}

export interface CreatedSpreadsheet {
  readonly spreadsheetId: string;
  readonly url: string;
  readonly tabs: readonly CreatedTab[];
}

export interface AddTabInput {
  readonly spreadsheetId: string;
  readonly name: string;
  readonly headers?: readonly string[];
  readonly rows?: readonly (readonly CellValue[])[];
  readonly columnOptions?: Readonly<Record<string, readonly string[]>>;
  readonly signal?: AbortSignal;
}

export interface ReadValuesInput {
  readonly spreadsheetId: string;
  readonly range: string;
  readonly signal?: AbortSignal;
}

export interface ReadValuesResult {
  readonly range: string;
  readonly values: readonly (readonly CellValue[])[];
}

export interface ListTabsInput {
  readonly spreadsheetId: string;
  readonly signal?: AbortSignal;
}

export interface ListTabsResult {
  readonly tabs: readonly CreatedTab[];
}

export interface WriteValuesInput {
  readonly spreadsheetId: string;
  readonly range: string;
  readonly values: readonly (readonly CellValue[])[];
  readonly mode: "update" | "append";
  readonly signal?: AbortSignal;
}

export interface WriteValuesResult {
  readonly updatedRange: string;
  readonly updatedRows: number;
  readonly updatedColumns: number;
}

export interface GoogleSheetsClientOptions {
  readonly accessTokenProvider: GoogleAccessTokenProvider;
  readonly requestTimeoutMs: number;
  readonly apiBaseUrl?: string;
  readonly fetchFunction?: typeof fetch;
}

const DEFAULT_API_BASE_URL = "https://sheets.googleapis.com";
export const SHEETS_MAX_TITLE_LENGTH = 200;
export const SHEETS_MAX_HEADERS = 50;
export const SHEETS_MAX_TABS = 20;
export const SHEETS_MAX_ROWS_PER_CALL = 500;
export const SHEETS_MAX_CELL_LENGTH = 5_000;
export const SHEETS_MAX_OPTION_VALUES = 100;
const VALIDATION_ROW_COUNT = 1_000;
const GOOGLE_RESOURCE_ID = /^[A-Za-z0-9_-]{5,256}$/;

const HEADER_TEXT_FORMAT = {
  bold: true,
  foregroundColor: { red: 1, green: 1, blue: 1 },
};
const HEADER_BACKGROUND_COLOR = { red: 0.204, green: 0.286, blue: 0.369 };

/**
 * Generic Google Sheets adapter: create a new (possibly multi-tab)
 * spreadsheet from an arbitrary header/row/dropdown shape with tasteful
 * default formatting, add tabs to an existing one later, and read/write
 * arbitrary ranges. Unlike the expense-ledger adapter, this makes no
 * assumption about column meaning — structure is decided by the caller (the
 * planner), not hard-coded here.
 */
export class GoogleSheetsClient {
  private readonly apiBaseUrl: URL;
  private readonly fetchFunction: typeof fetch;

  constructor(private readonly options: GoogleSheetsClientOptions) {
    this.apiBaseUrl = new URL(options.apiBaseUrl ?? DEFAULT_API_BASE_URL);
    this.fetchFunction = options.fetchFunction ?? fetch;
    if (
      !Number.isFinite(options.requestTimeoutMs) ||
      options.requestTimeoutMs <= 0
    ) {
      throw new RangeError("Google Sheets requestTimeoutMs must be positive.");
    }
  }

  async createSpreadsheet(
    input: CreateSpreadsheetInput,
  ): Promise<CreatedSpreadsheet> {
    validateTabs(input.tabs);
    if (input.title.trim().length === 0 || input.title.length > SHEETS_MAX_TITLE_LENGTH) {
      throw new SheetsClientError(
        "INVALID_INPUT",
        "The spreadsheet title must be non-empty and within bounds.",
      );
    }
    return this.withDeadline(input.signal, async (signal) => {
      const token = await this.getAccessToken(signal);
      const payload = await this.requestJson(
        new URL("/v4/spreadsheets", this.apiBaseUrl),
        token,
        signal,
        {
          method: "POST",
          body: JSON.stringify({
            properties: { title: input.title },
            sheets: input.tabs.map((tab, index) => tabToSheetPayload(tab, index)),
          }),
        },
      );
      const created = readCreatedSpreadsheet(
        payload,
        input.tabs.map((tab) => tab.name),
      );
      await this.applyColumnValidations(
        created.spreadsheetId,
        created.tabs,
        input.tabs,
        token,
        signal,
      );
      return created;
    });
  }

  async addTab(input: AddTabInput): Promise<CreatedTab> {
    validateSpreadsheetId(input.spreadsheetId);
    validateTabs([
      {
        name: input.name,
        ...(input.headers ? { headers: input.headers } : {}),
        ...(input.rows ? { rows: input.rows } : {}),
        ...(input.columnOptions ? { columnOptions: input.columnOptions } : {}),
      },
    ]);
    return this.withDeadline(input.signal, async (signal) => {
      const token = await this.getAccessToken(signal);
      const payload = await this.requestJson(
        this.batchUpdateUrl(input.spreadsheetId),
        token,
        signal,
        {
          method: "POST",
          body: JSON.stringify({
            requests: [
              {
                addSheet: {
                  properties: {
                    title: input.name,
                    gridProperties: { frozenRowCount: input.headers ? 1 : 0 },
                  },
                },
              },
            ],
          }),
        },
      );
      const tab = readAddedTab(payload, input.name);

      const initialRows = [
        ...(input.headers ? [input.headers] : []),
        ...(input.rows ?? []),
      ];
      if (initialRows.length > 0) {
        const headerUrl = this.valuesUrl(input.spreadsheetId, `'${input.name}'!A1`);
        headerUrl.searchParams.set("valueInputOption", "USER_ENTERED");
        await this.requestJson(headerUrl, token, signal, {
          method: "PUT",
          body: JSON.stringify({ majorDimension: "ROWS", values: initialRows }),
        });
      }

      await this.applyColumnValidations(
        input.spreadsheetId,
        [tab],
        [
          {
            name: input.name,
            ...(input.headers ? { headers: input.headers } : {}),
            ...(input.columnOptions ? { columnOptions: input.columnOptions } : {}),
          },
        ],
        token,
        signal,
      );
      return tab;
    });
  }

  async getValues(input: ReadValuesInput): Promise<ReadValuesResult> {
    validateSpreadsheetId(input.spreadsheetId);
    validateRange(input.range);
    return this.withDeadline(input.signal, async (signal) => {
      const token = await this.getAccessToken(signal);
      const url = this.valuesUrl(input.spreadsheetId, input.range);
      url.searchParams.set("majorDimension", "ROWS");
      url.searchParams.set("valueRenderOption", "UNFORMATTED_VALUE");
      url.searchParams.set("dateTimeRenderOption", "FORMATTED_STRING");
      const payload = await this.requestJson(url, token, signal);
      return {
        range: readStringField(payload, "range") ?? input.range,
        values: readValues(payload),
      };
    });
  }

  async listTabs(input: ListTabsInput): Promise<ListTabsResult> {
    validateSpreadsheetId(input.spreadsheetId);
    return this.withDeadline(input.signal, async (signal) => {
      const token = await this.getAccessToken(signal);
      const url = new URL(
        `/v4/spreadsheets/${encodeURIComponent(input.spreadsheetId)}`,
        this.apiBaseUrl,
      );
      url.searchParams.set("fields", "sheets.properties(sheetId,title)");
      const payload = await this.requestJson(url, token, signal);
      return { tabs: readSpreadsheetTabs(payload) };
    });
  }

  async writeValues(input: WriteValuesInput): Promise<WriteValuesResult> {
    validateSpreadsheetId(input.spreadsheetId);
    validateRange(input.range);
    validateValues(input.values);
    return this.withDeadline(input.signal, async (signal) => {
      const token = await this.getAccessToken(signal);
      const rawValues = input.values.map((row) => row.map(rawCellValue));
      let payload: unknown;
      if (input.mode === "append") {
        const url = this.valuesUrl(input.spreadsheetId, input.range, ":append");
        url.searchParams.set("valueInputOption", "USER_ENTERED");
        url.searchParams.set("insertDataOption", "INSERT_ROWS");
        payload = await this.requestJson(url, token, signal, {
          method: "POST",
          body: JSON.stringify({ majorDimension: "ROWS", values: rawValues }),
        });
        return readAppendResult(payload);
      }
      const url = this.valuesUrl(input.spreadsheetId, input.range);
      url.searchParams.set("valueInputOption", "USER_ENTERED");
      payload = await this.requestJson(url, token, signal, {
        method: "PUT",
        body: JSON.stringify({ majorDimension: "ROWS", values: rawValues }),
      });
      return readUpdateResult(payload);
    });
  }

  private async applyColumnValidations(
    spreadsheetId: string,
    createdTabs: readonly CreatedTab[],
    tabs: readonly TabDefinition[],
    token: string,
    signal: AbortSignal,
  ): Promise<void> {
    const requests = tabs.flatMap((tab) => {
      const options = tab.columnOptions;
      if (!options) return [];
      const sheetId = createdTabs.find((created) => created.name === tab.name)
        ?.sheetId;
      if (sheetId === undefined) return [];
      return Object.entries(options).flatMap(([header, values]) => {
        const columnIndex = tab.headers?.indexOf(header) ?? -1;
        // Guarded here defensively; validateTabs already rejects this
        // combination, but a dropdown on a column that doesn't exist would
        // otherwise silently corrupt an unrelated column instead of erroring.
        if (columnIndex < 0) return [];
        return {
          setDataValidation: {
            range: {
              sheetId,
              startRowIndex: 1,
              endRowIndex: VALIDATION_ROW_COUNT,
              startColumnIndex: columnIndex,
              endColumnIndex: columnIndex + 1,
            },
            rule: {
              condition: {
                type: "ONE_OF_LIST",
                values: values.map((value) => ({ userEnteredValue: value })),
              },
              showCustomUi: true,
              strict: true,
            },
          },
        };
      });
    });
    if (requests.length === 0) return;
    await this.requestJson(this.batchUpdateUrl(spreadsheetId), token, signal, {
      method: "POST",
      body: JSON.stringify({ requests }),
    });
  }

  private batchUpdateUrl(spreadsheetId: string): URL {
    return new URL(
      `/v4/spreadsheets/${encodeURIComponent(spreadsheetId)}:batchUpdate`,
      this.apiBaseUrl,
    );
  }

  private valuesUrl(spreadsheetId: string, range: string, suffix = ""): URL {
    return new URL(
      `/v4/spreadsheets/${encodeURIComponent(spreadsheetId)}/values/${encodeURIComponent(range)}${suffix}`,
      this.apiBaseUrl,
    );
  }

  private async getAccessToken(signal: AbortSignal): Promise<string> {
    try {
      const token = await this.options.accessTokenProvider.getAccessToken(signal);
      if (!token || token.trim().length === 0) {
        throw new SheetsClientError(
          "AUTH",
          "Google authentication did not return an access token.",
        );
      }
      return token;
    } catch (error: unknown) {
      if (error instanceof SheetsClientError) throw error;
      signal.throwIfAborted();
      throw new SheetsClientError("AUTH", "Google Sheets authentication failed.");
    }
  }

  private async requestJson(
    url: URL,
    token: string,
    signal: AbortSignal,
    init: Pick<RequestInit, "method" | "body"> = {},
  ): Promise<unknown> {
    const response = await this.fetchFunction(url, {
      ...init,
      method: init.method ?? "GET",
      headers: {
        accept: "application/json",
        authorization: `Bearer ${token}`,
        ...(init.body ? { "content-type": "application/json" } : {}),
      },
      signal,
    });
    if (!response.ok) {
      await discardBody(response);
      if (response.status === 401 || response.status === 403) {
        throw new SheetsClientError(
          "AUTH",
          "Google Sheets rejected the configured credentials.",
        );
      }
      if (response.status === 400 || response.status === 404) {
        throw new SheetsClientError(
          "INVALID_INPUT",
          "The requested spreadsheet or A1 range was invalid or not found.",
        );
      }
      throw new SheetsClientError(
        "UNAVAILABLE",
        `Google Sheets returned HTTP status ${response.status}.`,
      );
    }
    try {
      return await readBoundedGoogleSheetsJson(response, signal);
    } catch (error: unknown) {
      throw new SheetsClientError(
        "INVALID_RESPONSE",
        "Google Sheets returned an unreadable response.",
        { cause: error },
      );
    }
  }

  private async withDeadline<T>(
    callerSignal: AbortSignal | undefined,
    operation: (signal: AbortSignal) => Promise<T>,
  ): Promise<T> {
    const deadline = new AbortController();
    const signal = callerSignal
      ? AbortSignal.any([callerSignal, deadline.signal])
      : deadline.signal;
    const timeout = setTimeout(
      () => deadline.abort(new Error("Google Sheets deadline exceeded.")),
      this.options.requestTimeoutMs,
    );
    timeout.unref();

    try {
      return await operation(signal);
    } catch (error: unknown) {
      if (error instanceof SheetsClientError) throw error;
      if (callerSignal?.aborted) {
        throw new SheetsClientError(
          "CANCELLED",
          "The Google Sheets operation was cancelled.",
          { cause: error },
        );
      }
      if (deadline.signal.aborted) {
        throw new SheetsClientError(
          "TIMEOUT",
          `Google Sheets did not respond within ${this.options.requestTimeoutMs}ms.`,
          { cause: error },
        );
      }
      throw new SheetsClientError(
        "UNAVAILABLE",
        "The Google Sheets operation could not be completed.",
        { cause: error },
      );
    } finally {
      clearTimeout(timeout);
    }
  }
}

/** Maps a thrown SheetsClientError to a skill failure code/message; rethrows anything else. */
export function sheetsErrorToFailure(
  error: unknown,
): { readonly code: string; readonly message: string } {
  if (!(error instanceof SheetsClientError)) throw error;
  switch (error.failure) {
    case "INVALID_INPUT":
      return { code: "SHEETS_INVALID_INPUT", message: error.message };
    case "AUTH":
      return {
        code: "SHEETS_AUTH_FAILED",
        message: "Google Sheets authentication failed.",
      };
    case "TIMEOUT":
      return {
        code: "SHEETS_TIMEOUT",
        message: "Google Sheets did not respond in time.",
      };
    case "INVALID_RESPONSE":
      return {
        code: "SHEETS_INVALID_RESPONSE",
        message: "Google Sheets returned an unexpected response.",
      };
    default:
      return {
        code: "SHEETS_UNAVAILABLE",
        message: "Google Sheets could not complete the request.",
      };
  }
}

function tabToSheetPayload(tab: TabDefinition, index: number): unknown {
  const headerRow = tab.headers
    ? {
        values: tab.headers.map((header) => ({
          userEnteredValue: { stringValue: header },
          userEnteredFormat: {
            textFormat: HEADER_TEXT_FORMAT,
            backgroundColor: HEADER_BACKGROUND_COLOR,
          },
        })),
      }
    : undefined;
  const dataRows = (tab.rows ?? []).map((row) => ({
    values: row.map((cell) => ({ userEnteredValue: userEnteredValue(cell) })),
  }));
  const columnMetadata = tab.headers?.map((header) => ({
    pixelSize: columnWidthFor(header),
  }));
  return {
    properties: {
      title: tab.name,
      index,
      // A bare tab with no header row yet has nothing useful to freeze.
      gridProperties: { frozenRowCount: headerRow ? 1 : 0 },
    },
    data: [
      {
        startRow: 0,
        startColumn: 0,
        rowData: headerRow ? [headerRow, ...dataRows] : dataRows,
        ...(columnMetadata ? { columnMetadata } : {}),
      },
    ],
  };
}

function columnWidthFor(header: string): number {
  return Math.max(100, Math.min(320, header.length * 9 + 60));
}

function userEnteredValue(cell: CellValue): Record<string, unknown> {
  if (cell === null) return {};
  if (typeof cell === "number") return { numberValue: cell };
  if (typeof cell === "boolean") return { boolValue: cell };
  return { stringValue: cell };
}

function rawCellValue(cell: CellValue): string | number | boolean {
  return cell === null ? "" : cell;
}

function validateTabs(tabs: readonly TabDefinition[]): void {
  if (tabs.length === 0 || tabs.length > SHEETS_MAX_TABS) {
    throw new SheetsClientError(
      "INVALID_INPUT",
      `A spreadsheet must declare 1-${SHEETS_MAX_TABS} tabs.`,
    );
  }
  if (
    new Set(tabs.map((tab) => tab.name.trim().toLowerCase())).size !== tabs.length
  ) {
    throw new SheetsClientError("INVALID_INPUT", "Tab names must be unique.");
  }
  for (const tab of tabs) {
    if (tab.name.trim().length === 0 || tab.name.length > SHEETS_MAX_TITLE_LENGTH) {
      throw new SheetsClientError(
        "INVALID_INPUT",
        "Each tab's name must be non-empty and within bounds.",
      );
    }
    if (
      tab.headers &&
      (tab.headers.length === 0 ||
        tab.headers.length > SHEETS_MAX_HEADERS ||
        tab.headers.some((header) => header.trim().length === 0) ||
        new Set(tab.headers.map((header) => header.trim().toLowerCase())).size !==
          tab.headers.length)
    ) {
      throw new SheetsClientError(
        "INVALID_INPUT",
        "When given, a tab's headers must be non-empty, unique, and within bounds.",
      );
    }
    if (tab.rows) {
      validateValues(tab.rows);
      if (tab.headers && tab.rows.some((row) => row.length > tab.headers!.length)) {
        throw new SheetsClientError(
          "INVALID_INPUT",
          "A data row had more cells than declared headers.",
        );
      }
    }
    if (tab.columnOptions) {
      for (const [header, values] of Object.entries(tab.columnOptions)) {
        if (!tab.headers?.includes(header)) {
          throw new SheetsClientError(
            "INVALID_INPUT",
            `columnOptions referenced header '${header}', which is not in this tab's headers.`,
          );
        }
        if (values.length === 0 || values.length > SHEETS_MAX_OPTION_VALUES) {
          throw new SheetsClientError(
            "INVALID_INPUT",
            `columnOptions for '${header}' must declare 1-${SHEETS_MAX_OPTION_VALUES} values.`,
          );
        }
      }
    }
  }
}

function validateValues(values: readonly (readonly CellValue[])[]): void {
  if (values.length === 0 || values.length > SHEETS_MAX_ROWS_PER_CALL) {
    throw new SheetsClientError(
      "INVALID_INPUT",
      `Values must contain 1-${SHEETS_MAX_ROWS_PER_CALL} rows.`,
    );
  }
  for (const row of values) {
    for (const cell of row) {
      if (typeof cell === "string" && cell.length > SHEETS_MAX_CELL_LENGTH) {
        throw new SheetsClientError(
          "INVALID_INPUT",
          `A cell exceeded the ${SHEETS_MAX_CELL_LENGTH}-character limit.`,
        );
      }
    }
  }
}

function validateSpreadsheetId(spreadsheetId: string): void {
  if (!GOOGLE_RESOURCE_ID.test(spreadsheetId)) {
    throw new SheetsClientError(
      "INVALID_INPUT",
      "spreadsheetId is not a valid Google resource ID.",
    );
  }
}

function validateRange(range: string): void {
  if (range.trim().length === 0 || range.length > 300) {
    throw new SheetsClientError("INVALID_INPUT", "range must be a non-empty A1 notation string.");
  }
}

function readCreatedSpreadsheet(
  payload: unknown,
  tabNames: readonly string[],
): CreatedSpreadsheet {
  if (
    !isRecord(payload) ||
    typeof payload.spreadsheetId !== "string" ||
    !GOOGLE_RESOURCE_ID.test(payload.spreadsheetId)
  ) {
    throw new SheetsClientError(
      "INVALID_RESPONSE",
      "Google Sheets create did not return a spreadsheet ID.",
    );
  }
  const sheets: unknown = payload.sheets;
  if (!Array.isArray(sheets)) {
    throw new SheetsClientError(
      "INVALID_RESPONSE",
      "Google Sheets create did not return sheet metadata.",
    );
  }
  const tabs = tabNames.map((name) => {
    const sheet = sheets.find(
      (candidate) =>
        isRecord(candidate) &&
        isRecord(candidate.properties) &&
        candidate.properties.title === name,
    );
    if (
      !isRecord(sheet) ||
      !isRecord(sheet.properties) ||
      typeof sheet.properties.sheetId !== "number"
    ) {
      throw new SheetsClientError(
        "INVALID_RESPONSE",
        `Google Sheets create did not return the '${name}' tab.`,
      );
    }
    return { name, sheetId: sheet.properties.sheetId };
  });
  const url =
    typeof payload.spreadsheetUrl === "string" && payload.spreadsheetUrl.length > 0
      ? payload.spreadsheetUrl
      : `https://docs.google.com/spreadsheets/d/${payload.spreadsheetId}`;
  return { spreadsheetId: payload.spreadsheetId, url, tabs };
}

function readAddedTab(payload: unknown, name: string): CreatedTab {
  if (!isRecord(payload) || !Array.isArray(payload.replies)) {
    throw new SheetsClientError(
      "INVALID_RESPONSE",
      "Google Sheets did not confirm creation of the new tab.",
    );
  }
  const reply = payload.replies[0];
  if (
    !isRecord(reply) ||
    !isRecord(reply.addSheet) ||
    !isRecord(reply.addSheet.properties) ||
    typeof reply.addSheet.properties.sheetId !== "number"
  ) {
    throw new SheetsClientError(
      "INVALID_RESPONSE",
      "Google Sheets did not confirm creation of the new tab.",
    );
  }
  return { name, sheetId: reply.addSheet.properties.sheetId };
}

function readSpreadsheetTabs(payload: unknown): readonly CreatedTab[] {
  if (
    !isRecord(payload) ||
    !Array.isArray(payload.sheets) ||
    payload.sheets.length === 0
  ) {
    throw new SheetsClientError(
      "INVALID_RESPONSE",
      "Google Sheets did not return spreadsheet tab metadata.",
    );
  }
  return payload.sheets.map((sheet) => {
    if (
      !isRecord(sheet) ||
      !isRecord(sheet.properties) ||
      typeof sheet.properties.title !== "string" ||
      sheet.properties.title.trim().length === 0 ||
      typeof sheet.properties.sheetId !== "number" ||
      !Number.isInteger(sheet.properties.sheetId)
    ) {
      throw new SheetsClientError(
        "INVALID_RESPONSE",
        "Google Sheets returned invalid spreadsheet tab metadata.",
      );
    }
    return {
      name: sheet.properties.title,
      sheetId: sheet.properties.sheetId,
    };
  });
}

function readValues(payload: unknown): readonly (readonly CellValue[])[] {
  if (!isRecord(payload)) {
    throw new SheetsClientError(
      "INVALID_RESPONSE",
      "Google Sheets returned an invalid values response.",
    );
  }
  if (payload.values === undefined) return [];
  if (!Array.isArray(payload.values) || !payload.values.every(Array.isArray)) {
    throw new SheetsClientError(
      "INVALID_RESPONSE",
      "Google Sheets returned an invalid row shape.",
    );
  }
  return payload.values.map((row: unknown[]) =>
    row.map((cell) => normalizeCell(cell)),
  );
}

function normalizeCell(value: unknown): CellValue {
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean"
  ) {
    return value;
  }
  return String(value);
}

function readStringField(payload: unknown, field: string): string | undefined {
  if (!isRecord(payload)) return undefined;
  const value = payload[field];
  return typeof value === "string" ? value : undefined;
}

function readAppendResult(payload: unknown): WriteValuesResult {
  if (!isRecord(payload) || !isRecord(payload.updates)) {
    throw new SheetsClientError(
      "INVALID_RESPONSE",
      "Google Sheets append response did not identify the updated range.",
    );
  }
  return {
    updatedRange: readRequiredString(payload.updates, "updatedRange"),
    updatedRows: readRequiredNumber(payload.updates, "updatedRows"),
    updatedColumns: readRequiredNumber(payload.updates, "updatedColumns"),
  };
}

function readUpdateResult(payload: unknown): WriteValuesResult {
  if (!isRecord(payload)) {
    throw new SheetsClientError(
      "INVALID_RESPONSE",
      "Google Sheets update response did not identify the updated range.",
    );
  }
  return {
    updatedRange: readRequiredString(payload, "updatedRange"),
    updatedRows: readRequiredNumber(payload, "updatedRows"),
    updatedColumns: readRequiredNumber(payload, "updatedColumns"),
  };
}

function readRequiredString(record: Record<string, unknown>, field: string): string {
  const value = record[field];
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new SheetsClientError(
      "INVALID_RESPONSE",
      `Google Sheets response was missing '${field}'.`,
    );
  }
  return value;
}

function readRequiredNumber(record: Record<string, unknown>, field: string): number {
  const value = record[field];
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new SheetsClientError(
      "INVALID_RESPONSE",
      `Google Sheets response was missing '${field}'.`,
    );
  }
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function discardBody(response: Response): Promise<void> {
  try {
    await response.body?.cancel();
  } catch {
    // Preserve the sanitized status classification.
  }
}
