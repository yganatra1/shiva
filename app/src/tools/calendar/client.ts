import type { GoogleAccessTokenProvider } from "../expenses/google-sheets";
import { readBoundedGoogleSheetsJson } from "../expenses/google-sheets";

export type { GoogleAccessTokenProvider } from "../expenses/google-sheets";

export type CalendarClientFailure =
  | "INVALID_INPUT"
  | "AUTH"
  | "UNAVAILABLE"
  | "TIMEOUT"
  | "CANCELLED"
  | "INVALID_RESPONSE";

export class CalendarClientError extends Error {
  override readonly name = "CalendarClientError";

  constructor(
    readonly failure: CalendarClientFailure,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
  }
}

export interface CalendarEventTime {
  readonly dateTime: string;
  readonly timeZone?: string;
}

export interface CalendarEvent {
  readonly id: string;
  readonly summary: string;
  readonly description: string | null;
  readonly start: string;
  readonly end: string;
  readonly attendees: readonly string[];
  readonly htmlLink: string | null;
}

export interface ListEventsInput {
  readonly timeMin: string;
  readonly timeMax: string;
  readonly query?: string;
  readonly maxResults?: number;
  readonly signal?: AbortSignal;
}

export interface CreateEventInput {
  readonly summary: string;
  readonly start: CalendarEventTime;
  readonly end: CalendarEventTime;
  readonly description?: string;
  readonly attendees?: readonly string[];
  readonly signal?: AbortSignal;
}

export interface UpdateEventInput {
  readonly eventId: string;
  readonly summary?: string;
  readonly start?: CalendarEventTime;
  readonly end?: CalendarEventTime;
  readonly description?: string;
  readonly attendees?: readonly string[];
  readonly signal?: AbortSignal;
}

export interface DeleteEventInput {
  readonly eventId: string;
  readonly signal?: AbortSignal;
}

export interface GoogleCalendarClientOptions {
  readonly accessTokenProvider: GoogleAccessTokenProvider;
  readonly requestTimeoutMs: number;
  readonly apiBaseUrl?: string;
  readonly fetchFunction?: typeof fetch;
}

const DEFAULT_API_BASE_URL = "https://www.googleapis.com/calendar/v3";
const DEFAULT_MAX_RESULTS = 10;
const MAX_RESULTS_CAP = 50;
const MAX_QUERY_LENGTH = 200;
const MAX_SUMMARY_LENGTH = 500;
const MAX_DESCRIPTION_LENGTH = 8_000;
const MAX_ATTENDEES = 50;
const CALENDAR_EVENT_ID = /^[A-Za-z0-9_-]{1,1024}$/;

/**
 * Adapter over the Google Calendar API's "primary" calendar — the user's own
 * default calendar. Multi-calendar support isn't in scope; every operation
 * targets `calendars/primary`.
 */
export class GoogleCalendarClient {
  private readonly apiBaseUrl: URL;
  private readonly fetchFunction: typeof fetch;

  constructor(private readonly options: GoogleCalendarClientOptions) {
    this.apiBaseUrl = new URL(
      ensureTrailingSlash(options.apiBaseUrl ?? DEFAULT_API_BASE_URL),
    );
    this.fetchFunction = options.fetchFunction ?? fetch;
    if (
      !Number.isFinite(options.requestTimeoutMs) ||
      options.requestTimeoutMs <= 0
    ) {
      throw new RangeError("Google Calendar requestTimeoutMs must be positive.");
    }
  }

  async listEvents(input: ListEventsInput): Promise<readonly CalendarEvent[]> {
    validateIsoDate(input.timeMin, "timeMin");
    validateIsoDate(input.timeMax, "timeMax");
    if (input.query !== undefined && input.query.length > MAX_QUERY_LENGTH) {
      throw new CalendarClientError("INVALID_INPUT", "query exceeds the length limit.");
    }
    const maxResults = clamp(
      input.maxResults ?? DEFAULT_MAX_RESULTS,
      1,
      MAX_RESULTS_CAP,
    );
    return this.withDeadline(input.signal, async (signal) => {
      const token = await this.getAccessToken(signal);
      const url = new URL("calendars/primary/events", this.apiBaseUrl);
      url.searchParams.set("timeMin", input.timeMin);
      url.searchParams.set("timeMax", input.timeMax);
      url.searchParams.set("singleEvents", "true");
      url.searchParams.set("orderBy", "startTime");
      url.searchParams.set("maxResults", String(maxResults));
      if (input.query) url.searchParams.set("q", input.query);
      const payload = await this.requestJson(url, token, signal);
      return readEventList(payload);
    });
  }

