import { randomUUID } from "node:crypto";

import {
  GoogleAuth,
  type GoogleAuthOptions,
} from "google-auth-library";

import type {
  ExpenseRecord,
  ExpenseRepositoryPort,
  InsertExpenseInput,
  ListExpensesInput,
} from "./types";

export const EXPENSE_SHEET_COLUMNS = [
  "expense_id",
  "occurred_at",
  "amount",
  "currency",
  "description",
  "category",
  "source",
] as const;

const GOOGLE_SHEETS_SCOPE = "https://www.googleapis.com/auth/spreadsheets";
const DEFAULT_SHEET_RANGE = "Expenses!A:G";
const DEFAULT_API_BASE_URL = "https://sheets.googleapis.com";
export const GOOGLE_SHEETS_MAX_JSON_RESPONSE_BYTES = 8 * 1024 * 1024;
const RFC3339_TIMESTAMP =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/;

export type GoogleSheetsExpenseFailure =
  | "INVALID_INPUT"
  | "AUTH"
  | "UNAVAILABLE"
  | "TIMEOUT"
  | "CANCELLED"
  | "INVALID_RESPONSE"
  | "WRITE_NOT_CONFIRMED";

export class GoogleSheetsExpenseError extends Error {
  override readonly name = "GoogleSheetsExpenseError";

  constructor(
    readonly failure: GoogleSheetsExpenseFailure,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
  }
}

export interface GoogleAccessTokenProvider {
  getAccessToken(signal?: AbortSignal): Promise<string>;
}

/** Uses Application Default Credentials or the credentials supplied in options. */
export class GoogleAuthAccessTokenProvider implements GoogleAccessTokenProvider {
  private readonly auth: GoogleAuth;

  constructor(options: GoogleAuthOptions = {}) {
    this.auth = new GoogleAuth({
      scopes: [GOOGLE_SHEETS_SCOPE],
      ...options,
    });
  }

  async getAccessToken(signal?: AbortSignal): Promise<string> {
    const token = await waitForAbortable(this.auth.getAccessToken(), signal);
    if (!token || token.trim().length === 0) {
      throw new GoogleSheetsExpenseError(
        "AUTH",
        "Google authentication did not return an access token.",
      );
    }
    return token;
  }
}

export interface GoogleSheetsExpenseRepositoryOptions {
  readonly spreadsheetId: string;
  readonly sheetRange?: string;
  readonly accessTokenProvider: GoogleAccessTokenProvider;
  readonly requestTimeoutMs: number;
  readonly apiBaseUrl?: string;
  readonly fetchFunction?: typeof fetch;
  readonly createExpenseId?: () => string;
}

/**
 * Private Google Sheets expense adapter.
 *
 * The configured range must expose exactly the seven canonical columns in A:G.
 * Every operation reads Google Sheets afresh; this adapter intentionally keeps
 * no row cache or database mirror.
 */
export class GoogleSheetsExpenseRepository implements ExpenseRepositoryPort {
  private readonly spreadsheetId: string;
  private readonly sheetRange: string;
  private readonly apiBaseUrl: URL;
  private readonly fetchFunction: typeof fetch;
  private readonly createExpenseId: () => string;

  constructor(private readonly options: GoogleSheetsExpenseRepositoryOptions) {
    this.spreadsheetId = options.spreadsheetId.trim();
    this.sheetRange = options.sheetRange?.trim() || DEFAULT_SHEET_RANGE;
    this.apiBaseUrl = new URL(options.apiBaseUrl ?? DEFAULT_API_BASE_URL);
    this.fetchFunction = options.fetchFunction ?? fetch;
    this.createExpenseId = options.createExpenseId ?? randomUUID;

    if (this.spreadsheetId.length === 0) {
      throw new TypeError("Google Sheets spreadsheetId must not be empty.");
    }
    if (!isCanonicalSheetRange(this.sheetRange)) {
      throw new TypeError(
        "Google Sheets sheetRange must begin at row 1 and span canonical columns A:G.",
      );
    }
    if (
      !Number.isFinite(options.requestTimeoutMs) ||
      options.requestTimeoutMs <= 0
    ) {
      throw new RangeError("Google Sheets requestTimeoutMs must be positive.");
    }
  }

