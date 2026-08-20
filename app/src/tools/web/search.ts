import { z } from "zod";

import type {
  WebSearchInput,
  WebSearchResult,
  WebSearchToolPort,
} from "./types.js";
import { WebToolError } from "./types.js";

interface BraveWebSearchToolOptions {
  readonly apiKey: string;
  readonly baseUrl?: string;
  readonly requestTimeoutMs: number;
  readonly fetchFunction?: typeof fetch;
}

const braveResponseSchema = z
  .object({
    web: z
      .object({
        results: z.array(
          z
            .object({
              title: z.string(),
              url: z.string().url(),
              description: z.string().optional(),
              extra_snippets: z.array(z.string()).optional(),
            })
            .passthrough(),
        ),
      })
      .optional(),
  })
  .passthrough();

export class BraveWebSearchTool implements WebSearchToolPort {
  private readonly endpoint: URL;
  private readonly fetchFunction: typeof fetch;

  constructor(private readonly options: BraveWebSearchToolOptions) {
    if (options.apiKey.trim().length === 0) {
      throw new Error("A Brave Search API key is required.");
    }
    this.endpoint = new URL(
      "/res/v1/web/search",
      options.baseUrl ?? "https://api.search.brave.com",
    );
    this.fetchFunction = options.fetchFunction ?? fetch;
  }

  async search(input: WebSearchInput): Promise<readonly WebSearchResult[]> {
    const deadline = new AbortController();
    const signal = input.signal
      ? AbortSignal.any([input.signal, deadline.signal])
      : deadline.signal;
    const timeout = setTimeout(
      () => deadline.abort(),
      this.options.requestTimeoutMs,
    );
    timeout.unref();

    try {
      const endpoint = new URL(this.endpoint);
      endpoint.searchParams.set("q", input.query);
      endpoint.searchParams.set("count", String(input.count));
      endpoint.searchParams.set("search_lang", "en");
      endpoint.searchParams.set("safesearch", "moderate");
      const response = await this.fetchFunction(endpoint, {
        method: "GET",
        headers: {
          accept: "application/json",
          "x-subscription-token": this.options.apiKey,
        },
        signal,
      });
      if (!response.ok) {
        await discardBody(response);
        throw new WebToolError(
          "UNAVAILABLE",
          `Brave Search returned HTTP status ${response.status}.`,
        );
      }

      let payload: unknown;
      try {
        payload = await response.json();
      } catch (error: unknown) {
        throw new WebToolError(
          "INVALID_RESPONSE",
          "Brave Search returned malformed JSON.",
          { cause: error },
        );
      }
      const parsed = braveResponseSchema.safeParse(payload);
      if (!parsed.success) {
        throw new WebToolError(
          "INVALID_RESPONSE",
          "Brave Search returned an unexpected response shape.",
        );
      }

      return (parsed.data.web?.results ?? []).slice(0, input.count).map((item) => ({
        title: normalizeText(item.title),
        url: item.url,
        description: normalizeText(
          [item.description, ...(item.extra_snippets ?? [])]
            .filter((value): value is string => Boolean(value))
            .join(" "),
        ),
      }));
    } catch (error: unknown) {
      if (error instanceof WebToolError) throw error;
      if (deadline.signal.aborted) {
        throw new WebToolError(
          "TIMEOUT",
          "Web search did not respond before its deadline.",
          { cause: error },
        );
      }
      if (input.signal?.aborted) throw error;
      throw new WebToolError(
        "UNAVAILABLE",
        "Web search could not be completed.",
        { cause: error },
      );
    } finally {
      clearTimeout(timeout);
    }
  }
}

function normalizeText(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

async function discardBody(response: Response): Promise<void> {
  try {
    await response.body?.cancel();
  } catch {
    // The sanitized upstream status is already the actionable failure.
  }
}
