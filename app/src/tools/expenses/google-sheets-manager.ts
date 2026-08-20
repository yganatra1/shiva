import { randomUUID } from "node:crypto";

import {
  EXPENSE_SHEET_COLUMNS,
  GoogleSheetsExpenseError,
  GoogleSheetsExpenseRepository,
  readBoundedGoogleSheetsJson,
  type GoogleAccessTokenProvider,
} from "./google-sheets.js";
import {
  EXPENSE_SHEET_SCHEMA_VERSION,
  type ExpenseSheetBinding,
  type ExpenseSheetBindingStore,
} from "./sheet-binding.js";
import type {
  ExpenseRecord,
  ExpenseRepositoryPort,
  InsertExpenseInput,
  ListExpensesInput,
} from "./types.js";

export const EXPENSE_SPREADSHEET_TITLE = "Shiva Expenses";
export const EXPENSE_SHEET_TITLE = "Expenses";
export const MANAGED_EXPENSE_SHEET_RANGE = `${EXPENSE_SHEET_TITLE}!A:G`;

const HEADER_RANGE = `${EXPENSE_SHEET_TITLE}!A1:G1`;
const DEFAULT_API_BASE_URL = "https://sheets.googleapis.com";
const DEFAULT_LEASE_DURATION_MS = 30_000;
const DEFAULT_BUSY_POLL_MS = 25;
const GOOGLE_RESOURCE_ID = /^[A-Za-z0-9_-]{5,256}$/;
const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

interface ResolvedExpenseSheet {
  readonly spreadsheetId: string;
  readonly sheetId: number;
}

interface SheetMetadata {
  readonly sheetId: number;
  readonly frozenRowCount: number;
}

export interface ManagedGoogleSheetsExpenseRepositoryOptions {
  readonly bindingStore: ExpenseSheetBindingStore;
  readonly accessTokenProvider: GoogleAccessTokenProvider;
  /** Legacy/admin seed. It is adopted only when no different durable ID exists. */
  readonly bootstrapSpreadsheetId?: string;
  readonly requestTimeoutMs: number;
  readonly apiBaseUrl?: string;
  readonly fetchFunction?: typeof fetch;
  readonly createExpenseId?: () => string;
  readonly createLeaseOwner?: () => string;
  readonly now?: () => Date;
  readonly leaseDurationMs?: number;
  readonly busyPollMs?: number;
}

/**
 * Per-user Google Sheets gateway.
 *
 * It provisions/adopts one durable spreadsheet binding, then delegates every
 * expense read and append to the strict, fresh-reading Sheets repository. The
 * in-memory promise map is only a single-flight/cache of immutable resource
 * IDs; expense rows are never cached here or in PostgreSQL.
 */