  async insertExpense(input: InsertExpenseInput): Promise<ExpenseRecord> {
    validateInsertInput(input);
    return this.withDeadline(input.signal, async (signal) => {
      const token = await this.getAccessToken(signal);

      // Validate the live sheet contract immediately before mutating it.
      await this.readRows(token, signal);

      const expenseId = this.createExpenseId();
      if (
        expenseId.trim().length === 0 ||
        expenseId !== expenseId.trim() ||
        expenseId.length > 200
      ) {
        throw new GoogleSheetsExpenseError(
          "INVALID_RESPONSE",
          "The expense ID generator returned an invalid value.",
        );
      }
      const expectedRow = [
        expenseId,
        input.occurredAt.toISOString(),
        input.amount,
        input.currency,
        input.description,
        input.category ?? "",
        input.source,
      ];
      const appendUrl = this.valuesUrl(this.sheetRange, ":append");
      appendUrl.searchParams.set("valueInputOption", "RAW");
      appendUrl.searchParams.set("insertDataOption", "INSERT_ROWS");

      const appendPayload = await this.requestJson(
        appendUrl,
        token,
        signal,
        {
          method: "POST",
          body: JSON.stringify({
            majorDimension: "ROWS",
            values: [expectedRow],
          }),
        },
      );
      const updatedRange = readUpdatedRange(appendPayload);
      assertSingleCanonicalRowRange(updatedRange);

      // Do not trust the append response as persistence confirmation. Read the
      // exact range Google says it updated and compare all canonical cells.
      const confirmedPayload = await this.requestJson(
        this.valuesReadUrl(updatedRange),
        token,
        signal,
      );
      const confirmedValues = readValues(confirmedPayload);
      if (
        confirmedValues.length !== 1 ||
        !rowsEqual(confirmedValues[0] ?? [], expectedRow)
      ) {
        throw new GoogleSheetsExpenseError(
          "WRITE_NOT_CONFIRMED",
          "The expense row could not be confirmed after the Google Sheets append.",
        );
      }

      const confirmed = parseExpenseRow(confirmedValues[0] ?? []);
      if (confirmed.expenseId !== expenseId) {
        throw new GoogleSheetsExpenseError(
          "WRITE_NOT_CONFIRMED",
          "The confirmed Google Sheets row did not contain the expected expense ID.",
        );
      }
      return confirmed;
    });
  }

  async listExpenses(
    input: ListExpensesInput,
  ): Promise<readonly ExpenseRecord[]> {
    return this.withDeadline(input.signal, async (signal) => {
      const token = await this.getAccessToken(signal);
      const rows = await this.readRows(token, signal);
      return rows
        .filter(
          (expense) =>
            (!input.from || expense.occurredAt >= input.from) &&
            (!input.until || expense.occurredAt < input.until),
        )
        .sort(
          (left, right) =>
            right.occurredAt.getTime() - left.occurredAt.getTime() ||
            right.expenseId.localeCompare(left.expenseId),
        );
    });
  }

  private async readRows(
    token: string,
    signal: AbortSignal,
  ): Promise<ExpenseRecord[]> {
    const payload = await this.requestJson(
      this.valuesReadUrl(this.sheetRange),
      token,
      signal,
    );
    const values = readValues(payload);
    const header = values[0];
    if (!header || !rowsEqual(header, [...EXPENSE_SHEET_COLUMNS])) {
      throw new GoogleSheetsExpenseError(
        "INVALID_RESPONSE",
        `The expense sheet must begin with: ${EXPENSE_SHEET_COLUMNS.join(", ")}.`,
      );
    }

    return values
      .slice(1)
      .filter((row) => row.some((cell) => stringifyCell(cell).trim().length > 0))
      .map(parseExpenseRow);
  }

  private valuesUrl(range: string, suffix = ""): URL {
    return new URL(
      `/v4/spreadsheets/${encodeURIComponent(this.spreadsheetId)}/values/${encodeURIComponent(range)}${suffix}`,
      this.apiBaseUrl,
    );
  }

  private valuesReadUrl(range: string): URL {
    const url = this.valuesUrl(range);
    url.searchParams.set("majorDimension", "ROWS");
    url.searchParams.set("valueRenderOption", "UNFORMATTED_VALUE");
    url.searchParams.set("dateTimeRenderOption", "FORMATTED_STRING");
    return url;
  }

  private async getAccessToken(signal: AbortSignal): Promise<string> {
    try {
      const token = await this.options.accessTokenProvider.getAccessToken(signal);
      if (token.trim().length === 0) {
        throw new GoogleSheetsExpenseError(
          "AUTH",
          "Google authentication returned an empty access token.",
        );
      }
      return token;
    } catch (error: unknown) {
      if (error instanceof GoogleSheetsExpenseError) throw error;
      signal.throwIfAborted();
      throw new GoogleSheetsExpenseError(
        "AUTH",
        "Google Sheets authentication failed.",
        { cause: error },
      );
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
        throw new GoogleSheetsExpenseError(
          "AUTH",
          "Google Sheets rejected the configured credentials.",
        );
      }
      throw new GoogleSheetsExpenseError(
        "UNAVAILABLE",
        `Google Sheets returned HTTP status ${response.status}.`,
      );
    }

