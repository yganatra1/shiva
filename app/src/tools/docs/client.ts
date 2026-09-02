import {
  readBoundedGoogleSheetsJson,
  type GoogleAccessTokenProvider,
} from "../expenses/google-sheets";

export type { GoogleAccessTokenProvider } from "../expenses/google-sheets";

export type DocsClientFailure =
  | "INVALID_INPUT"
  | "AUTH"
  | "UNAVAILABLE"
  | "TIMEOUT"
  | "CANCELLED"
  | "INVALID_RESPONSE";

export class DocsClientError extends Error {
  override readonly name = "DocsClientError";

  constructor(
    readonly failure: DocsClientFailure,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
  }
}

export interface CreateDocumentInput {
  readonly title: string;
  readonly initialText?: string;
  readonly signal?: AbortSignal;
}

export interface CreatedDocument {
  readonly documentId: string;
  readonly title: string;
  readonly url: string;
}

export type UpdateDocumentMode = "append" | "replace";

export interface UpdateDocumentInput {
  readonly documentId: string;
  readonly text: string;
  readonly mode: UpdateDocumentMode;
  readonly signal?: AbortSignal;
}

export interface UpdatedDocument {
  readonly documentId: string;
  readonly mode: UpdateDocumentMode;
}

export interface GoogleDocsClientOptions {
  readonly accessTokenProvider: GoogleAccessTokenProvider;
  readonly requestTimeoutMs: number;
  readonly apiBaseUrl?: string;
  readonly fetchFunction?: typeof fetch;
}

const DEFAULT_API_BASE_URL = "https://docs.googleapis.com";
const MAX_TITLE_LENGTH = 200;
const MAX_TEXT_LENGTH = 100_000;
const GOOGLE_RESOURCE_ID_PATTERN = /^[A-Za-z0-9_-]{5,256}$/;

/**
 * Adapter over the Docs v1 API: create a document (createDocument) and write
 * into an existing one (updateDocument). Finding a doc by name and reading
 * its content already go through GoogleDriveClient (findDocuments/readFile) —
 * this client owns only the write surface Drive can't provide.
 */
export class GoogleDocsClient {
  private readonly apiBaseUrl: URL;
  private readonly fetchFunction: typeof fetch;

  constructor(private readonly options: GoogleDocsClientOptions) {
    this.apiBaseUrl = new URL(options.apiBaseUrl ?? DEFAULT_API_BASE_URL);
    this.fetchFunction = options.fetchFunction ?? fetch;
    if (
      !Number.isFinite(options.requestTimeoutMs) ||
      options.requestTimeoutMs <= 0
    ) {
      throw new RangeError("Google Docs requestTimeoutMs must be positive.");
    }
  }

  async createDocument(input: CreateDocumentInput): Promise<CreatedDocument> {
    if (input.title.trim().length === 0 || input.title.length > MAX_TITLE_LENGTH) {
      throw new DocsClientError(
        "INVALID_INPUT",
        "The document title must be non-empty and within bounds.",
      );
    }
    if (input.initialText !== undefined && input.initialText.length > MAX_TEXT_LENGTH) {
      throw new DocsClientError("INVALID_INPUT", "initialText exceeds the length limit.");
    }
    return this.withDeadline(input.signal, async (signal) => {
      const token = await this.getAccessToken(signal);
      const payload = await this.requestJson(
        new URL("/v1/documents", this.apiBaseUrl),
        token,
        signal,
        { method: "POST", body: JSON.stringify({ title: input.title }) },
      );
      const documentId = readDocumentId(payload);
      if (input.initialText) {
        await this.requestJson(this.batchUpdateUrl(documentId), token, signal, {
          method: "POST",
          body: JSON.stringify({
            requests: [
              { insertText: { endOfSegmentLocation: {}, text: input.initialText } },
            ],
          }),
        });
      }
      return {
        documentId,
        title: input.title,
        url: `https://docs.google.com/document/d/${documentId}/edit`,
      };
    });
  }

  /**
   * append inserts at the end of the document body — no read-before-write
   * needed, since Docs' endOfSegmentLocation resolves the current end index
   * server-side. replace reads the body's current end index first, then
   * deletes the existing content and inserts the new text in one atomic
   * batchUpdate.
   */
  async updateDocument(input: UpdateDocumentInput): Promise<UpdatedDocument> {
    validateDocumentId(input.documentId);
    if (input.text.length === 0 || input.text.length > MAX_TEXT_LENGTH) {
      throw new DocsClientError(
        "INVALID_INPUT",
        "text must be non-empty and within bounds.",
      );
    }
    return this.withDeadline(input.signal, async (signal) => {
      const token = await this.getAccessToken(signal);
      if (input.mode === "append") {
        await this.requestJson(this.batchUpdateUrl(input.documentId), token, signal, {
          method: "POST",
          body: JSON.stringify({
            requests: [
              { insertText: { endOfSegmentLocation: {}, text: input.text } },
            ],
          }),
        });
        return { documentId: input.documentId, mode: "append" as const };
      }
      const endIndex = await this.getBodyEndIndex(input.documentId, token, signal);
      const requests: unknown[] = [];
      if (endIndex > 1) {
        requests.push({
          deleteContentRange: { range: { startIndex: 1, endIndex: endIndex - 1 } },
        });
      }
      requests.push({ insertText: { location: { index: 1 }, text: input.text } });
      await this.requestJson(this.batchUpdateUrl(input.documentId), token, signal, {
        method: "POST",
        body: JSON.stringify({ requests }),
      });
      return { documentId: input.documentId, mode: "replace" as const };
    });
  }

