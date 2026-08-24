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
        thinking: z.string().optional(),
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
    let thinking = "";

    for await (const chunk of this.streamChat(input)) {
      if (chunk.thinking) {
        thinking += chunk.thinking;
        continue;
      }
      content += chunk.content;
    }

    if (content.trim().length === 0) {
      throw new AIProviderError(
        "INVALID_RESPONSE",
        "Ollama returned an empty response.",
      );
    }

    return { content, ...(thinking ? { thinking } : {}) };
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
            think: true,
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
        const detail = await readErrorBody(response);
        throw new AIProviderError(
          "UPSTREAM_ERROR",
          `Ollama returned HTTP status ${response.status}.${detail ? ` ${detail}` : ""}`,
        );
      }

      if (!response.body) {
        throw new AIProviderError(
          "INVALID_RESPONSE",
          "Ollama returned a response without a body.",
        );
      }

      let completed = false;
      // Thinking deltas are a legitimate, expected part of a response (see
      // ChatChunk.thinking) — a model can spend many chunks reasoning before
      // it emits its first content token. Tracking only `content` here would
      // wrongly treat that normal, in-progress state as "nothing came back."
      let receivedAnyOutput = false;

      for await (const payload of readNdjson(response.body)) {
        const streamError = ollamaStreamErrorSchema.safeParse(payload);
        if (streamError.success) {
          const detail = truncateForLog(streamError.data.error);
          throw new AIProviderError(
            "UPSTREAM_ERROR",
            `Ollama reported an error while streaming.${detail ? ` ${detail}` : ""}`,
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
        const thinking = parsedChunk.data.message?.thinking ?? "";
        if (content.length > 0 || thinking.length > 0) {
          receivedAnyOutput = true;
          yield { content, ...(thinking ? { thinking } : {}) };
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

      if (!receivedAnyOutput) {
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

const MAX_ERROR_BODY_CHARS = 500;

function truncateForLog(text: string): string | undefined {
  const trimmed = text.trim();
  if (!trimmed) return undefined;
  return trimmed.length > MAX_ERROR_BODY_CHARS
    ? `${trimmed.slice(0, MAX_ERROR_BODY_CHARS)}...`
    : trimmed;
}

/** Best-effort capture of Ollama's own error text (e.g. an unsupported option) for diagnosis. */
async function readErrorBody(response: Response): Promise<string | undefined> {
  try {
    return truncateForLog(await response.text());
  } catch {
    return undefined;
  }
}
