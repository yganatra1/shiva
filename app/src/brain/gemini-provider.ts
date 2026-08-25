import { z } from "zod";

import {
  AIProviderError,
  type AIProvider,
  type ChatChunk,
  type ChatInput,
  type ChatMessage,
  type ChatResult,
} from "./ai-provider";

const GEMINI_API_BASE_URL = "https://generativelanguage.googleapis.com";

interface GeminiProviderOptions {
  readonly apiKey: string;
  readonly model: string;
  readonly requestTimeoutMs: number;
  /** Overrides the real Gemini host; exists so tests can point at a local server. */
  readonly baseUrl?: string;
}

const geminiPartSchema = z
  .object({
    text: z.string().optional(),
    thought: z.boolean().optional(),
  })
  .passthrough();

const geminiStreamChunkSchema = z
  .object({
    candidates: z
      .array(
        z
          .object({
            content: z
              .object({ parts: z.array(geminiPartSchema).optional() })
              .passthrough()
              .optional(),
            finishReason: z.string().optional(),
          })
          .passthrough(),
      )
      .optional(),
    promptFeedback: z
      .object({ blockReason: z.string().optional() })
      .passthrough()
      .optional(),
  })
  .passthrough();

const geminiStreamErrorSchema = z
  .object({
    error: z.object({ message: z.string() }).passthrough(),
  })
  .passthrough();

export class GeminiProvider implements AIProvider {
  constructor(private readonly options: GeminiProviderOptions) {}