    return readBoundedGoogleSheetsJson(response, signal);
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
      if (error instanceof GoogleSheetsExpenseError) throw error;
      if (callerSignal?.aborted) {
        throw new GoogleSheetsExpenseError(
          "CANCELLED",
          "The Google Sheets expense operation was cancelled.",
          { cause: error },
        );
      }
      if (deadline.signal.aborted) {
        throw new GoogleSheetsExpenseError(
          "TIMEOUT",
          `Google Sheets did not respond within ${this.options.requestTimeoutMs}ms.`,
          { cause: error },
        );
      }
      throw new GoogleSheetsExpenseError(
        "UNAVAILABLE",
        "The Google Sheets expense operation could not be completed.",
        { cause: error },
      );
    } finally {
      clearTimeout(timeout);
    }
  }
}

/**
 * Reads a Google Sheets JSON response without allowing an absent or dishonest
 * Content-Length header to bypass the in-process allocation limit.
 */
export async function readBoundedGoogleSheetsJson(
  response: Response,
  signal: AbortSignal,
): Promise<unknown> {
  const declaredLength = readContentLength(response);
  if (
    declaredLength !== null &&
    declaredLength > GOOGLE_SHEETS_MAX_JSON_RESPONSE_BYTES
  ) {
    cancelResponseBody(response);
    throw responseTooLarge();
  }

  signal.throwIfAborted();
  const reader = response.body?.getReader();
  if (!reader) {
    if (declaredLength !== null && declaredLength !== 0) {
      throw contentLengthMismatch();
    }
    throw malformedJson();
  }

  const chunks: Uint8Array[] = [];
  let receivedBytes = 0;
  try {
    for (;;) {
      const { done, value } = await waitForAbortable(reader.read(), signal);
      if (done) break;
      if (!value || value.byteLength === 0) continue;

      receivedBytes += value.byteLength;
      if (receivedBytes > GOOGLE_SHEETS_MAX_JSON_RESPONSE_BYTES) {
        cancelReader(reader);
        throw responseTooLarge();
      }
      chunks.push(value);
    }
  } catch (error: unknown) {
    cancelReader(reader);
    if (error instanceof GoogleSheetsExpenseError) throw error;
    signal.throwIfAborted();
    throw new GoogleSheetsExpenseError(
      "UNAVAILABLE",
      "The Google Sheets response body could not be read.",
    );
  } finally {
    try {
      reader.releaseLock();
    } catch {
      // Cancellation can leave a read pending briefly; the handled cancel owns it.
    }
  }

  if (
    declaredLength !== null &&
    hasIdentityContentEncoding(response) &&
    declaredLength !== receivedBytes
  ) {
    throw contentLengthMismatch();
  }

  const bytes = new Uint8Array(receivedBytes);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }

  try {
    const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    return JSON.parse(text) as unknown;
  } catch {
    throw malformedJson();
  }
}

function readUpdatedRange(payload: unknown): string {
  if (!isRecord(payload) || !isRecord(payload.updates)) {
    throw new GoogleSheetsExpenseError(
      "INVALID_RESPONSE",
      "Google Sheets append response did not identify the updated range.",
    );
  }
  const updatedRange = payload.updates.updatedRange;
  if (typeof updatedRange !== "string" || updatedRange.trim().length === 0) {
    throw new GoogleSheetsExpenseError(
      "INVALID_RESPONSE",
      "Google Sheets append response did not identify the updated range.",
    );
  }
  return updatedRange;
}

function assertSingleCanonicalRowRange(range: string): void {
  const match = /(?:^|!)A(\d+):G(\d+)$/.exec(range);
  if (!match || match[1] !== match[2]) {
    throw new GoogleSheetsExpenseError(
      "INVALID_RESPONSE",
      "Google Sheets append response returned an invalid updated range.",
    );
  }
}

function isCanonicalSheetRange(range: string): boolean {
  return /(?:^|!)A(?:1)?:G$/i.test(range);
}

function readValues(payload: unknown): readonly (readonly unknown[])[] {
  if (!isRecord(payload) || !Array.isArray(payload.values)) {
    throw new GoogleSheetsExpenseError(
      "INVALID_RESPONSE",
      "Google Sheets returned an invalid values response.",
    );
  }
  if (!payload.values.every(Array.isArray)) {
    throw new GoogleSheetsExpenseError(
      "INVALID_RESPONSE",
      "Google Sheets returned an invalid row shape.",
    );
  }
  return payload.values;
}

