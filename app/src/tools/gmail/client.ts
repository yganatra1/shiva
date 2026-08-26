import type { GoogleAccessTokenProvider } from "../expenses/google-sheets";
import { readBoundedGoogleSheetsJson } from "../expenses/google-sheets";

export type { GoogleAccessTokenProvider } from "../expenses/google-sheets";

export type GmailClientFailure =
  | "INVALID_INPUT"
  | "AUTH"
  | "UNAVAILABLE"
  | "TIMEOUT"
  | "CANCELLED"
  | "INVALID_RESPONSE";

export class GmailClientError extends Error {
  override readonly name = "GmailClientError";

  constructor(
    readonly failure: GmailClientFailure,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
  }
}

export interface GmailMessageSummary {
  readonly id: string;
  readonly threadId: string;
  readonly subject: string;
  readonly from: string;
  readonly date: string;
  readonly snippet: string;
}

export interface GmailMessage extends GmailMessageSummary {
  readonly to: string;
  /** The RFC 2822 `Message-ID` header, distinct from Gmail's own `id` — needed to reply in-thread. */
  readonly messageIdHeader: string | null;
  readonly body: string;
}

export interface SearchMessagesInput {
  readonly query: string;
  readonly maxResults?: number;
  readonly signal?: AbortSignal;
}

export interface GetMessageInput {
  readonly messageId: string;
  readonly signal?: AbortSignal;
}

export interface SendMessageInput {
  readonly to: string;
  readonly subject: string;
  readonly body: string;
  readonly signal?: AbortSignal;
}

export interface ReplyMessageInput {
  readonly threadId: string;
  readonly to: string;
  readonly subject: string;
  readonly body: string;
  /** The original message's `Message-ID` header, from GmailMessage.messageIdHeader. */
  readonly inReplyTo?: string;
  readonly signal?: AbortSignal;
}

export interface SentMessage {
  readonly id: string;
  readonly threadId: string;
}

export interface GoogleGmailClientOptions {
  readonly accessTokenProvider: GoogleAccessTokenProvider;
  readonly requestTimeoutMs: number;
  readonly apiBaseUrl?: string;
  readonly fetchFunction?: typeof fetch;
}

const DEFAULT_API_BASE_URL = "https://gmail.googleapis.com";
const DEFAULT_MAX_RESULTS = 5;
const MAX_RESULTS_CAP = 10;
const MAX_QUERY_LENGTH = 300;
const MAX_RECIPIENTS_LENGTH = 500;
const MAX_SUBJECT_LENGTH = 500;
const MAX_BODY_LENGTH = 50_000;
const GMAIL_MESSAGE_ID = /^[A-Za-z0-9]{1,50}$/;

/**
 * Thin adapter over the Gmail REST API for search/read/send/reply. Read
 * operations resolve message metadata + body server-side so the skill layer
 * never has to parse MIME payloads itself.
 */
export class GoogleGmailClient {
  private readonly apiBaseUrl: URL;
  private readonly fetchFunction: typeof fetch;

  constructor(private readonly options: GoogleGmailClientOptions) {
    this.apiBaseUrl = new URL(options.apiBaseUrl ?? DEFAULT_API_BASE_URL);
    this.fetchFunction = options.fetchFunction ?? fetch;
    if (
      !Number.isFinite(options.requestTimeoutMs) ||
      options.requestTimeoutMs <= 0
    ) {
      throw new RangeError("Gmail requestTimeoutMs must be positive.");
    }
  }

  async searchMessages(
    input: SearchMessagesInput,
  ): Promise<readonly GmailMessageSummary[]> {
    if (input.query.trim().length === 0 || input.query.length > MAX_QUERY_LENGTH) {
      throw new GmailClientError(
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
      const listUrl = new URL("/gmail/v1/users/me/messages", this.apiBaseUrl);
      listUrl.searchParams.set("q", input.query);
      listUrl.searchParams.set("maxResults", String(maxResults));
      const listPayload = await this.requestJson(listUrl, token, signal);
      const ids = readMessageIds(listPayload);
      const summaries = await Promise.all(
        ids.map((id) => this.fetchSummary(id, token, signal)),
      );
      return summaries;
    });
  }

  async getMessage(input: GetMessageInput): Promise<GmailMessage> {
    validateMessageId(input.messageId);
    return this.withDeadline(input.signal, async (signal) => {
      const token = await this.getAccessToken(signal);
      const url = new URL(
        `/gmail/v1/users/me/messages/${encodeURIComponent(input.messageId)}`,
        this.apiBaseUrl,
      );
      url.searchParams.set("format", "full");
      const payload = await this.requestJson(url, token, signal);
      return readFullMessage(payload);
    });
  }

