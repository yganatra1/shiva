import { z } from "zod";

import { MutualFundError } from "../errors";

const DEFAULT_USER_AGENT = "Shiva/0.3 finance-manager";
const TRANSIENT_STATUS = new Set([429, 500, 502, 503, 504]);

export interface MfApiClientOptions {
  readonly baseUrl: string;
  readonly timeoutMs: number;
  readonly maxRetries: number;
  readonly userAgent?: string;
  readonly fetchFunction?: typeof fetch;
}

const schemeListItemSchema = z
  .object({
    schemeCode: z.number().int().positive(),
    schemeName: z.string().min(1),
    isinGrowth: z.string().nullable().optional(),
    isinDivReinvestment: z.string().nullable().optional(),
  })
  .passthrough();

const schemeListSchema = z.array(schemeListItemSchema);

const navRecordSchema = z
  .object({
    date: z.string().min(8),
    nav: z.union([z.string(), z.number()]),
  })
  .passthrough();

const schemeHistorySchema = z
  .object({
    status: z.string().optional(),
    meta: z
      .object({
        fund_house: z.string().optional(),
        scheme_type: z.string().optional(),
        scheme_category: z.string().optional(),
        scheme_code: z.number().int().positive(),
        scheme_name: z.string().min(1),
        isin_growth: z.string().nullable().optional(),
        isin_div_reinvestment: z.string().nullable().optional(),
      })
      .passthrough(),
    data: z.array(navRecordSchema),
  })
  .passthrough();

export type MfApiSchemeListItem = z.infer<typeof schemeListItemSchema>;
export type MfApiSchemeHistory = z.infer<typeof schemeHistorySchema>;

/**
 * HTTP client for https://api.mfapi.in. Callers never pass user-controlled
 * path segments; scheme codes are validated as positive integers first.
 */
export class MfApiClient {
  private readonly baseUrl: URL;
  private readonly fetchFunction: typeof fetch;
  private readonly timeoutMs: number;
  private readonly maxRetries: number;
  private readonly userAgent: string;

  constructor(options: MfApiClientOptions) {
    this.baseUrl = assertMfapiBaseUrl(options.baseUrl);
    this.fetchFunction = options.fetchFunction ?? fetch;
    this.timeoutMs = options.timeoutMs;
    this.maxRetries = options.maxRetries;
    this.userAgent = options.userAgent ?? DEFAULT_USER_AGENT;
  }

  async searchSchemes(
    query: string,
    signal?: AbortSignal,
  ): Promise<readonly MfApiSchemeListItem[]> {
    const endpoint = new URL("/mf/search", this.baseUrl);
    endpoint.searchParams.set("q", query);
    const payload = await this.getJson(endpoint, signal);
    const parsed = schemeListSchema.safeParse(payload);
    if (!parsed.success) {
      throw new MutualFundError(
        "MFAPI_INVALID_RESPONSE",
        "MFapi search returned an unexpected response shape.",
      );
    }
    return parsed.data;
  }

  async listSchemes(signal?: AbortSignal): Promise<readonly MfApiSchemeListItem[]> {
    const payload = await this.getJson(new URL("/mf", this.baseUrl), signal);
    const parsed = schemeListSchema.safeParse(payload);
    if (!parsed.success) {
      throw new MutualFundError(
        "MFAPI_INVALID_RESPONSE",
        "MFapi scheme list returned an unexpected response shape.",
      );
    }
    return parsed.data;
  }

  async getSchemeHistory(
    schemeCode: number,
    signal?: AbortSignal,
  ): Promise<MfApiSchemeHistory> {
    if (!Number.isInteger(schemeCode) || schemeCode <= 0) {
      throw new MutualFundError(
        "INVALID_SCHEME_CODE",
        "Scheme codes must be positive integers.",
      );
    }
    const payload = await this.getJson(
      new URL(`/mf/${schemeCode}`, this.baseUrl),
      signal,
    );
    const parsed = schemeHistorySchema.safeParse(payload);
    if (!parsed.success) {
      throw new MutualFundError(
        "MFAPI_INVALID_RESPONSE",
        `MFapi history for scheme ${schemeCode} returned an unexpected response shape.`,
      );
    }
    if (parsed.data.status && parsed.data.status.toUpperCase() !== "SUCCESS") {
      throw new MutualFundError(
        "MFAPI_NOT_FOUND",
        `MFapi reported status ${parsed.data.status} for scheme ${schemeCode}.`,
      );
    }
    return parsed.data;
  }

