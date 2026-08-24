export type ChatRole = "system" | "user" | "assistant";

export interface ChatMessage {
  readonly role: ChatRole;
  readonly content: string;
  /** Base64-encoded image bytes (no data: URI prefix), for a vision-capable model. */
  readonly images?: readonly string[];
}

export interface ChatInput {
  readonly messages: readonly ChatMessage[];
  readonly responseFormat?: "json" | Readonly<Record<string, unknown>>;
  /** Provider-default sampling temperature is used when omitted. */
  readonly temperature?: number;
  readonly signal?: AbortSignal;
}

export interface ChatResult {
  readonly content: string;
  /** Accumulated reasoning text, when the model/provider produced any. */
  readonly thinking?: string;
}

export interface ChatChunk {
  readonly content: string;
  /** This chunk's reasoning delta, when the model/provider produced any. */
  readonly thinking?: string;
}

export interface AIProvider {
  chat(input: ChatInput): Promise<ChatResult>;
  streamChat(input: ChatInput): AsyncIterable<ChatChunk>;
}

export type AIProviderFailure =
  | "UNAVAILABLE"
  | "TIMEOUT"
  | "CANCELLED"
  | "UPSTREAM_ERROR"
  | "INVALID_RESPONSE";

export class AIProviderError extends Error {
  override readonly name = "AIProviderError";

  constructor(
    readonly failure: AIProviderFailure,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
  }
}
