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
  readonly mimeType: string;
  readonly url: string;
  readonly modifiedTime: string;
}

export interface FindSpreadsheetsInput {
  readonly query: string;
  readonly maxResults?: number;
  readonly signal?: AbortSignal;
}

export interface ListFilesInput {
  /** When given, only files whose name matches this query are returned. Omit to browse the whole Drive. */
  readonly query?: string;
  readonly maxResults?: number;
  /** From a previous listFiles() call's nextPageToken, to continue browsing past the first page. */
  readonly pageToken?: string;
  readonly signal?: AbortSignal;
}

export interface DriveFileListResult {
  readonly files: readonly DriveFile[];
  /** Present when more files exist beyond this page; pass it back in as pageToken to continue. */
  readonly nextPageToken?: string;
}

export interface ReadFileInput {
  readonly fileId: string;
  readonly signal?: AbortSignal;
}

export interface DriveFileContent {
  readonly name: string;
  readonly mimeType: string;
  readonly content: string;
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
const LIST_DEFAULT_MAX_RESULTS = 25;
const LIST_MAX_RESULTS_CAP = 100;
const MAX_PAGE_TOKEN_LENGTH = 2_000;
const GOOGLE_RESOURCE_ID_PATTERN = /^[A-Za-z0-9_-]{5,256}$/;
/** Caps a read Drive file's decoded text so one call can't pull an unbounded body into memory. */
const MAX_FILE_CONTENT_BYTES = 2_000_000;
/** Google-native document types have no raw bytes; export them as plain text/CSV instead. */
const GOOGLE_NATIVE_EXPORT_MIME_TYPES: Readonly<Record<string, string>> = {
  "application/vnd.google-apps.document": "text/plain",
  "application/vnd.google-apps.spreadsheet": "text/csv",
  "application/vnd.google-apps.presentation": "text/plain",
};

/**
 * Adapter over the Drive v3 API: browse/search files by name (listFiles),
 * find spreadsheets specifically (findSpreadsheets), and read a file's
 * content (readFile). Read-only metadata + content — writing/editing sheet
 * *values* still goes through GoogleSheetsClient's separate `spreadsheets`
 * scope, never through this client.
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

  /**
   * Finds a user's own spreadsheets by name, so a skill that created a sheet
   * earlier (or the user made one manually) can be found again without
   * depending on conversational memory retaining its raw ID. Unlike
   * listFiles, this always restricts to the Sheets mimeType and always
   * requires a query — it has no "browse everything" mode.
   */
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
      url.searchParams.set(
        "q",
        `mimeType='application/vnd.google-apps.spreadsheet' and ${buildDriveQuery(input.query)}`,
      );
      url.searchParams.set(
        "fields",
        "files(id,name,mimeType,webViewLink,modifiedTime)",
      );
      url.searchParams.set("orderBy", "modifiedTime desc");
      url.searchParams.set("pageSize", String(maxResults));
      const payload = await this.requestJson(url, token, signal);
      return readDriveFiles(payload);
    });
  }

  /**
   * Lists Drive files, most recently modified first. With no query, this
   * browses the whole Drive (paginated via pageToken/nextPageToken, since one
   * page never covers an entire Drive); with a query, the same call narrows
   * to files whose name matches it — one implementation serves both listing
   * and searching rather than two near-duplicate methods.
   */
  async listFiles(input: ListFilesInput = {}): Promise<DriveFileListResult> {
    if (input.query !== undefined && input.query.length > MAX_QUERY_LENGTH) {
      throw new DriveClientError("INVALID_INPUT", "query exceeds the length limit.");
    }
    if (input.pageToken !== undefined && input.pageToken.length > MAX_PAGE_TOKEN_LENGTH) {
      throw new DriveClientError("INVALID_INPUT", "pageToken exceeds the length limit.");
    }
    const maxResults = clamp(
      input.maxResults ?? LIST_DEFAULT_MAX_RESULTS,
      1,
      LIST_MAX_RESULTS_CAP,
    );
    return this.withDeadline(input.signal, async (signal) => {
      const token = await this.getAccessToken(signal);
      const url = new URL("/drive/v3/files", this.apiBaseUrl);
      url.searchParams.set("q", buildDriveQuery(input.query));
      url.searchParams.set(
        "fields",
        "nextPageToken,files(id,name,mimeType,webViewLink,modifiedTime)",
      );
      url.searchParams.set("orderBy", "modifiedTime desc");
      url.searchParams.set("pageSize", String(maxResults));
      if (input.pageToken) url.searchParams.set("pageToken", input.pageToken);
      const payload = await this.requestJson(url, token, signal);
      return readDriveFileList(payload);
    });
  }

  /**
   * Reads a file's content. Google-native docs (Docs/Sheets/Slides) have no
   * raw bytes, so they're exported as text/CSV; everything else is fetched
   * as-is via alt=media and decoded as UTF-8 text.
   */
  async readFile(input: ReadFileInput): Promise<DriveFileContent> {
    if (!GOOGLE_RESOURCE_ID_PATTERN.test(input.fileId)) {
      throw new DriveClientError("INVALID_INPUT", "fileId is not a valid Google resource ID.");
    }
    return this.withDeadline(input.signal, async (signal) => {
      const token = await this.getAccessToken(signal);
      const metadataUrl = new URL(
        `/drive/v3/files/${encodeURIComponent(input.fileId)}`,
        this.apiBaseUrl,
      );
      metadataUrl.searchParams.set("fields", "name,mimeType");
      const metadata = await this.requestJson(metadataUrl, token, signal);
      const { name, mimeType } = readFileMetadata(metadata);

      const exportMimeType = GOOGLE_NATIVE_EXPORT_MIME_TYPES[mimeType];
      const contentUrl = new URL(
        `/drive/v3/files/${encodeURIComponent(input.fileId)}${exportMimeType ? "/export" : ""}`,
        this.apiBaseUrl,
      );
      if (exportMimeType) {
        contentUrl.searchParams.set("mimeType", exportMimeType);
      } else {
        contentUrl.searchParams.set("alt", "media");
      }
      const content = await this.requestText(contentUrl, token, signal);
      return { name, mimeType, content };
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

  private async requestText(
    url: URL,
    token: string,
    signal: AbortSignal,
  ): Promise<string> {
    const response = await this.fetchFunction(url, {
      method: "GET",
      headers: { authorization: `Bearer ${token}` },
      signal,
    });
    if (!response.ok) {
      await discardBody(response);
      if (response.status === 401 || response.status === 403) {
        throw new DriveClientError(
          "AUTH",
          "Google Drive rejected the configured credentials, or the granted scope does not permit reading this file.",
        );
      }
      if (response.status === 404) {
        throw new DriveClientError("INVALID_INPUT", "The requested Drive file was not found.");
      }
      throw new DriveClientError(
        "UNAVAILABLE",
        `Google Drive returned HTTP status ${response.status}.`,
      );
    }
    const declaredLength = response.headers.get("content-length");
    if (declaredLength !== null && Number(declaredLength) > MAX_FILE_CONTENT_BYTES) {
      await discardBody(response);
      throw new DriveClientError("INVALID_RESPONSE", "The Drive file content exceeded the size limit.");
    }
    let buffer: ArrayBuffer;
    try {
      buffer = await response.arrayBuffer();
    } catch (error: unknown) {
      throw new DriveClientError(
        "INVALID_RESPONSE",
        "Google Drive returned an unreadable file body.",
        { cause: error },
      );
    }
    if (buffer.byteLength > MAX_FILE_CONTENT_BYTES) {
      throw new DriveClientError("INVALID_RESPONSE", "The Drive file content exceeded the size limit.");
    }
    return Buffer.from(buffer).toString("utf-8");
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
      mimeType: typeof file.mimeType === "string" ? file.mimeType : "",
      url:
        typeof file.webViewLink === "string"
          ? file.webViewLink
          : `https://docs.google.com/spreadsheets/d/${file.id}`,
      modifiedTime:
        typeof file.modifiedTime === "string" ? file.modifiedTime : "",
    };
  });
}

function readDriveFileList(payload: unknown): DriveFileListResult {
  const files = readDriveFiles(payload);
  const nextPageToken = isRecord(payload) && typeof payload.nextPageToken === "string"
    ? payload.nextPageToken
    : undefined;
  return nextPageToken ? { files, nextPageToken } : { files };
}

function readFileMetadata(payload: unknown): { readonly name: string; readonly mimeType: string } {
  if (
    !isRecord(payload) ||
    typeof payload.name !== "string" ||
    typeof payload.mimeType !== "string"
  ) {
    throw new DriveClientError(
      "INVALID_RESPONSE",
      "Google Drive returned invalid file metadata.",
    );
  }
  return { name: payload.name, mimeType: payload.mimeType };
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

/** Builds the Drive `q` filter: always excludes trash, and narrows by name when a query is given. */
function buildDriveQuery(query: string | undefined): string {
  if (!query || query.trim().length === 0) return "trashed=false";
  const tokens = looseQueryTokens(query);
  const nameClauses = (tokens.length > 0 ? tokens : [query])
    .map((token) => `name contains '${escapeDriveQueryLiteral(token)}'`)
    .join(" or ");
  return `trashed=false and (${nameClauses})`;
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