  async send(input: SendMessageInput): Promise<SentMessage> {
    validateRecipients(input.to);
    validateSubjectAndBody(input.subject, input.body);
    return this.withDeadline(input.signal, async (signal) => {
      const token = await this.getAccessToken(signal);
      const raw = encodeMimeMessage({
        to: input.to,
        subject: input.subject,
        body: input.body,
      });
      const url = new URL(
        "/gmail/v1/users/me/messages/send",
        this.apiBaseUrl,
      );
      const payload = await this.requestJson(url, token, signal, {
        method: "POST",
        body: JSON.stringify({ raw }),
      });
      return readSentMessage(payload);
    });
  }

  async reply(input: ReplyMessageInput): Promise<SentMessage> {
    validateMessageId(input.threadId);
    validateRecipients(input.to);
    validateSubjectAndBody(input.subject, input.body);
    return this.withDeadline(input.signal, async (signal) => {
      const token = await this.getAccessToken(signal);
      const raw = encodeMimeMessage({
        to: input.to,
        subject: input.subject,
        body: input.body,
        ...(input.inReplyTo !== undefined ? { inReplyTo: input.inReplyTo } : {}),
      });
      const url = new URL(
        "/gmail/v1/users/me/messages/send",
        this.apiBaseUrl,
      );
      const payload = await this.requestJson(url, token, signal, {
        method: "POST",
        body: JSON.stringify({ raw, threadId: input.threadId }),
      });
      return readSentMessage(payload);
    });
  }

  private async fetchSummary(
    id: string,
    token: string,
    signal: AbortSignal,
  ): Promise<GmailMessageSummary> {
    const url = new URL(
      `/gmail/v1/users/me/messages/${encodeURIComponent(id)}`,
      this.apiBaseUrl,
    );
    url.searchParams.set("format", "metadata");
    url.searchParams.append("metadataHeaders", "Subject");
    url.searchParams.append("metadataHeaders", "From");
    url.searchParams.append("metadataHeaders", "Date");
    const payload = await this.requestJson(url, token, signal);
    return readMessageSummary(payload);
  }

  private async getAccessToken(signal: AbortSignal): Promise<string> {
    try {
      const token = await this.options.accessTokenProvider.getAccessToken(signal);
      if (!token || token.trim().length === 0) {
        throw new GmailClientError(
          "AUTH",
          "Google authentication did not return an access token.",
        );
      }
      return token;
    } catch (error: unknown) {
      if (error instanceof GmailClientError) throw error;
      signal.throwIfAborted();
      throw new GmailClientError("AUTH", "Gmail authentication failed.");
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
        throw new GmailClientError(
          "AUTH",
          "Gmail rejected the configured credentials, or the granted scope does not permit this operation.",
        );
      }
      if (response.status === 400 || response.status === 404) {
        throw new GmailClientError(
          "INVALID_INPUT",
          "The requested Gmail message or query was invalid or not found.",
        );
      }
      throw new GmailClientError(
        "UNAVAILABLE",
        `Gmail returned HTTP status ${response.status}.`,
      );
    }
    try {
      return await readBoundedGoogleSheetsJson(response, signal);
    } catch (error: unknown) {
      throw new GmailClientError(
        "INVALID_RESPONSE",
        "Gmail returned an unreadable response.",
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
      () => deadline.abort(new Error("Gmail deadline exceeded.")),
      this.options.requestTimeoutMs,
    );
    timeout.unref();

    try {
      return await operation(signal);
    } catch (error: unknown) {
      if (error instanceof GmailClientError) throw error;
      if (callerSignal?.aborted) {
        throw new GmailClientError(
          "CANCELLED",
          "The Gmail operation was cancelled.",
          { cause: error },
        );
      }
      if (deadline.signal.aborted) {
        throw new GmailClientError(
          "TIMEOUT",
          `Gmail did not respond within ${this.options.requestTimeoutMs}ms.`,
          { cause: error },
        );
      }
      throw new GmailClientError(
        "UNAVAILABLE",
        "The Gmail operation could not be completed.",
        { cause: error },
      );
    } finally {
      clearTimeout(timeout);
    }
  }
}

/** Maps a thrown GmailClientError to a skill failure code/message; rethrows anything else. */
export function gmailErrorToFailure(
  error: unknown,
): { readonly code: string; readonly message: string } {
  if (!(error instanceof GmailClientError)) throw error;
  switch (error.failure) {
    case "INVALID_INPUT":
      return { code: "GMAIL_INVALID_INPUT", message: error.message };
    case "AUTH":
      return { code: "GMAIL_AUTH_FAILED", message: error.message };
    case "TIMEOUT":
      return { code: "GMAIL_TIMEOUT", message: "Gmail did not respond in time." };
    case "INVALID_RESPONSE":
      return {
        code: "GMAIL_INVALID_RESPONSE",
        message: "Gmail returned an unexpected response.",
      };
    default:
      return {
        code: "GMAIL_UNAVAILABLE",
        message: "Gmail could not complete the request.",
      };
  }
}

function validateMessageId(id: string): void {
  if (!GMAIL_MESSAGE_ID.test(id)) {
    throw new GmailClientError(
      "INVALID_INPUT",
      "messageId/threadId is not a valid Gmail resource ID.",
    );
  }
}

