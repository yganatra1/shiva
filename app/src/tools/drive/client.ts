import {
  readBoundedGoogleSheetsJson,
  type GoogleAccessTokenProvider,
} from "../expenses/google-sheets";

export type { GoogleAccessTokenProvider } from "../expenses/google-sheets";

export type DriveClientFailure =
  | "INVALID_INPUT"
  | "AUTH"
  | "UNAVAILABLE"
  | "TIMEOUT"
  | "CANCELLED"
  | "INVALID_RESPONSE";

export class DriveClientError extends Error {
  override readonly name = "DriveClientError";

  constructor(
    readonly failure: DriveClientFailure,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
  }
}

export interface DriveFile {
  readonly id: string;
  readonly name: string;
  readonly url: string;
  readonly modifiedTime: string;
}

export interface FindSpreadsheetsInput {
  readonly query: string;
  readonly maxResults?: number;
  readonly signal?: AbortSignal;
}

export interface GoogleDriveClientOptions {
  readonly accessTokenProvider: GoogleAccessTokenProvider;
  readonly requestTimeoutMs: number;
  readonly apiBaseUrl?: string;
  readonly fetchFunction?: typeof fetch;
}

const DEFAULT_API_BASE_URL = "https://www.googleapis.com";
const DEFAULT_MAX_RESULTS = 10;
const MAX_RESULTS_CAP = 25;
const MAX_QUERY_LENGTH = 200;

/**
 * Finds a user's own spreadsheets by name via the Drive API, so a skill that
 * created a sheet earlier (or the user made one manually) can be found again
 * without depending on conversational memory retaining its raw ID. Read-only
 * metadata search — file *content* still goes through GoogleSheetsClient's
 * separate `spreadsheets` scope, never through this client.
 */
export class GoogleDriveClient {
  private readonly apiBaseUrl: URL;
  private readonly fetchFunction: typeof fetch;

  constructor(private readonly options: GoogleDriveClientOptions) {
    this.apiBaseUrl = new URL(options.apiBaseUrl ?? DEFAULT_API_BASE_URL);
    this.fetchFunction = options.fetchFunction ?? fetch;
    if (
      !Number.isFinite(options.requestTimeoutMs) ||
      options.requestTimeoutMs <= 0
    ) {
      throw new RangeError("Google Drive requestTimeoutMs must be positive.");
    }
  }

  async findSpreadsheets(
    input: FindSpreadsheetsInput,
  ): Promise<readonly DriveFile[]> {
    if (input.query.trim().length === 0 || input.query.length > MAX_QUERY_LENGTH) {
      throw new DriveClientError(
        "INVALID_INPUT",
        "query must be non-empty and within bounds.",
      );
    }
    const maxResults = clamp(
      input.maxResults ?? DEFAULT_MAX_RESULTS,
      1,
      MAX_RESULTS_CAP,
    );
    return this.withDeadline(input.signal, async (signal) => {
      const token = await this.getAccessToken(signal);
      const url = new URL("/drive/v3/files", this.apiBaseUrl);
      // Drive's `contains` only prefix-matches whole words, so "Expense 2026"
      // wouldn't find a file named "Expense2026" (and vice versa). Splitting
      // the query into tokens and OR-ing them widens that to a loose, casing-
      // and spacing-insensitive match, matching either direction.
      const tokens = looseQueryTokens(input.query);
      const nameClauses = (tokens.length > 0 ? tokens : [input.query])
        .map((token) => `name contains '${escapeDriveQueryLiteral(token)}'`)
        .join(" or ");
      url.searchParams.set(
        "q",
        `mimeType='application/vnd.google-apps.spreadsheet' and trashed=false and (${nameClauses})`,
      );
      url.searchParams.set("fields", "files(id,name,webViewLink,modifiedTime)");
      url.searchParams.set("orderBy", "modifiedTime desc");
      url.searchParams.set("pageSize", String(maxResults));
      const payload = await this.requestJson(url, token, signal);
      return readDriveFiles(payload);
    });
  }

  private async getAccessToken(signal: AbortSignal): Promise<string> {
    try {
      const token = await this.options.accessTokenProvider.getAccessToken(signal);
      if (!token || token.trim().length === 0) {
        throw new DriveClientError(
          "AUTH",
          "Google authentication did not return an access token.",
        );
      }
      return token;
    } catch (error: unknown) {
      if (error instanceof DriveClientError) throw error;
      signal.throwIfAborted();
      throw new DriveClientError("AUTH", "Google Drive authentication failed.");
    }
  }