  private async getBodyEndIndex(
    documentId: string,
    token: string,
    signal: AbortSignal,
  ): Promise<number> {
    const url = new URL(
      `/v1/documents/${encodeURIComponent(documentId)}`,
      this.apiBaseUrl,
    );
    url.searchParams.set("fields", "body(content(endIndex))");
    const payload = await this.requestJson(url, token, signal);
    return readBodyEndIndex(payload);
  }

  private batchUpdateUrl(documentId: string): URL {
    return new URL(
      `/v1/documents/${encodeURIComponent(documentId)}:batchUpdate`,
      this.apiBaseUrl,
    );
  }

  private async getAccessToken(signal: AbortSignal): Promise<string> {
    try {
      const token = await this.options.accessTokenProvider.getAccessToken(signal);
      if (!token || token.trim().length === 0) {
        throw new DocsClientError(
          "AUTH",
          "Google authentication did not return an access token.",
        );
      }
      return token;
    } catch (error: unknown) {
      if (error instanceof DocsClientError) throw error;
      signal.throwIfAborted();
      throw new DocsClientError("AUTH", "Google Docs authentication failed.");
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
      const detail = await readErrorDetail(response);
      if (response.status === 401 || response.status === 403) {
        throw new DocsClientError(
          "AUTH",
          `Google Docs rejected the configured credentials, or the granted scope does not permit this operation.${detail ? ` Google said: ${detail}` : ""}`,
        );
      }
      if (response.status === 400 || response.status === 404) {
        throw new DocsClientError(
          "INVALID_INPUT",
          `The requested document was invalid or not found.${detail ? ` Google said: ${detail}` : ""}`,
        );
      }
      throw new DocsClientError(
        "UNAVAILABLE",
        `Google Docs returned HTTP status ${response.status}.${detail ? ` Google said: ${detail}` : ""}`,
      );
    }
    try {
      return await readBoundedGoogleSheetsJson(response, signal);
    } catch (error: unknown) {
      throw new DocsClientError(
        "INVALID_RESPONSE",
        "Google Docs returned an unreadable response.",
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
      () => deadline.abort(new Error("Google Docs deadline exceeded.")),
      this.options.requestTimeoutMs,
    );
    timeout.unref();

    try {
      return await operation(signal);
    } catch (error: unknown) {
      if (error instanceof DocsClientError) throw error;
      if (callerSignal?.aborted) {
        throw new DocsClientError(
          "CANCELLED",
          "The Google Docs operation was cancelled.",
          { cause: error },
        );
      }
      if (deadline.signal.aborted) {
        throw new DocsClientError(
          "TIMEOUT",
          `Google Docs did not respond within ${this.options.requestTimeoutMs}ms.`,
          { cause: error },
        );
      }
      throw new DocsClientError(
        "UNAVAILABLE",
        "The Google Docs operation could not be completed.",
        { cause: error },
      );
    } finally {
      clearTimeout(timeout);
    }
  }
}

/** Maps a thrown DocsClientError to a skill failure code/message; rethrows anything else. */
export function docsErrorToFailure(
  error: unknown,
): { readonly code: string; readonly message: string } {
  if (!(error instanceof DocsClientError)) throw error;
  switch (error.failure) {
    case "INVALID_INPUT":
      return { code: "DOCS_INVALID_INPUT", message: error.message };
    case "AUTH":
      return { code: "DOCS_AUTH_FAILED", message: error.message };
    case "TIMEOUT":
      return { code: "DOCS_TIMEOUT", message: "Google Docs did not respond in time." };
    case "INVALID_RESPONSE":
      return {
        code: "DOCS_INVALID_RESPONSE",
        message: "Google Docs returned an unexpected response.",
      };
    default:
      return {
        code: "DOCS_UNAVAILABLE",
        message: "Google Docs could not complete the request.",
      };
  }
}

function validateDocumentId(documentId: string): void {
  if (!GOOGLE_RESOURCE_ID_PATTERN.test(documentId)) {
    throw new DocsClientError("INVALID_INPUT", "documentId is not a valid Google resource ID.");
  }
}

function readDocumentId(payload: unknown): string {
  if (!isRecord(payload) || typeof payload.documentId !== "string") {
    throw new DocsClientError(
      "INVALID_RESPONSE",
      "Google Docs did not return a created document ID.",
    );
  }
  return payload.documentId;
}

function readBodyEndIndex(payload: unknown): number {
  if (!isRecord(payload) || !isRecord(payload.body) || !Array.isArray(payload.body.content)) {
    throw new DocsClientError(
      "INVALID_RESPONSE",
      "Google Docs returned an invalid document body.",
    );
  }
  const content = payload.body.content as readonly unknown[];
  const last = content[content.length - 1];
  if (!isRecord(last) || typeof last.endIndex !== "number") {
    throw new DocsClientError(
      "INVALID_RESPONSE",
      "Google Docs returned an invalid document body.",
    );
  }
  return last.endIndex;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const MAX_ERROR_DETAIL_LENGTH = 500;

/**
 * Google's error responses are `{"error":{"message":"...","status":"..."}}`.
 * Surfacing that real reason (invalid scope vs. API not enabled vs. bad
 * grant, etc.) instead of discarding the body is the difference between an
 * actionable failure and an unexplained one classified only by HTTP status.
 */
async function readErrorDetail(response: Response): Promise<string | undefined> {
  let text: string;
  try {
    text = await response.text();
  } catch {
    return undefined;
  }
  if (!text) return undefined;
  try {
    const parsed = JSON.parse(text) as unknown;
    if (isRecord(parsed) && isRecord(parsed.error) && typeof parsed.error.message === "string") {
      return parsed.error.message.slice(0, MAX_ERROR_DETAIL_LENGTH);
    }
  } catch {
    // Not JSON; fall through to raw text below.
  }
  return text.slice(0, MAX_ERROR_DETAIL_LENGTH);
}