function validateRecipients(to: string): void {
  if (to.trim().length === 0 || to.length > MAX_RECIPIENTS_LENGTH) {
    throw new GmailClientError(
      "INVALID_INPUT",
      "to must be non-empty and within bounds.",
    );
  }
}

function validateSubjectAndBody(subject: string, body: string): void {
  if (subject.length > MAX_SUBJECT_LENGTH) {
    throw new GmailClientError("INVALID_INPUT", "subject exceeds the length limit.");
  }
  if (body.trim().length === 0 || body.length > MAX_BODY_LENGTH) {
    throw new GmailClientError(
      "INVALID_INPUT",
      "body must be non-empty and within bounds.",
    );
  }
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, Math.trunc(value)));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readMessageIds(payload: unknown): readonly string[] {
  if (!isRecord(payload)) {
    throw new GmailClientError(
      "INVALID_RESPONSE",
      "Gmail returned an invalid search response.",
    );
  }
  const messages = payload.messages;
  if (messages === undefined) return [];
  if (!Array.isArray(messages)) {
    throw new GmailClientError(
      "INVALID_RESPONSE",
      "Gmail returned an invalid message listing.",
    );
  }
  return messages
    .filter(isRecord)
    .map((message) => message.id)
    .filter((id): id is string => typeof id === "string");
}

function readHeader(payload: Record<string, unknown>, name: string): string {
  const headers = isRecord(payload.payload) ? payload.payload.headers : undefined;
  if (!Array.isArray(headers)) return "";
  const header = headers.find(
    (candidate) =>
      isRecord(candidate) &&
      typeof candidate.name === "string" &&
      candidate.name.toLowerCase() === name.toLowerCase(),
  );
  return isRecord(header) && typeof header.value === "string" ? header.value : "";
}

function readMessageSummary(payload: unknown): GmailMessageSummary {
  if (
    !isRecord(payload) ||
    typeof payload.id !== "string" ||
    typeof payload.threadId !== "string"
  ) {
    throw new GmailClientError(
      "INVALID_RESPONSE",
      "Gmail returned an invalid message.",
    );
  }
  return {
    id: payload.id,
    threadId: payload.threadId,
    subject: readHeader(payload, "Subject"),
    from: readHeader(payload, "From"),
    date: readHeader(payload, "Date"),
    snippet: typeof payload.snippet === "string" ? payload.snippet : "",
  };
}

function readFullMessage(payload: unknown): GmailMessage {
  const summary = readMessageSummary(payload);
  const record = payload as Record<string, unknown>;
  const messageIdHeader = readHeader(record, "Message-ID") || null;
  const to = readHeader(record, "To");
  const body = isRecord(record.payload) ? extractPlainTextBody(record.payload) : "";
  return { ...summary, to, messageIdHeader, body };
}

function extractPlainTextBody(part: Record<string, unknown>): string {
  const htmlFallback = findBodyByMimeType(part, "text/html");
  const plain = findBodyByMimeType(part, "text/plain");
  if (plain !== undefined) return plain;
  if (htmlFallback !== undefined) return stripHtml(htmlFallback);
  return "";
}

function findBodyByMimeType(
  part: Record<string, unknown>,
  mimeType: string,
): string | undefined {
  if (part.mimeType === mimeType && isRecord(part.body) && typeof part.body.data === "string") {
    return decodeBase64Url(part.body.data);
  }
  const parts = part.parts;
  if (Array.isArray(parts)) {
    for (const child of parts) {
      if (isRecord(child)) {
        const found = findBodyByMimeType(child, mimeType);
        if (found !== undefined) return found;
      }
    }
  }
  return undefined;
}

function stripHtml(html: string): string {
  return html
    .replace(/<(script|style)[^>]*>[\s\S]*?<\/\1>/gi, "")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function decodeBase64Url(data: string): string {
  return Buffer.from(data, "base64url").toString("utf-8");
}

function readSentMessage(payload: unknown): SentMessage {
  if (
    !isRecord(payload) ||
    typeof payload.id !== "string" ||
    typeof payload.threadId !== "string"
  ) {
    throw new GmailClientError(
      "INVALID_RESPONSE",
      "Gmail did not confirm the sent message.",
    );
  }
  return { id: payload.id, threadId: payload.threadId };
}

function encodeMimeMessage(input: {
  readonly to: string;
  readonly subject: string;
  readonly body: string;
  readonly inReplyTo?: string;
}): string {
  const headers = [
    `To: ${input.to}`,
    `Subject: ${input.subject}`,
    ...(input.inReplyTo
      ? [`In-Reply-To: ${input.inReplyTo}`, `References: ${input.inReplyTo}`]
      : []),
    "Content-Type: text/plain; charset=UTF-8",
    "MIME-Version: 1.0",
  ];
  const message = `${headers.join("\r\n")}\r\n\r\n${input.body}`;
  return Buffer.from(message, "utf-8").toString("base64url");
}

async function discardBody(response: Response): Promise<void> {
  try {
    await response.body?.cancel();
  } catch {
    // Preserve the sanitized status classification.
  }
}
