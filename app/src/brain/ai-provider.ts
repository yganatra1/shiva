export type ChatRole = "system" | "user" | "assistant";

export interface ChatMessage {
  readonly role: ChatRole;
  readonly content: string;
}

export interface ChatInput {
  readonly messages: readonly ChatMessage[];
  readonly responseFormat?: "json" | Readonly<Record<string, unknown>>;
  readonly signal?: AbortSignal;
}

export interface ChatResult {
  readonly content: string;
}

export interface ChatChunk {
  readonly content: string;
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