export class ManagedGoogleSheetsExpenseRepository
  implements ExpenseRepositoryPort
{
  private readonly apiBaseUrl: URL;
  private readonly fetchFunction: typeof fetch;
  private readonly createLeaseOwner: () => string;
  private readonly now: () => Date;
  private readonly leaseDurationMs: number;
  private readonly busyPollMs: number;
  private readonly resolutions = new Map<
    string,
    Promise<ResolvedExpenseSheet>
  >();

  constructor(
    private readonly options: ManagedGoogleSheetsExpenseRepositoryOptions,
  ) {
    this.apiBaseUrl = new URL(options.apiBaseUrl ?? DEFAULT_API_BASE_URL);
    this.fetchFunction = options.fetchFunction ?? fetch;
    this.createLeaseOwner = options.createLeaseOwner ?? randomUUID;
    this.now = options.now ?? (() => new Date());
    this.leaseDurationMs =
      options.leaseDurationMs ??
      Math.max(DEFAULT_LEASE_DURATION_MS, options.requestTimeoutMs + 5_000);
    this.busyPollMs = options.busyPollMs ?? DEFAULT_BUSY_POLL_MS;

    if (
      !Number.isFinite(options.requestTimeoutMs) ||
      options.requestTimeoutMs <= 0
    ) {
      throw new RangeError("Google Sheets requestTimeoutMs must be positive.");
    }
    if (
      !Number.isFinite(this.leaseDurationMs) ||
      this.leaseDurationMs <= options.requestTimeoutMs
    ) {
      throw new RangeError(
        "Google Sheets provisioning lease must exceed its request timeout.",
      );
    }
    if (!Number.isFinite(this.busyPollMs) || this.busyPollMs <= 0) {
      throw new RangeError("Google Sheets binding poll interval must be positive.");
    }
    if (
      options.bootstrapSpreadsheetId !== undefined &&
      !GOOGLE_RESOURCE_ID.test(options.bootstrapSpreadsheetId)
    ) {
      throw new TypeError("bootstrapSpreadsheetId is not a Google resource ID.");
    }
  }

  async insertExpense(input: InsertExpenseInput): Promise<ExpenseRecord> {
    assertUserId(input.userId);
    validateInsertBeforeProvisioning(input);
    const repository = await this.repositoryFor(input.userId, input.signal);
    return repository.insertExpense(input);
  }

  async listExpenses(
    input: ListExpensesInput,
  ): Promise<readonly ExpenseRecord[]> {
    assertUserId(input.userId);
    const repository = await this.repositoryFor(input.userId, input.signal);
    return repository.listExpenses(input);
  }

  private async repositoryFor(
    userId: string,
    callerSignal: AbortSignal | undefined,
  ): Promise<GoogleSheetsExpenseRepository> {
    if (callerSignal?.aborted) throw cancelled(callerSignal.reason);

    let resolution = this.resolutions.get(userId);
    if (!resolution) {
      resolution = this.provision(userId);
      this.resolutions.set(userId, resolution);
      void resolution.catch(() => {
        if (this.resolutions.get(userId) === resolution) {
          this.resolutions.delete(userId);
        }
      });
    }

    let sheet: ResolvedExpenseSheet;
    try {
      sheet = await waitForAbortable(resolution, callerSignal);
    } catch (error: unknown) {
      if (callerSignal?.aborted) throw cancelled(error);
      throw error;
    }

    return new GoogleSheetsExpenseRepository({
      spreadsheetId: sheet.spreadsheetId,
      sheetRange: MANAGED_EXPENSE_SHEET_RANGE,
      accessTokenProvider: this.options.accessTokenProvider,
      requestTimeoutMs: this.options.requestTimeoutMs,
      fetchFunction: this.fetchFunction,
      ...(this.options.createExpenseId
        ? { createExpenseId: this.options.createExpenseId }
        : {}),
      apiBaseUrl: this.apiBaseUrl.href,
    });
  }

  private provision(userId: string): Promise<ResolvedExpenseSheet> {
    return this.withProvisioningDeadline(async (signal) => {
      const leaseOwner = this.createLeaseOwner();
      assertUuid(leaseOwner, "Google Sheets lease owner");
      let ownsClaim = false;

      try {
        for (;;) {
          const now = this.now();
          assertValidDate(now, "provisioning clock");
          const claim = await this.bindingCall(
            () =>
              this.options.bindingStore.claimProvisioning({
                userId,
                leaseOwner,
                now,
                leaseExpiresAt: new Date(now.getTime() + this.leaseDurationMs),
                ...(this.options.bootstrapSpreadsheetId
                  ? {
                      bootstrapSpreadsheetId:
                        this.options.bootstrapSpreadsheetId,
                    }
                  : {}),
              }),
            signal,
          );
          assertBinding(claim.binding, userId);
          this.assertNoBootstrapConflict(claim.binding);

          if (claim.state === "busy") {
            await delay(this.busyPollMs, signal);
            continue;
          }

          if (claim.state === "ready") {
            if (claim.binding.schemaVersion > EXPENSE_SHEET_SCHEMA_VERSION) {
              throw invalidBinding(
                "The expense sheet binding uses an unsupported future schema.",
              );
            }
            const spreadsheetId = requiredSpreadsheetId(claim.binding);
            const token = await this.getAccessToken(signal);
            const sheet = await this.verifyAdoptedSpreadsheet(
              spreadsheetId,
              token,
              signal,
              false,
            );
            if (claim.binding.sheetId !== sheet.sheetId) {
              throw invalidBinding(
                "The bound expense tab no longer matches the Google spreadsheet.",
              );
            }
            return { spreadsheetId, sheetId: sheet.sheetId };
          }

          ownsClaim = true;
          const token = await this.getAccessToken(signal);
          let spreadsheetId = claim.binding.spreadsheetId;
          let sheetId: number;
          let headerVerified = false;

          if (spreadsheetId) {
            const adopted = await this.verifyAdoptedSpreadsheet(
              spreadsheetId,
              token,
              signal,
              true,
            );
            sheetId = adopted.sheetId;
            headerVerified = true;
          } else {
            const created = await this.createSpreadsheet(token, signal);
            spreadsheetId = created.spreadsheetId;
            sheetId = created.sheetId;
            const attached = await this.bindingCall(
              () =>
                this.options.bindingStore.attachSpreadsheetId({
                  userId,
                  leaseOwner,
                  spreadsheetId: created.spreadsheetId,
                  now: this.now(),
                }),
              signal,
            );
            if (!attached) {
              throw invalidBinding(
                "The expense sheet provisioning claim changed during creation.",
              );
            }
            assertBinding(attached, userId);
          }

          if (!headerVerified) {
            await this.verifyHeader(spreadsheetId, token, signal);
          }
          const ready = await this.bindingCall(
            () =>
              this.options.bindingStore.markReady({
                userId,
                leaseOwner,
                spreadsheetId,
                sheetId,
                schemaVersion: EXPENSE_SHEET_SCHEMA_VERSION,
                now: this.now(),
              }),
            signal,
          );
          if (!ready) {
            throw invalidBinding(
              "The expense sheet provisioning claim changed before completion.",
            );
          }
          assertBinding(ready, userId);
          ownsClaim = false;
          return { spreadsheetId, sheetId };
        }
      } catch (error: unknown) {
        if (ownsClaim) {
          this.releaseClaimBestEffort(userId, leaseOwner);
        }
        throw error;
      }
    });
  }

  private assertNoBootstrapConflict(binding: ExpenseSheetBinding): void {
    const bootstrap = this.options.bootstrapSpreadsheetId;
    if (
      bootstrap &&
      binding.spreadsheetId &&
      binding.spreadsheetId !== bootstrap
    ) {
      throw invalidBinding(
        "The configured spreadsheet conflicts with the user's durable expense sheet binding.",
      );
    }
  }

  private async createSpreadsheet(
    token: string,
    signal: AbortSignal,
  ): Promise<ResolvedExpenseSheet> {
    const payload = await this.requestJson(
      new URL("/v4/spreadsheets", this.apiBaseUrl),
      token,
      signal,
      {
        method: "POST",
        body: JSON.stringify({
          properties: { title: EXPENSE_SPREADSHEET_TITLE },
          sheets: [
            {
              properties: {
                title: EXPENSE_SHEET_TITLE,
                gridProperties: { frozenRowCount: 1 },
              },
              data: [
                {
                  startRow: 0,
                  startColumn: 0,
                  rowData: [
                    {
                      values: EXPENSE_SHEET_COLUMNS.map((header) => ({
                        userEnteredValue: { stringValue: header },
                      })),
                    },
                  ],
                },
              ],
            },
          ],
        }),
      },
    );
    return readCreatedSpreadsheet(payload);
  }

  private async verifyAdoptedSpreadsheet(
    spreadsheetId: string,
    token: string,
    signal: AbortSignal,
    initializeEmpty: boolean,
  ): Promise<SheetMetadata> {
    const metadataUrl = this.spreadsheetUrl(spreadsheetId);
    metadataUrl.searchParams.set(
      "fields",
      "sheets.properties(sheetId,title,gridProperties(frozenRowCount))",
    );
    const payload = await this.requestJson(metadataUrl, token, signal);
    const existingSheet = findExpenseSheetMetadata(payload);
    if (!existingSheet && !initializeEmpty) {
      throw invalidGoogleResponse(
        `The bound spreadsheet no longer contains the ${EXPENSE_SHEET_TITLE} tab.`,
      );
    }
    const sheet =
      existingSheet ??
      (await this.addExpenseTab(spreadsheetId, token, signal));
    await this.verifyHeader(spreadsheetId, token, signal, initializeEmpty);
    if (sheet.frozenRowCount !== 1) {
      if (!initializeEmpty) {
        throw invalidGoogleResponse(
          "The bound expense tab no longer has the canonical frozen header row.",
        );
      }
      await this.requestJson(
        this.batchUpdateUrl(spreadsheetId),
        token,
        signal,
        {
          method: "POST",
          body: JSON.stringify({
            requests: [
              {
                updateSheetProperties: {
                  properties: {
                    sheetId: sheet.sheetId,
                    gridProperties: { frozenRowCount: 1 },
                  },
                  fields: "gridProperties.frozenRowCount",
                },
              },
            ],
          }),
        },
      );
    }
    return sheet;
  }

  private async addExpenseTab(
    spreadsheetId: string,
    token: string,
    signal: AbortSignal,
  ): Promise<SheetMetadata> {
    const payload = await this.requestJson(
      this.batchUpdateUrl(spreadsheetId),
      token,
      signal,
      {
        method: "POST",
        body: JSON.stringify({
          requests: [
            {
              addSheet: {
                properties: {
                  title: EXPENSE_SHEET_TITLE,
                  gridProperties: { frozenRowCount: 1 },
                },
              },
            },
          ],
        }),
      },
    );
    return readAddedExpenseSheet(payload);
  }

  private async verifyHeader(
    spreadsheetId: string,
    token: string,
    signal: AbortSignal,
    initializeIfEmpty = false,
  ): Promise<void> {
    const url = this.valuesUrl(spreadsheetId, HEADER_RANGE);
    url.searchParams.set("majorDimension", "ROWS");
    url.searchParams.set("valueRenderOption", "UNFORMATTED_VALUE");
    const payload = await this.requestJson(url, token, signal);
    const rows = readValueRows(payload);
    if (initializeIfEmpty && isEmptyHeader(rows)) {
      const fullRangeUrl = this.valuesUrl(
        spreadsheetId,
        MANAGED_EXPENSE_SHEET_RANGE,
      );
      fullRangeUrl.searchParams.set("majorDimension", "ROWS");
      fullRangeUrl.searchParams.set("valueRenderOption", "UNFORMATTED_VALUE");
      const fullRangePayload = await this.requestJson(
        fullRangeUrl,
        token,
        signal,
      );
      if (!isEntireTabEmpty(readValueRows(fullRangePayload))) {
        throw invalidGoogleResponse(
          "The expense tab has data below its missing canonical header and cannot be initialized safely.",
        );
      }
      const writeUrl = this.valuesUrl(spreadsheetId, HEADER_RANGE);
      writeUrl.searchParams.set("valueInputOption", "RAW");
      await this.requestJson(writeUrl, token, signal, {
        method: "PUT",
        body: JSON.stringify({
          majorDimension: "ROWS",
          values: [[...EXPENSE_SHEET_COLUMNS]],
        }),
      });
      await this.verifyHeader(spreadsheetId, token, signal);
      return;
    }
    if (
      rows.length !== 1 ||
      !exactStringRow(rows[0] ?? [], [...EXPENSE_SHEET_COLUMNS])
    ) {
      throw new GoogleSheetsExpenseError(
        "INVALID_RESPONSE",
        `The expense sheet must begin with: ${EXPENSE_SHEET_COLUMNS.join(", ")}.`,
      );
    }
  }

  private spreadsheetUrl(spreadsheetId: string): URL {
    return new URL(
      `/v4/spreadsheets/${encodeURIComponent(spreadsheetId)}`,
      this.apiBaseUrl,
    );
  }

  private batchUpdateUrl(spreadsheetId: string): URL {
    return new URL(
      `/v4/spreadsheets/${encodeURIComponent(spreadsheetId)}:batchUpdate`,
      this.apiBaseUrl,
    );
  }

  private valuesUrl(spreadsheetId: string, range: string): URL {
    return new URL(
      `/v4/spreadsheets/${encodeURIComponent(spreadsheetId)}/values/${encodeURIComponent(range)}`,
      this.apiBaseUrl,
    );
  }

  private async getAccessToken(signal: AbortSignal): Promise<string> {
    try {
      const token = await this.options.accessTokenProvider.getAccessToken(signal);
      if (!token || token.trim().length === 0) {
        throw new GoogleSheetsExpenseError(
          "AUTH",
          "Google authentication did not return an access token.",
        );
      }
      return token;
    } catch (error: unknown) {
      if (error instanceof GoogleSheetsExpenseError) throw error;
      signal.throwIfAborted();
      throw new GoogleSheetsExpenseError(
        "AUTH",
        "Google Sheets authentication failed.",
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

  private async bindingCall<T>(
    operation: () => Promise<T>,
    signal: AbortSignal,
  ): Promise<T> {
    try {
      return await waitForAbortable(Promise.resolve().then(operation), signal);
    } catch (error: unknown) {
      signal.throwIfAborted();
      if (error instanceof GoogleSheetsExpenseError) throw error;
      throw new GoogleSheetsExpenseError(
        "UNAVAILABLE",
        "The expense sheet binding could not be persisted.",
      );
    }
  }

  private releaseClaimBestEffort(
    userId: string,
    leaseOwner: string,
  ): void {
    // Never extend the foreground deadline for cleanup. releaseClaim is an
    // owner-CAS; if it stalls or loses the race, the durable lease still expires.
    try {
      const release = this.options.bindingStore.releaseClaim({
        userId,
        leaseOwner,
        now: this.now(),
      });
      void release.catch(() => undefined);
    } catch {
      // The original provisioning failure remains authoritative.
    }
  }

  private async withProvisioningDeadline<T>(
    operation: (signal: AbortSignal) => Promise<T>,
  ): Promise<T> {
    const deadline = new AbortController();
    const timeout = setTimeout(
      () => deadline.abort(new Error("Google Sheets provisioning timed out.")),
      this.options.requestTimeoutMs,
    );
    timeout.unref();
    try {
      return await operation(deadline.signal);
    } catch (error: unknown) {
      if (error instanceof GoogleSheetsExpenseError) throw error;
      if (deadline.signal.aborted) {
        throw new GoogleSheetsExpenseError(
          "TIMEOUT",
          `Google Sheets provisioning did not complete within ${this.options.requestTimeoutMs}ms.`,
        );
      }
      throw new GoogleSheetsExpenseError(
        "UNAVAILABLE",
        "The Google Sheets expense ledger could not be provisioned.",
      );
    } finally {
      clearTimeout(timeout);
    }
  }
}

function readCreatedSpreadsheet(payload: unknown): ResolvedExpenseSheet {
  if (
    !isRecord(payload) ||
    typeof payload.spreadsheetId !== "string" ||
    !GOOGLE_RESOURCE_ID.test(payload.spreadsheetId)
  ) {
    throw invalidGoogleResponse("Google Sheets create did not return a spreadsheet ID.");
  }
  const sheet = findExpenseSheetMetadata(payload);
  if (!sheet) {
    throw invalidGoogleResponse(
      `Google Sheets create did not return the ${EXPENSE_SHEET_TITLE} tab.`,
    );
  }
  return { spreadsheetId: payload.spreadsheetId, sheetId: sheet.sheetId };
}

function findExpenseSheetMetadata(payload: unknown): SheetMetadata | null {
  if (!isRecord(payload) || !Array.isArray(payload.sheets)) {
    throw invalidGoogleResponse("Google Sheets returned invalid spreadsheet metadata.");
  }
  for (const candidate of payload.sheets) {
    if (!isRecord(candidate) || !isRecord(candidate.properties)) continue;
    const properties = candidate.properties;
    if (properties.title !== EXPENSE_SHEET_TITLE) continue;
    if (!isNonNegativeInteger(properties.sheetId)) {
      throw invalidGoogleResponse("Google Sheets returned an invalid expense tab ID.");
    }
    const grid = properties.gridProperties;
    const frozenRowCount =
      isRecord(grid) && isNonNegativeInteger(grid.frozenRowCount)
        ? grid.frozenRowCount
        : 0;
    return { sheetId: properties.sheetId, frozenRowCount };
  }
  return null;
}

function readAddedExpenseSheet(payload: unknown): SheetMetadata {
  if (!isRecord(payload) || !Array.isArray(payload.replies)) {
    throw invalidGoogleResponse(
      "Google Sheets did not confirm creation of the expense tab.",
    );
  }
  const reply = payload.replies[0];
  if (
    !isRecord(reply) ||
    !isRecord(reply.addSheet) ||
    !isRecord(reply.addSheet.properties)
  ) {
    throw invalidGoogleResponse(
      "Google Sheets did not confirm creation of the expense tab.",
    );
  }
  const properties = reply.addSheet.properties;
  if (
    properties.title !== EXPENSE_SHEET_TITLE ||
    !isNonNegativeInteger(properties.sheetId)
  ) {
    throw invalidGoogleResponse(
      "Google Sheets returned invalid metadata for the new expense tab.",
    );
  }
  return { sheetId: properties.sheetId, frozenRowCount: 1 };
}

function readValueRows(payload: unknown): readonly (readonly unknown[])[] {
  if (!isRecord(payload)) {
    throw invalidGoogleResponse("Google Sheets returned an invalid values response.");
  }
  if (payload.values === undefined) return [];
  if (!Array.isArray(payload.values)) {
    throw invalidGoogleResponse("Google Sheets returned an invalid values response.");
  }
  if (!payload.values.every(Array.isArray)) {
    throw invalidGoogleResponse("Google Sheets returned an invalid row shape.");
  }
  return payload.values;
}

function isEmptyHeader(rows: readonly (readonly unknown[])[]): boolean {
  return (
    rows.length === 0 ||
    (rows.length === 1 &&
      (rows[0] ?? []).every(
        (cell) => cell === undefined || cell === null || cell === "",
      ))
  );
}

function isEntireTabEmpty(rows: readonly (readonly unknown[])[]): boolean {
  return rows.every((row) =>
    row.every((cell) => cell === undefined || cell === null || cell === ""),
  );
}

function exactStringRow(
  actual: readonly unknown[],
  expected: readonly string[],
): boolean {
  return (
    actual.length === expected.length &&
    expected.every((value, index) => actual[index] === value)
  );
}

function requiredSpreadsheetId(binding: ExpenseSheetBinding): string {
  if (!binding.spreadsheetId || !GOOGLE_RESOURCE_ID.test(binding.spreadsheetId)) {
    throw invalidBinding("The ready expense sheet binding has no valid spreadsheet ID.");
  }
  if (!isNonNegativeInteger(binding.sheetId)) {
    throw invalidBinding("The ready expense sheet binding has no valid tab ID.");
  }
  return binding.spreadsheetId;
}

function assertBinding(binding: ExpenseSheetBinding, userId: string): void {
  if (binding.userId !== userId) {
    throw invalidBinding("The expense sheet binding resolved to a different user.");
  }
}

function assertUserId(userId: string): void {
  assertUuid(userId, "Expense sheet userId");
}

function assertUuid(value: string, name: string): void {
  if (!UUID.test(value)) {
    throw new GoogleSheetsExpenseError("INVALID_INPUT", `${name} must be a UUID.`);
  }
}

function assertValidDate(value: Date, name: string): void {
  if (!Number.isFinite(value.getTime())) {
    throw new GoogleSheetsExpenseError(
      "INVALID_RESPONSE",
      `The ${name} returned an invalid date.`,
    );
  }
}

function validateInsertBeforeProvisioning(input: InsertExpenseInput): void {
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

function invalidBinding(message: string): GoogleSheetsExpenseError {
  return new GoogleSheetsExpenseError("INVALID_RESPONSE", message);
}

function invalidGoogleResponse(message: string): GoogleSheetsExpenseError {
  return new GoogleSheetsExpenseError("INVALID_RESPONSE", message);
}

function cancelled(cause: unknown): GoogleSheetsExpenseError {
  return new GoogleSheetsExpenseError(
    "CANCELLED",
    "The Google Sheets expense operation was cancelled.",
    { cause },
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNonNegativeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0;
}

async function discardBody(response: Response): Promise<void> {
  try {
    await response.body?.cancel();
  } catch {
    // Preserve the sanitized status classification.
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

function delay(durationMs: number, signal: AbortSignal): Promise<void> {
  signal.throwIfAborted();
  return new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, durationMs);
    const onAbort = (): void => {
      clearTimeout(timeout);
      reject(signal.reason);
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });
}
