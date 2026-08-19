export interface EmbeddingInput {
  readonly text: string;
  readonly signal?: AbortSignal;
}

export interface EmbeddingProvider {
  embed(input: EmbeddingInput): Promise<readonly number[]>;
}

export type EmbeddingProviderFailure =
  | "UNAVAILABLE"
  | "TIMEOUT"
  | "CANCELLED"
  | "UPSTREAM_ERROR"
  | "INVALID_RESPONSE";

export class EmbeddingProviderError extends Error {
  override readonly name = "EmbeddingProviderError";

  constructor(
    readonly failure: EmbeddingProviderFailure,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
  }
}