  async chat(input: ChatInput): Promise<ChatResult> {
    let content = "";
    let thinking = "";

    for await (const chunk of this.streamChat(input)) {
      if (chunk.thinking) thinking += chunk.thinking;
      content += chunk.content;
    }

    if (content.trim().length === 0) {
      throw new AIProviderError(
        "INVALID_RESPONSE",
        "Gemini returned an empty response.",
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
      const endpoint = new URL(
        `/v1beta/models/${encodeURIComponent(this.options.model)}:streamGenerateContent`,
        this.options.baseUrl ?? GEMINI_API_BASE_URL,
      );
      endpoint.searchParams.set("alt", "sse");

      const response = await fetch(endpoint, {
        method: "POST",
        headers: {
          "x-goog-api-key": this.options.apiKey,
          "content-type": "application/json",
        },
        body: JSON.stringify(buildRequestBody(input)),
        signal: requestSignal,
      });

      if (!response.ok) {
        const detail = await readErrorBody(response);
        throw new AIProviderError(
          "UPSTREAM_ERROR",
          `Gemini returned HTTP status ${response.status}.${detail ? ` ${detail}` : ""}`,
        );
      }

      if (!response.body) {
        throw new AIProviderError(
          "INVALID_RESPONSE",
          "Gemini returned a response without a body.",
        );
      }

      let completed = false;
      // Thinking deltas are a legitimate, expected part of a response (see
      // ChatChunk.thinking) — a model can spend many chunks reasoning before
      // it emits its first content token. Tracking only `content` here would
      // wrongly treat that normal, in-progress state as "nothing came back."
      let receivedAnyOutput = false;

      for await (const payload of readSseEvents(response.body)) {
        const streamError = geminiStreamErrorSchema.safeParse(payload);
        if (streamError.success) {
          const detail = truncateForLog(streamError.data.error.message);
          throw new AIProviderError(
            "UPSTREAM_ERROR",
            `Gemini reported an error while streaming.${detail ? ` ${detail}` : ""}`,
          );
        }

        const parsedChunk = geminiStreamChunkSchema.safeParse(payload);
        if (!parsedChunk.success) {
          throw new AIProviderError(
            "INVALID_RESPONSE",
            "Gemini returned an unexpected streaming response shape.",
          );
        }

        const blockReason = parsedChunk.data.promptFeedback?.blockReason;
        if (blockReason) {
          throw new AIProviderError(
            "UPSTREAM_ERROR",
            `Gemini blocked the response (${blockReason}).`,
          );
        }

        const parts = parsedChunk.data.candidates?.[0]?.content?.parts ?? [];
        const content = parts
          .filter((part) => !part.thought)
          .map((part) => part.text ?? "")
          .join("");
        const thinking = parts
          .filter((part) => part.thought)
          .map((part) => part.text ?? "")
          .join("");

        if (content.length > 0 || thinking.length > 0) {
          receivedAnyOutput = true;
          yield { content, ...(thinking ? { thinking } : {}) };
        }

        if (parsedChunk.data.candidates?.[0]?.finishReason) {
          completed = true;
        }
      }

      if (!completed) {
        throw new AIProviderError(
          "INVALID_RESPONSE",
          "Gemini ended the response before completing the stream.",
        );
      }

      if (!receivedAnyOutput) {
        throw new AIProviderError(
          "INVALID_RESPONSE",
          "Gemini returned an empty response.",
        );
      }
    } catch (error: unknown) {
      if (error instanceof AIProviderError) {
        throw error;
      }

      if (deadlineController.signal.aborted) {
        throw new AIProviderError(
          "TIMEOUT",
          `Gemini did not respond within ${this.options.requestTimeoutMs}ms.`,
          { cause: error },
        );
      }

      if (input.signal?.aborted) {
        throw new AIProviderError(
          "CANCELLED",
          "The client cancelled the Gemini request.",
          { cause: error },
        );
      }

      throw new AIProviderError(
        "UNAVAILABLE",
        "The Gemini request could not be completed.",
        { cause: error },
      );
    } finally {
      clearTimeout(timeout);
    }
  }
}

function buildRequestBody(input: ChatInput): Record<string, unknown> {
  const systemText = input.messages
    .filter((message) => message.role === "system")
    .map((message) => message.content)
    .join("\n\n");

  const contents = input.messages
    .filter((message): message is ChatMessage => message.role !== "system")
    .map((message) => ({
      role: message.role === "assistant" ? "model" : "user",
      parts: [
        ...(message.content ? [{ text: message.content }] : []),
        ...(message.images ?? []).map((image) => ({
          inlineData: { mimeType: "image/jpeg", data: image },
        })),
      ],
    }));

  const generationConfig: Record<string, unknown> = {
    // Matches OllamaProvider's `think: false`: thinking tokens count against
    // the output budget, and Gemma will happily spend all of it "thinking"
    // and leave none for actual content — an empty response that looks like
    // no response at all. "minimal" is Gemma-on-Gemini's off switch; see
    // https://ai.google.dev/gemma/docs/core/gemma_on_gemini_api.
    thinkingConfig: { thinkingLevel: "minimal" },
    ...(input.temperature !== undefined
      ? { temperature: input.temperature }
      : {}),
    ...(input.responseFormat
      ? {
          responseMimeType: "application/json",
          ...(typeof input.responseFormat === "object"
            ? { responseSchema: toGeminiSchema(input.responseFormat) }
            : {}),
        }
      : {}),
  };

  return {
    ...(systemText ? { systemInstruction: { parts: [{ text: systemText }] } } : {}),
    contents,
    ...(Object.keys(generationConfig).length > 0 ? { generationConfig } : {}),
  };
}

/**
 * Gemini's responseSchema accepts only a restricted JSON Schema dialect: it
 * has no `const` (Gemini rejects the whole request with an "Unknown name"
 * 400) and no `additionalProperties`. Callers like the planner write plain
 * JSON Schema — discriminated unions via `const` included — so translate it
 * into what Gemini accepts rather than pushing that dialect split onto them.
 */
function toGeminiSchema(schema: unknown): unknown {
  if (Array.isArray(schema)) {
    return schema.map(toGeminiSchema);
  }

  if (schema === null || typeof schema !== "object") {
    return schema;
  }

  const converted: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(schema as Record<string, unknown>)) {
    if (key === "additionalProperties") continue;
    if (key === "const") {
      converted.enum = [value];
      continue;
    }
    converted[key] = toGeminiSchema(value);
  }
  return converted;
}

async function* readSseEvents(
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
        const payload = parseSseLine(line);
        if (payload !== undefined) {
          yield payload;
        }
      }
    }

    const finalPayload = parseSseLine(buffer);
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

function parseSseLine(line: string): unknown | undefined {
  const trimmedLine = line.trim();
  if (trimmedLine.length === 0 || !trimmedLine.startsWith("data:")) {
    return undefined;
  }

  const data = trimmedLine.slice("data:".length).trim();
  if (data.length === 0) {
    return undefined;
  }

  try {
    return JSON.parse(data) as unknown;
  } catch {
    throw new AIProviderError(
      "INVALID_RESPONSE",
      "Gemini returned malformed streaming JSON.",
    );
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

/** Best-effort capture of Gemini's own error text (e.g. an invalid API key) for diagnosis. */
async function readErrorBody(response: Response): Promise<string | undefined> {
  try {
    return truncateForLog(await response.text());
  } catch {
    return undefined;
  }
}