  async createEvent(input: CreateEventInput): Promise<CalendarEvent> {
    validateSummaryAndDescription(input.summary, input.description);
    validateAttendees(input.attendees);
    return this.withDeadline(input.signal, async (signal) => {
      const token = await this.getAccessToken(signal);
      const url = new URL("calendars/primary/events", this.apiBaseUrl);
      const payload = await this.requestJson(url, token, signal, {
        method: "POST",
        body: JSON.stringify({
          summary: input.summary,
          ...(input.description ? { description: input.description } : {}),
          start: input.start,
          end: input.end,
          ...(input.attendees
            ? { attendees: input.attendees.map((email) => ({ email })) }
            : {}),
        }),
      });
      return readEvent(payload);
    });
  }

  async updateEvent(input: UpdateEventInput): Promise<CalendarEvent> {
    validateEventId(input.eventId);
    validateSummaryAndDescription(input.summary, input.description);
    validateAttendees(input.attendees);
    return this.withDeadline(input.signal, async (signal) => {
      const token = await this.getAccessToken(signal);
      const url = new URL(
        `calendars/primary/events/${encodeURIComponent(input.eventId)}`,
        this.apiBaseUrl,
      );
      const payload = await this.requestJson(url, token, signal, {
        method: "PATCH",
        body: JSON.stringify({
          ...(input.summary !== undefined ? { summary: input.summary } : {}),
          ...(input.description !== undefined
            ? { description: input.description }
            : {}),
          ...(input.start ? { start: input.start } : {}),
          ...(input.end ? { end: input.end } : {}),
          ...(input.attendees
            ? { attendees: input.attendees.map((email) => ({ email })) }
            : {}),
        }),
      });
      return readEvent(payload);
    });
  }

  async deleteEvent(input: DeleteEventInput): Promise<void> {
    validateEventId(input.eventId);
    await this.withDeadline(input.signal, async (signal) => {
      const token = await this.getAccessToken(signal);
      const url = new URL(
        `calendars/primary/events/${encodeURIComponent(input.eventId)}`,
        this.apiBaseUrl,
      );
      await this.requestJson(url, token, signal, { method: "DELETE" }, true);
    });
  }

  private async getAccessToken(signal: AbortSignal): Promise<string> {
    try {
      const token = await this.options.accessTokenProvider.getAccessToken(signal);
      if (!token || token.trim().length === 0) {
        throw new CalendarClientError(
          "AUTH",
          "Google authentication did not return an access token.",
        );
      }
      return token;
    } catch (error: unknown) {
      if (error instanceof CalendarClientError) throw error;
      signal.throwIfAborted();
      throw new CalendarClientError("AUTH", "Google Calendar authentication failed.");
    }
  }

  private async requestJson(
    url: URL,
    token: string,
    signal: AbortSignal,
    init: Pick<RequestInit, "method" | "body"> = {},
    allowEmptyResponse = false,
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
        throw new CalendarClientError(
          "AUTH",
          "Google Calendar rejected the configured credentials, or the granted scope does not permit this operation.",
        );
      }
      if (response.status === 400 || response.status === 404 || response.status === 410) {
        throw new CalendarClientError(
          "INVALID_INPUT",
          "The requested calendar event was invalid or not found.",
        );
      }
      throw new CalendarClientError(
        "UNAVAILABLE",
        `Google Calendar returned HTTP status ${response.status}.`,
      );
    }
    if (allowEmptyResponse) {
      await discardBody(response);
      return undefined;
    }
    try {
      return await readBoundedGoogleSheetsJson(response, signal);
    } catch (error: unknown) {
      throw new CalendarClientError(
        "INVALID_RESPONSE",
        "Google Calendar returned an unreadable response.",
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
      () => deadline.abort(new Error("Google Calendar deadline exceeded.")),
      this.options.requestTimeoutMs,
    );
    timeout.unref();

    try {
      return await operation(signal);
    } catch (error: unknown) {
      if (error instanceof CalendarClientError) throw error;
      if (callerSignal?.aborted) {
        throw new CalendarClientError(
          "CANCELLED",
          "The Google Calendar operation was cancelled.",
          { cause: error },
        );
      }
      if (deadline.signal.aborted) {
        throw new CalendarClientError(
          "TIMEOUT",
          `Google Calendar did not respond within ${this.options.requestTimeoutMs}ms.`,
          { cause: error },
        );
      }
      throw new CalendarClientError(
        "UNAVAILABLE",
        "The Google Calendar operation could not be completed.",
        { cause: error },
      );
    } finally {
      clearTimeout(timeout);
    }
  }
}

