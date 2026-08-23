import { z } from "zod";

import {
  AIProviderError,
  type AIProvider,
  type ChatChunk,
  type ChatInput,
  type ChatResult,
} from "./ai-provider";

interface OllamaProviderOptions {
  readonly baseUrl: string;
  readonly model: string;
  readonly contextLength: number;
  readonly keepAlive: string | number;
  readonly requestTimeoutMs: number;
}

const ollamaStreamChunkSchema = z
  .object({
    done: z.boolean(),
    message: z
      .object({
        content: z.string(),
      })
      .optional(),
  })
  .passthrough();

const ollamaStreamErrorSchema = z
  .object({
    error: z.string(),
  })
  .passthrough();

export class OllamaProvider implements AIProvider {
  private readonly chatEndpoint: URL;

  constructor(private readonly options: OllamaProviderOptions) {
    this.chatEndpoint = new URL("/api/chat", options.baseUrl);
  }

  async chat(input: ChatInput): Promise<ChatResult> {
    let content = "";

    for await (const chunk of this.streamChat(input)) {
      content += chunk.content;
    }

    if (content.trim().length === 0) {
      throw new AIProviderError(
        "INVALID_RESPONSE",
        "Ollama returned an empty response.",
      );
    }

    return { content };
  }

  async *streamChat(input: ChatInput): AsyncIterable<ChatChunk> {
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
      let response = await fetch(this.chatEndpoint, {
        method: "POST",
        headers: {
          accept: "application/x-ndjson",
          "content-type": "application/json",
        },
        body: JSON.stringify({
          model: this.options.model,
          messages: input.messages,
          think: false,
          stream: true,
          keep_alive: this.options.keepAlive,
          options: {
            num_ctx: this.options.contextLength,
            ...(input.temperature !== undefined
              ? { temperature: input.temperature }
              : {}),
          },
          ...(input.responseFormat ? { format: input.responseFormat } : {}),
        }),
        signal: requestSignal,
      });

      if (
        response.status === 400 &&
        typeof input.responseFormat === "object"
      ) {
        await discardResponseBody(response);
        response = await fetch(this.chatEndpoint, {
          method: "POST",
          headers: {
            accept: "application/x-ndjson",
            "content-type": "application/json",
          },
          body: JSON.stringify({
            model: this.options.model,
            messages: input.messages,
            think: false,
            stream: true,
            keep_alive: this.options.keepAlive,
            options: {
              num_ctx: this.options.contextLength,
              ...(input.temperature !== undefined
                ? { temperature: input.temperature }
                : {}),
            },
            format: "json",
          }),
          signal: requestSignal,
        });
      }

      if (!response.ok) {
        await discardResponseBody(response);
        throw new AIProviderError(
          "UPSTREAM_ERROR",
          `Ollama returned HTTP status ${response.status}.`,
        );
      }

      if (!response.body) {
        throw new AIProviderError(
          "INVALID_RESPONSE",
          "Ollama returned a response without a body.",
        );
      }

      let completed = false;
      let receivedContent = false;

      for await (const payload of readNdjson(response.body)) {
        if (ollamaStreamErrorSchema.safeParse(payload).success) {
          throw new AIProviderError(
            "UPSTREAM_ERROR",
            "Ollama reported an error while streaming.",
          );
        }

        const parsedChunk = ollamaStreamChunkSchema.safeParse(payload);
        if (!parsedChunk.success) {
          throw new AIProviderError(
            "INVALID_RESPONSE",
            "Ollama returned an unexpected streaming response shape.",
          );
        }

        const content = parsedChunk.data.message?.content ?? "";
        if (content.length > 0) {
          receivedContent = true;
          yield { content };
        }

        if (parsedChunk.data.done) {
          completed = true;
          break;
        }

        if (!parsedChunk.data.message) {
          throw new AIProviderError(
            "INVALID_RESPONSE",
            "Ollama returned a streaming chunk without a message.",
          );
        }
      }

      if (!completed) {
        throw new AIProviderError(
          "INVALID_RESPONSE",
          "Ollama ended the response before completing the stream.",
        );
      }

      if (!receivedContent) {
        throw new AIProviderError(
          "INVALID_RESPONSE",
          "Ollama returned an empty response.",
        );
      }
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

async function* readNdjson(
  body: ReadableStream<Uint8Array>,
): AsyncIterable<unknown> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        buffer += decoder.decode();
        break;
      }

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";

      for (const line of lines) {
        const payload = parseNdjsonLine(line);
        if (payload !== undefined) {
          yield payload;
        }
      }
    }

    const finalPayload = parseNdjsonLine(buffer);
    if (finalPayload !== undefined) {
      yield finalPayload;
    }
  } finally {
    try {
      await reader.cancel();
    } catch {
      // Fetch cancellation and provider errors are classified by the caller.
    }
    reader.releaseLock();
  }
}

function parseNdjsonLine(line: string): unknown | undefined {
  const trimmedLine = line.trim();
  if (trimmedLine.length === 0) {
    return undefined;
  }

  try {
    return JSON.parse(trimmedLine) as unknown;
  } catch {
    throw new AIProviderError(
      "INVALID_RESPONSE",
      "Ollama returned malformed streaming JSON.",
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
