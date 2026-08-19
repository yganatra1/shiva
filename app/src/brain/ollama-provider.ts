import { z } from "zod";

import {
  AIProviderError,
  type AIProvider,
  type ChatInput,
  type ChatResult,
} from "./ai-provider.js";

interface OllamaProviderOptions {
  readonly baseUrl: string;
  readonly model: string;
  readonly contextLength: number;
  readonly keepAlive: string;
  readonly requestTimeoutMs: number;
}

const ollamaResponseSchema = z
  .object({
    done: z.literal(true),
    message: z.object({
      content: z.string(),
    }),
  })
  .passthrough();

export class OllamaProvider implements AIProvider {
  private readonly chatEndpoint: URL;

  constructor(private readonly options: OllamaProviderOptions) {
    this.chatEndpoint = new URL("/api/chat", options.baseUrl);
  }

  async chat(input: ChatInput): Promise<ChatResult> {
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
      const response = await fetch(this.chatEndpoint, {
        method: "POST",
        headers: {
          accept: "application/json",
          "content-type": "application/json",
        },
        body: JSON.stringify({
          model: this.options.model,
          messages: input.messages,
          think: false,
          stream: false,
          keep_alive: this.options.keepAlive,
          options: {
            num_ctx: this.options.contextLength,
          },
        }),
        signal: requestSignal,
      });

      if (!response.ok) {
        await discardResponseBody(response);
        throw new AIProviderError(
          "UPSTREAM_ERROR",
          `Ollama returned HTTP status ${response.status}.`,
        );
      }

      const payload = await parseResponse(response, requestSignal);
      const parsedResponse = ollamaResponseSchema.safeParse(payload);

      if (!parsedResponse.success) {
        throw new AIProviderError(
          "INVALID_RESPONSE",
          "Ollama returned an unexpected response shape.",
        );
      }

      const content = parsedResponse.data.message.content;
      if (content.trim().length === 0) {
        throw new AIProviderError(
          "INVALID_RESPONSE",
          "Ollama returned an empty response.",
        );
      }

      return { content };
    } catch (error: unknown) {
      if (error instanceof AIProviderError) {
        throw error;
      }

      if (deadlineController.signal.aborted) {
        throw new AIProviderError(
          "TIMEOUT",
          `Ollama did not respond within ${this.options.requestTimeoutMs}ms.`,
          { cause: error },
        );
      }

      if (input.signal?.aborted) {
        throw new AIProviderError(
          "CANCELLED",
          "The client cancelled the Ollama request.",
          { cause: error },
        );
      }

      throw new AIProviderError(
        "UNAVAILABLE",
        "The Ollama request could not be completed.",
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

    throw new AIProviderError(
      "INVALID_RESPONSE",
      "Ollama returned malformed JSON.",
    );
  }
}

async function discardResponseBody(response: Response): Promise<void> {
  try {
    await response.body?.cancel();
  } catch {
    // The original non-success status is the actionable provider failure.
  }
}