  async probe(signal?: AbortSignal): Promise<boolean> {
    try {
      await this.searchSchemes("axis", signal);
      return true;
    } catch {
      return false;
    }
  }

  private async getJson(url: URL, signal?: AbortSignal): Promise<unknown> {
    let lastError: unknown;
    const attempts = this.maxRetries + 1;
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      if (signal?.aborted) throw abortError(signal);
      if (attempt > 0) {
        await delay(250 * 2 ** (attempt - 1), signal);
      }
      const deadline = new AbortController();
      const combined = signal
        ? AbortSignal.any([signal, deadline.signal])
        : deadline.signal;
      const timeout = setTimeout(() => deadline.abort(), this.timeoutMs);
      timeout.unref();
      const started = Date.now();
      try {
        const response = await this.fetchFunction(url, {
          method: "GET",
          headers: {
            accept: "application/json",
            "user-agent": this.userAgent,
          },
          signal: combined,
        });
        const latencyMs = Date.now() - started;
        if (response.status === 404) {
          await discardBody(response);
          throw new MutualFundError(
            "MFAPI_NOT_FOUND",
            `MFapi returned HTTP 404 for ${url.pathname}.`,
            { status: 404 },
          );
        }
        if (!response.ok) {
          await discardBody(response);
          const error = new MutualFundError(
            response.status === 429 ? "MFAPI_RATE_LIMITED" : "MFAPI_UNAVAILABLE",
            `MFapi returned HTTP ${response.status} for ${url.pathname} after ${latencyMs}ms.`,
            { status: response.status },
          );
          if (TRANSIENT_STATUS.has(response.status) && attempt < attempts - 1) {
            lastError = error;
            continue;
          }
          throw error;
        }
        try {
          return await response.json();
        } catch (error: unknown) {
          throw new MutualFundError(
            "MFAPI_INVALID_RESPONSE",
            "MFapi returned malformed JSON.",
            { cause: error },
          );
        }
      } catch (error: unknown) {
        if (error instanceof MutualFundError) {
          if (
            (error.code === "MFAPI_UNAVAILABLE" ||
              error.code === "MFAPI_RATE_LIMITED") &&
            attempt < attempts - 1
          ) {
            lastError = error;
            continue;
          }
          throw error;
        }
        if (signal?.aborted) throw error;
        if (deadline.signal.aborted) {
          const timeoutError = new MutualFundError(
            "MFAPI_TIMEOUT",
            `MFapi did not respond within ${this.timeoutMs}ms for ${url.pathname}.`,
            { cause: error },
          );
          if (attempt < attempts - 1) {
            lastError = timeoutError;
            continue;
          }
          throw timeoutError;
        }
        const unavailable = new MutualFundError(
          "MFAPI_UNAVAILABLE",
          `MFapi request for ${url.pathname} failed.`,
          { cause: error },
        );
        if (attempt < attempts - 1) {
          lastError = unavailable;
          continue;
        }
        throw unavailable;
      } finally {
        clearTimeout(timeout);
      }
    }
    throw lastError instanceof Error
      ? lastError
      : new MutualFundError("MFAPI_UNAVAILABLE", "MFapi request failed.");
  }
}

function assertMfapiBaseUrl(value: string): URL {
  const url = new URL(value);
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new Error("FINANCE_MFAPI_BASE_URL must use http or https.");
  }
  if (url.username || url.password || url.search || url.hash) {
    throw new Error("FINANCE_MFAPI_BASE_URL must not contain credentials, a query, or a fragment.");
  }
  if (url.pathname !== "/" && url.pathname !== "") {
    throw new Error("FINANCE_MFAPI_BASE_URL must not contain a path.");
  }
  return url;
}

async function discardBody(response: Response): Promise<void> {
  try {
    await response.arrayBuffer();
  } catch {
    // Body already consumed or aborted.
  }
}

function abortError(signal: AbortSignal): unknown {
  return signal.reason instanceof Error
    ? signal.reason
    : new Error("The MFapi request was cancelled.");
}

async function delay(milliseconds: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return;
  await new Promise<void>((resolve) => {
    const timer = setTimeout(finish, milliseconds);
    signal?.addEventListener("abort", finish, { once: true });
    function finish(): void {
      clearTimeout(timer);
      signal?.removeEventListener("abort", finish);
      resolve();
    }
  });
}
