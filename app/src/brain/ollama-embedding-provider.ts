import { z } from "zod";

import { EMBEDDING_DIMENSIONS } from "../types/embedding";
import {
  EmbeddingProviderError,
  type EmbeddingInput,
  type EmbeddingProvider,
} from "./embedding-provider";

interface OllamaEmbeddingProviderOptions {
  readonly baseUrl: string;
  readonly model: string;
  readonly requestTimeoutMs: number;
}

const embeddingResponseSchema = z
  .object({
    embeddings: z.array(z.array(z.number().finite())).length(1),
  })
  .passthrough();

export class OllamaEmbeddingProvider implements EmbeddingProvider {
  private readonly endpoint: URL;

  constructor(private readonly options: OllamaEmbeddingProviderOptions) {
    this.endpoint = new URL("/api/embed", options.baseUrl);
  }

  async embed(input: EmbeddingInput): Promise<readonly number[]> {
    const deadlineController = new AbortController();
    const requestSignal = input.signal
      ? AbortSignal.any([deadlineController.signal, input.signal])
      : deadlineController.signal;
    const timeout = setTimeout(
      () => deadlineController.abort(),
      this.options.requestTimeoutMs,
    );
    timeout.unref();

    try {
      const response = await fetch(this.endpoint, {
        method: "POST",
        headers: {
          accept: "application/json",
          "content-type": "application/json",
        },
        body: JSON.stringify({
          model: this.options.model,
          input: input.text,
          dimensions: EMBEDDING_DIMENSIONS,
          truncate: true,
        }),
        signal: requestSignal,
      });

      if (!response.ok) {
        await discardResponseBody(response);
        throw new EmbeddingProviderError(
          "UPSTREAM_ERROR",
          `Ollama returned HTTP status ${response.status} for an embedding request.`,
        );
      }

      const payload = await parseResponse(response, requestSignal);
      const parsed = embeddingResponseSchema.safeParse(payload);
      const embedding = parsed.success ? parsed.data.embeddings[0] : undefined;

      if (!embedding || embedding.length !== EMBEDDING_DIMENSIONS) {
        throw new EmbeddingProviderError(
          "INVALID_RESPONSE",
          `Ollama returned an embedding that was not ${EMBEDDING_DIMENSIONS} dimensions.`,
        );
      }

      return embedding;
    } catch (error: unknown) {
      if (error instanceof EmbeddingProviderError) {
        throw error;
      }

      if (deadlineController.signal.aborted) {
        throw new EmbeddingProviderError(
          "TIMEOUT",
          `Ollama did not return an embedding within ${this.options.requestTimeoutMs}ms.`,
          { cause: error },
        );
      }

      if (input.signal?.aborted) {
        throw new EmbeddingProviderError(
          "CANCELLED",
          "The embedding request was cancelled.",
          { cause: error },
        );
      }

      throw new EmbeddingProviderError(
        "UNAVAILABLE",
        "The Ollama embedding request could not be completed.",
        { cause: error },
      );
    } finally {
      clearTimeout(timeout);
    }
  }
}

async function parseResponse(
  response: Response,
  signal: AbortSignal,
): Promise<unknown> {
  try {
    return await response.json();
  } catch (error: unknown) {
    if (signal.aborted) {
      throw error;
    }

    throw new EmbeddingProviderError(
      "INVALID_RESPONSE",
      "Ollama returned malformed embedding JSON.",
    );
  }
}

async function discardResponseBody(response: Response): Promise<void> {
  try {
    await response.body?.cancel();
  } catch {
    // The upstream status remains the actionable provider failure.
  }
}
