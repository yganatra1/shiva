import { z } from "zod";

import {
  AIProviderError,
  type AIProvider,
  type ChatChunk,
  type ChatInput,
  type ChatMessage,
  type ChatResult,
} from "./ai-provider";

const OPENAI_API_BASE_URL = "https://api.openai.com";

interface OpenAiProviderOptions {
  readonly apiKey: string;
  readonly model: string;
  readonly requestTimeoutMs: number;
  /** Overrides the real OpenAI host; exists so tests can point at a local server. */
  readonly baseUrl?: string;
}

const openAiStreamChunkSchema = z
  .object({
    choices: z
      .array(
        z
          .object({
            delta: z
              .object({ content: z.string().nullable().optional() })
              .passthrough()
              .optional(),
            finish_reason: z.string().nullable().optional(),
          })
          .passthrough(),
      )
      .optional(),
  })
  .passthrough();

const openAiErrorBodySchema = z
  .object({
    error: z.object({ message: z.string() }).passthrough(),
  })
  .passthrough();

export class OpenAiProvider implements AIProvider {
  constructor(private readonly options: OpenAiProviderOptions) {}

  async chat(input: ChatInput): Promise<ChatResult> {
    let content = "";

    for await (const chunk of this.streamChat(input)) {
      content += chunk.content;
    }

    if (content.trim().length === 0) {
      throw new AIProviderError(
        "INVALID_RESPONSE",
        "OpenAI returned an empty response.",
      );
    }

    return {
      content: needsTopLevelWrap(input.responseFormat)
        ? unwrapTopLevelValue(content)
        : content,
    };
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
        "/v1/chat/completions",
        this.options.baseUrl ?? OPENAI_API_BASE_URL,
      );
      const headers = {
        authorization: `Bearer ${this.options.apiKey}`,
        "content-type": "application/json",
      };

      let response = await fetch(endpoint, {
        method: "POST",
        headers,
        body: JSON.stringify(buildRequestBody(input, this.options.model)),
        signal: requestSignal,
      });

      // The body stream can only be read once, so a 400 is read here — the
      // one place that decides whether to retry — rather than a second time
      // by the generic error handler below.
      let errorDetail: string | undefined;
      if (!response.ok) {
        errorDetail = await readErrorBody(response);
      }

      if (
        response.status === 400 &&
        input.temperature !== undefined &&
        rejectsTemperature(errorDetail)
      ) {
        const { temperature: _temperature, ...inputWithoutTemperature } = input;
        response = await fetch(endpoint, {
          method: "POST",
          headers,
          body: JSON.stringify(
            buildRequestBody(inputWithoutTemperature, this.options.model),
          ),
          signal: requestSignal,
        });
        errorDetail = response.ok ? undefined : await readErrorBody(response);
      }

      if (!response.ok) {
        throw new AIProviderError(
          "UPSTREAM_ERROR",
          `OpenAI returned HTTP status ${response.status}.${errorDetail ? ` ${errorDetail}` : ""}`,
        );
      }

      if (!response.body) {
        throw new AIProviderError(
          "INVALID_RESPONSE",
          "OpenAI returned a response without a body.",
        );
      }

      let completed = false;
      let receivedAnyOutput = false;

      for await (const payload of readSseEvents(response.body)) {
        if (payload === "[DONE]") {
          completed = true;
          break;
        }

        const streamError = openAiErrorBodySchema.safeParse(payload);
        if (streamError.success) {
          const detail = truncateForLog(streamError.data.error.message);
          throw new AIProviderError(
            "UPSTREAM_ERROR",
            `OpenAI reported an error while streaming.${detail ? ` ${detail}` : ""}`,
          );
        }

        const parsedChunk = openAiStreamChunkSchema.safeParse(payload);
        if (!parsedChunk.success) {
          throw new AIProviderError(
            "INVALID_RESPONSE",
            "OpenAI returned an unexpected streaming response shape.",
          );
        }

        const choice = parsedChunk.data.choices?.[0];
        const content = choice?.delta?.content ?? "";
        if (content.length > 0) {
          receivedAnyOutput = true;
          yield { content };
        }

        if (choice?.finish_reason) {
          completed = true;
        }
      }

      if (!completed) {
        throw new AIProviderError(
          "INVALID_RESPONSE",
          "OpenAI ended the response before completing the stream.",
        );
      }

      if (!receivedAnyOutput) {
        throw new AIProviderError(
          "INVALID_RESPONSE",
          "OpenAI returned an empty response.",
        );
      }
    } catch (error: unknown) {
      if (error instanceof AIProviderError) {
        throw error;
      }

      if (deadlineController.signal.aborted) {
        throw new AIProviderError(
          "TIMEOUT",
          `OpenAI did not respond within ${this.options.requestTimeoutMs}ms.`,
          { cause: error },
        );
      }

      if (input.signal?.aborted) {
        throw new AIProviderError(
          "CANCELLED",
          "The client cancelled the OpenAI request.",
          { cause: error },
        );
      }

      throw new AIProviderError(
        "UNAVAILABLE",
        "The OpenAI request could not be completed.",
        { cause: error },
      );
    } finally {
      clearTimeout(timeout);
    }
  }
}