function parseExpenseRow(row: readonly unknown[]): ExpenseRecord {
  if (row.length > EXPENSE_SHEET_COLUMNS.length) {
    throw invalidRow();
  }
  const expenseId = requiredCell(row[0]);
  const occurredAtRaw = requiredCell(row[1]);
  const amount = normalizeAmount(requiredCell(row[2]));
  const currency = requiredCell(row[3]).toUpperCase();
  const description = requiredCell(row[4]);
  const categoryValue = stringifyCell(row[5]).trim();
  const source = requiredCell(row[6]);
  const occurredAt = new Date(occurredAtRaw);

  if (
    !RFC3339_TIMESTAMP.test(occurredAtRaw) ||
    !Number.isFinite(occurredAt.getTime()) ||
    !/^[A-Z]{3}$/.test(currency) ||
    expenseId.length > 200 ||
    description.length > 500 ||
    categoryValue.length > 100 ||
    source.length > 100
  ) {
    throw invalidRow();
  }

  return {
    expenseId,
    occurredAt,
    amount,
    currency,
    description,
    category: categoryValue || null,
    source,
  };
}

function validateInsertInput(input: InsertExpenseInput): void {
  if (
    !Number.isFinite(input.occurredAt.getTime()) ||
    !/^\d{1,16}\.\d{2}$/.test(input.amount) ||
    /^0+\.00$/.test(input.amount) ||
    !/^[A-Z]{3}$/.test(input.currency) ||
    input.description.trim().length === 0 ||
    input.description !== input.description.trim() ||
    input.description.length > 500 ||
    (input.category !== null &&
      (input.category.trim().length === 0 ||
        input.category !== input.category.trim() ||
        input.category.length > 100)) ||
    input.source.trim().length === 0 ||
    input.source !== input.source.trim() ||
    input.source.length > 100
  ) {
    throw new GoogleSheetsExpenseError(
      "INVALID_INPUT",
      "The expense values did not match the canonical sheet contract.",
    );
  }
}

function normalizeAmount(value: string): string {
  const match = /^(0|[1-9]\d*)(?:\.(\d{1,2}))?$/.exec(value);
  if (!match || /^0(?:\.0{1,2})?$/.test(value)) throw invalidRow();
  return `${match[1]}.${(match[2] ?? "").padEnd(2, "0")}`;
}

function requiredCell(value: unknown): string {
  const normalized = stringifyCell(value).trim();
  if (normalized.length === 0) throw invalidRow();
  return normalized;
}

function stringifyCell(value: unknown): string {
  if (typeof value === "string" || typeof value === "number") {
    return String(value);
  }
  if (value === undefined || value === null) return "";
  throw invalidRow();
}

function rowsEqual(left: readonly unknown[], right: readonly string[]): boolean {
  return (
    left.length <= right.length &&
    right.every((expected, index) => stringifyCell(left[index]) === expected)
  );
}

function invalidRow(): GoogleSheetsExpenseError {
  return new GoogleSheetsExpenseError(
    "INVALID_RESPONSE",
    "Google Sheets returned an invalid expense row.",
  );
}

function readContentLength(response: Response): number | null {
  const raw = response.headers.get("content-length");
  if (raw === null) return null;
  if (!/^(0|[1-9]\d*)$/.test(raw)) {
    throw contentLengthMismatch();
  }
  const length = Number(raw);
  if (!Number.isSafeInteger(length)) {
    throw responseTooLarge();
  }
  return length;
}

function hasIdentityContentEncoding(response: Response): boolean {
  const encoding = response.headers.get("content-encoding");
  return encoding === null || encoding.trim().toLowerCase() === "identity";
}

function responseTooLarge(): GoogleSheetsExpenseError {
  return new GoogleSheetsExpenseError(
    "INVALID_RESPONSE",
    `Google Sheets returned more than ${GOOGLE_SHEETS_MAX_JSON_RESPONSE_BYTES} bytes of JSON.`,
  );
}

function contentLengthMismatch(): GoogleSheetsExpenseError {
  return new GoogleSheetsExpenseError(
    "INVALID_RESPONSE",
    "Google Sheets returned an inconsistent response length.",
  );
}

function malformedJson(): GoogleSheetsExpenseError {
  return new GoogleSheetsExpenseError(
    "INVALID_RESPONSE",
    "Google Sheets returned malformed JSON.",
  );
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

function cancelResponseBody(response: Response): void {
  try {
    const cancellation = response.body?.cancel();
    if (cancellation) void cancellation.catch(() => undefined);
  } catch {
    // The bounded response failure remains authoritative.
  }
}

function cancelReader(reader: ReadableStreamDefaultReader<Uint8Array>): void {
  try {
    void reader.cancel().catch(() => undefined);
  } catch {
    // The bounded response failure remains authoritative.
  }
}

async function waitForAbortable<T>(
  promise: Promise<T>,
  signal: AbortSignal | undefined,
): Promise<T> {
  if (!signal) return promise;
  signal.throwIfAborted();

  return new Promise<T>((resolve, reject) => {
    const onAbort = (): void => reject(signal.reason);
    signal.addEventListener("abort", onAbort, { once: true });
    void promise.then(
      (value) => {
        signal.removeEventListener("abort", onAbort);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener("abort", onAbort);
        reject(error);
      },
    );
  });
}
