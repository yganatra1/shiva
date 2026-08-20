export interface WebSearchResult {
  readonly title: string;
  readonly url: string;
  readonly description: string;
}

export interface WebSearchInput {
  readonly query: string;
  readonly count: number;
  readonly signal?: AbortSignal;
}

export interface WebSearchToolPort {
  search(input: WebSearchInput): Promise<readonly WebSearchResult[]>;
}

export interface OpenedWebPage {
  readonly url: string;
  readonly title: string | null;
  readonly content: string;
}

export interface WebOpenInput {
  readonly url: string;
  readonly signal?: AbortSignal;
}

export interface WebOpenToolPort {
  open(input: WebOpenInput): Promise<OpenedWebPage>;
}

export type WebToolFailure =
  | "UNAVAILABLE"
  | "TIMEOUT"
  | "INVALID_RESPONSE"
  | "BLOCKED_URL";

export class WebToolError extends Error {
  override readonly name = "WebToolError";

  constructor(
    readonly failure: WebToolFailure,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
  }
}