function buildRequestBody(
  input: ChatInput,
  model: string,
): Record<string, unknown> {
  const messages = input.messages.map((message) => ({
    role: message.role,
    content: buildMessageContent(message),
  }));

  return {
    model,
    messages,
    stream: true,
    ...(input.temperature !== undefined
      ? { temperature: input.temperature }
      : {}),
    ...(input.responseFormat
      ? { response_format: buildResponseFormat(input.responseFormat) }
      : {}),
  };
}

function buildMessageContent(
  message: ChatMessage,
): string | Array<Record<string, unknown>> {
  if (!message.images || message.images.length === 0) {
    return message.content;
  }

  return [
    ...(message.content ? [{ type: "text", text: message.content }] : []),
    ...message.images.map((image) => ({
      type: "image_url",
      image_url: { url: `data:image/jpeg;base64,${image}` },
    })),
  ];
}

/**
 * OpenAI's Chat Completions API takes either a bare "json_object" mode or a
 * named "json_schema" (the latter requires a `name` and rejects the plain
 * JSON Schema our callers already write, so it's wrapped here rather than
 * pushed onto them). It additionally rejects oneOf/anyOf/allOf/enum/const/not
 * at the schema's top level (e.g. the planner's discriminated-union decision
 * schema) even though it accepts them nested — so a top-level one of those is
 * itself nested one level under a synthetic "value" property, and chat()
 * unwraps that property back out of the model's response before returning it.
 */
function buildResponseFormat(
  responseFormat: "json" | Readonly<Record<string, unknown>>,
): Record<string, unknown> {
  if (responseFormat === "json") {
    return { type: "json_object" };
  }
  const schema = needsTopLevelWrap(responseFormat)
    ? {
        type: "object",
        properties: { [WRAPPED_VALUE_KEY]: responseFormat },
        required: [WRAPPED_VALUE_KEY],
      }
    : responseFormat;
  return {
    type: "json_schema",
    json_schema: { name: "response", schema },
  };
}

const WRAPPED_VALUE_KEY = "value";
const TOP_LEVEL_KEYS_REJECTED_BY_OPENAI = [
  "oneOf",
  "anyOf",
  "allOf",
  "enum",
  "const",
  "not",
];

function needsTopLevelWrap(
  responseFormat: "json" | Readonly<Record<string, unknown>> | undefined,
): responseFormat is Readonly<Record<string, unknown>> {
  return (
    typeof responseFormat === "object" &&
    responseFormat !== null &&
    TOP_LEVEL_KEYS_REJECTED_BY_OPENAI.some((key) => key in responseFormat)
  );
}

function unwrapTopLevelValue(content: string): string {
  let parsed: unknown;
  try {
    parsed = JSON.parse(content) as unknown;
  } catch {
    throw new AIProviderError(
      "INVALID_RESPONSE",
      "OpenAI returned malformed structured-output JSON.",
    );
  }
  if (
    typeof parsed !== "object" ||
    parsed === null ||
    !(WRAPPED_VALUE_KEY in parsed)
  ) {
    throw new AIProviderError(
      "INVALID_RESPONSE",
      "OpenAI returned a structured-output response without the expected wrapper field.",
    );
  }
  return JSON.stringify((parsed as Record<string, unknown>)[WRAPPED_VALUE_KEY]);
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
  if (data === "[DONE]") {
    return "[DONE]";
  }

  try {
    return JSON.parse(data) as unknown;
  } catch {
    throw new AIProviderError(
      "INVALID_RESPONSE",
      "OpenAI returned malformed streaming JSON.",
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

const openAiErrorParamSchema = z
  .object({
    error: z.object({ param: z.string().optional(), code: z.string().optional() }).passthrough(),
  })
  .passthrough();

/**
 * Some models (e.g. gpt-5's reasoning variants) reject any explicit
 * `temperature` and only accept their fixed default. Detecting that specific
 * 400 lets the caller retry once without the field instead of failing every
 * request outright — mirrors OllamaProvider's retry-on-400 for `format`.
 */
function rejectsTemperature(errorDetail: string | undefined): boolean {
  if (!errorDetail) return false;
  let body: unknown;
  try {
    body = JSON.parse(errorDetail) as unknown;
  } catch {
    return false;
  }
  const parsed = openAiErrorParamSchema.safeParse(body);
  return (
    parsed.success &&
    parsed.data.error.param === "temperature" &&
    parsed.data.error.code === "unsupported_value"
  );
}

/** Best-effort capture of OpenAI's own error text (e.g. an invalid API key) for diagnosis. */
async function readErrorBody(response: Response): Promise<string | undefined> {
  try {
    return truncateForLog(await response.text());
  } catch {
    return undefined;
  }
}