/** Maps a thrown CalendarClientError to a skill failure code/message; rethrows anything else. */
export function calendarErrorToFailure(
  error: unknown,
): { readonly code: string; readonly message: string } {
  if (!(error instanceof CalendarClientError)) throw error;
  switch (error.failure) {
    case "INVALID_INPUT":
      return { code: "CALENDAR_INVALID_INPUT", message: error.message };
    case "AUTH":
      return { code: "CALENDAR_AUTH_FAILED", message: error.message };
    case "TIMEOUT":
      return {
        code: "CALENDAR_TIMEOUT",
        message: "Google Calendar did not respond in time.",
      };
    case "INVALID_RESPONSE":
      return {
        code: "CALENDAR_INVALID_RESPONSE",
        message: "Google Calendar returned an unexpected response.",
      };
    default:
      return {
        code: "CALENDAR_UNAVAILABLE",
        message: "Google Calendar could not complete the request.",
      };
  }
}

function ensureTrailingSlash(url: string): string {
  return url.endsWith("/") ? url : `${url}/`;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, Math.trunc(value)));
}

function validateIsoDate(value: string, field: string): void {
  if (Number.isNaN(Date.parse(value))) {
    throw new CalendarClientError(
      "INVALID_INPUT",
      `${field} must be a valid ISO-8601 date-time.`,
    );
  }
}

function validateEventId(eventId: string): void {
  if (!CALENDAR_EVENT_ID.test(eventId)) {
    throw new CalendarClientError(
      "INVALID_INPUT",
      "eventId is not a valid Google Calendar resource ID.",
    );
  }
}

function validateSummaryAndDescription(
  summary: string | undefined,
  description: string | undefined,
): void {
  if (summary !== undefined && (summary.trim().length === 0 || summary.length > MAX_SUMMARY_LENGTH)) {
    throw new CalendarClientError(
      "INVALID_INPUT",
      "summary must be non-empty and within bounds.",
    );
  }
  if (description !== undefined && description.length > MAX_DESCRIPTION_LENGTH) {
    throw new CalendarClientError(
      "INVALID_INPUT",
      "description exceeds the length limit.",
    );
  }
}

function validateAttendees(attendees: readonly string[] | undefined): void {
  if (attendees === undefined) return;
  if (attendees.length > MAX_ATTENDEES) {
    throw new CalendarClientError(
      "INVALID_INPUT",
      `attendees must contain at most ${MAX_ATTENDEES} entries.`,
    );
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readEventTime(value: unknown): string {
  if (!isRecord(value)) return "";
  if (typeof value.dateTime === "string") return value.dateTime;
  if (typeof value.date === "string") return value.date;
  return "";
}

function readEvent(payload: unknown): CalendarEvent {
  if (!isRecord(payload) || typeof payload.id !== "string") {
    throw new CalendarClientError(
      "INVALID_RESPONSE",
      "Google Calendar returned an invalid event.",
    );
  }
  const attendees = Array.isArray(payload.attendees)
    ? payload.attendees
        .filter(isRecord)
        .map((attendee) => attendee.email)
        .filter((email): email is string => typeof email === "string")
    : [];
  return {
    id: payload.id,
    summary: typeof payload.summary === "string" ? payload.summary : "",
    description: typeof payload.description === "string" ? payload.description : null,
    start: readEventTime(payload.start),
    end: readEventTime(payload.end),
    attendees,
    htmlLink: typeof payload.htmlLink === "string" ? payload.htmlLink : null,
  };
}

function readEventList(payload: unknown): readonly CalendarEvent[] {
  if (!isRecord(payload) || !Array.isArray(payload.items)) {
    throw new CalendarClientError(
      "INVALID_RESPONSE",
      "Google Calendar returned an invalid event listing.",
    );
  }
  return payload.items.map((item) => readEvent(item));
}

async function discardBody(response: Response): Promise<void> {
  try {
    await response.body?.cancel();
  } catch {
    // Preserve the sanitized status classification.
  }
}