  private async requestJson(
    url: URL,
    token: string,
    signal: AbortSignal,
  ): Promise<unknown> {
    const response = await this.fetchFunction(url, {
      method: "GET",
      headers: { accept: "application/json", authorization: `Bearer ${token}` },
      signal,
    });
    if (!response.ok) {
      await discardBody(response);
      if (response.status === 401 || response.status === 403) {
        throw new DriveClientError(
          "AUTH",
          "Google Drive rejected the configured credentials, or the granted scope does not permit listing files.",
        );
      }
      throw new DriveClientError(
        "UNAVAILABLE",
        `Google Drive returned HTTP status ${response.status}.`,
      );
    }
    try {
      return await readBoundedGoogleSheetsJson(response, signal);
    } catch (error: unknown) {
      throw new DriveClientError(
        "INVALID_RESPONSE",
        "Google Drive returned an unreadable response.",
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
      () => deadline.abort(new Error("Google Drive deadline exceeded.")),
      this.options.requestTimeoutMs,
    );
    timeout.unref();

    try {
      return await operation(signal);
    } catch (error: unknown) {
      if (error instanceof DriveClientError) throw error;
      if (callerSignal?.aborted) {
        throw new DriveClientError(
          "CANCELLED",
          "The Google Drive operation was cancelled.",
          { cause: error },
        );
      }
      if (deadline.signal.aborted) {
        throw new DriveClientError(
          "TIMEOUT",
          `Google Drive did not respond within ${this.options.requestTimeoutMs}ms.`,
          { cause: error },
        );
      }
      throw new DriveClientError(
        "UNAVAILABLE",
        "The Google Drive operation could not be completed.",
        { cause: error },
      );
    } finally {
      clearTimeout(timeout);
    }
  }
}

/** Maps a thrown DriveClientError to a skill failure code/message; rethrows anything else. */
export function driveErrorToFailure(
  error: unknown,
): { readonly code: string; readonly message: string } {
  if (!(error instanceof DriveClientError)) throw error;
  switch (error.failure) {
    case "INVALID_INPUT":
      return { code: "DRIVE_INVALID_INPUT", message: error.message };
    case "AUTH":
      return { code: "DRIVE_AUTH_FAILED", message: error.message };
    case "TIMEOUT":
      return { code: "DRIVE_TIMEOUT", message: "Google Drive did not respond in time." };
    case "INVALID_RESPONSE":
      return {
        code: "DRIVE_INVALID_RESPONSE",
        message: "Google Drive returned an unexpected response.",
      };
    default:
      return {
        code: "DRIVE_UNAVAILABLE",
        message: "Google Drive could not complete the request.",
      };
  }
}

function readDriveFiles(payload: unknown): readonly DriveFile[] {
  if (!isRecord(payload) || !Array.isArray(payload.files)) {
    throw new DriveClientError(
      "INVALID_RESPONSE",
      "Google Drive returned an invalid file listing.",
    );
  }
  return payload.files.map((file: unknown) => {
    if (
      !isRecord(file) ||
      typeof file.id !== "string" ||
      typeof file.name !== "string"
    ) {
      throw new DriveClientError(
        "INVALID_RESPONSE",
        "Google Drive returned an invalid file entry.",
      );
    }
    return {
      id: file.id,
      name: file.name,
      url:
        typeof file.webViewLink === "string"
          ? file.webViewLink
          : `https://docs.google.com/spreadsheets/d/${file.id}`,
      modifiedTime:
        typeof file.modifiedTime === "string" ? file.modifiedTime : "",
    };
  });
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, Math.trunc(value)));
}

/**
 * Splits a query into words, also breaking at letter/digit boundaries (so
 * "Expense2026" tokenizes the same as "Expense 2026"), for a loose,
 * spacing-insensitive Drive search. Each token still gets its own `contains`
 * clause, so casing is handled by Drive's own case-insensitive matching.
 */
function looseQueryTokens(query: string): string[] {
  return query
    .split(
      /[^\p{L}\p{N}]+|(?<=\p{L})(?=\p{N})|(?<=\p{N})(?=\p{L})/gu,
    )
    .map((token) => token.trim())
    .filter((token) => token.length > 0);
}

function escapeDriveQueryLiteral(value: string): string {
  return value.replace(/[\\']/g, (match) => `\\${match}`);
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
