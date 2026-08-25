import { createHash, createHmac } from "node:crypto";
import { z } from "zod";

import {
  AIProviderError,
  type AIProvider,
  type ChatChunk,
  type ChatInput,
  type ChatMessage,
  type ChatResult,
} from "./ai-provider";

/**
 * Bedrock accepts either a short-lived/long-term API key — a bearer token
 * sent as a plain `Authorization: Bearer` header, no request signing
 * required — or classic IAM credentials, which every request must sign with
 * SigV4. Prefer the bearer token when both are configured: it's the simpler
 * mechanism and the one AWS now issues by default from the Bedrock console.
 */
export type BedrockCredentials =
  | { readonly type: "bearer"; readonly token: string }
  | {
      readonly type: "sigv4";
      readonly accessKeyId: string;
      readonly secretAccessKey: string;
      readonly sessionToken?: string;
    };

interface BedrockProviderOptions {
  readonly credentials: BedrockCredentials;
  readonly region: string;
  readonly model: string;
  readonly requestTimeoutMs: number;
  /** Overrides the real Bedrock host; exists so tests can point at a local server. */
  readonly baseUrl?: string;
}

const BEDROCK_SERVICE = "bedrock";

const bedrockEventPayloadSchema = z
  .object({
    contentBlockIndex: z.number().optional(),
    delta: z
      .object({
        text: z.string().optional(),
        reasoningContent: z
          .object({ text: z.string().optional() })
          .passthrough()
          .optional(),
      })
      .passthrough()
      .optional(),
    stopReason: z.string().optional(),
    message: z.string().optional(),
  })
  .passthrough();

export class BedrockProvider implements AIProvider {
  private readonly endpoint: URL;

  constructor(private readonly options: BedrockProviderOptions) {
    this.endpoint = new URL(
      `/model/${encodeModelIdForPath(options.model)}/converse-stream`,
      options.baseUrl ?? `https://bedrock-runtime.${options.region}.amazonaws.com`,
    );
  }

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
        "Bedrock returned an empty response.",
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
      const body = JSON.stringify(buildRequestBody(input));
      const credentials = this.options.credentials;
      const signedHeaders =
        credentials.type === "bearer"
          ? {
              "content-type": "application/json",
              authorization: `Bearer ${credentials.token}`,
            }
          : signRequest({
              method: "POST",
              url: this.endpoint,
              body,
              region: this.options.region,
              accessKeyId: credentials.accessKeyId,
              secretAccessKey: credentials.secretAccessKey,
              ...(credentials.sessionToken
                ? { sessionToken: credentials.sessionToken }
                : {}),
            });

      const response = await fetch(this.endpoint, {
        method: "POST",
        headers: signedHeaders,
        body,
        signal: requestSignal,
      });

      if (!response.ok) {
        const detail = await readErrorBody(response);
        throw new AIProviderError(
          "UPSTREAM_ERROR",
          `Bedrock returned HTTP status ${response.status}.${detail ? ` ${detail}` : ""}`,
        );
      }

      if (!response.body) {
        throw new AIProviderError(
          "INVALID_RESPONSE",
          "Bedrock returned a response without a body.",
        );
      }

      let completed = false;
      // Thinking deltas are a legitimate, expected part of a response (see
      // ChatChunk.thinking) — a model can spend many chunks reasoning before
      // it emits its first content token. Tracking only `content` here would
      // wrongly treat that normal, in-progress state as "nothing came back."
      let receivedAnyOutput = false;

      for await (const event of readEventStreamMessages(response.body)) {
        if (event.messageType === "exception") {
          const parsed = bedrockEventPayloadSchema.safeParse(event.payload);
          const detail =
            parsed.success && parsed.data.message
              ? truncateForLog(parsed.data.message)
              : undefined;
          throw new AIProviderError(
            "UPSTREAM_ERROR",
            `Bedrock reported an error while streaming (${event.exceptionType ?? "unknown"}).${detail ? ` ${detail}` : ""}`,
          );
        }

        const parsedPayload = bedrockEventPayloadSchema.safeParse(event.payload);
        if (!parsedPayload.success) {
          throw new AIProviderError(
            "INVALID_RESPONSE",
            "Bedrock returned an unexpected streaming response shape.",
          );
        }

        if (event.eventType === "contentBlockDelta") {
          const content = parsedPayload.data.delta?.text ?? "";
          const thinking = parsedPayload.data.delta?.reasoningContent?.text ?? "";
          if (content.length > 0 || thinking.length > 0) {
            receivedAnyOutput = true;
            yield { content, ...(thinking ? { thinking } : {}) };
          }
        }

        if (event.eventType === "messageStop") {
          completed = true;
        }
      }

      if (!completed) {
        throw new AIProviderError(
          "INVALID_RESPONSE",
          "Bedrock ended the response before completing the stream.",
        );
      }

      if (!receivedAnyOutput) {
        throw new AIProviderError(
          "INVALID_RESPONSE",
          "Bedrock returned an empty response.",
        );
      }
    } catch (error: unknown) {
      if (error instanceof AIProviderError) {
        throw error;
      }

      if (deadlineController.signal.aborted) {
        throw new AIProviderError(
          "TIMEOUT",
          `Bedrock did not respond within ${this.options.requestTimeoutMs}ms.`,
          { cause: error },
        );
      }

      if (input.signal?.aborted) {
        throw new AIProviderError(
          "CANCELLED",
          "The client cancelled the Bedrock request.",
          { cause: error },
        );
      }

      throw new AIProviderError(
        "UNAVAILABLE",
        "The Bedrock request could not be completed.",
        { cause: error },
      );
    } finally {
      clearTimeout(timeout);
    }
  }
}

function buildRequestBody(input: ChatInput): Record<string, unknown> {
  const systemParts = input.messages
    .filter((message) => message.role === "system")
    .map((message) => message.content);

  // The Converse API has no cross-model structured-output contract like
  // Gemini's responseSchema or OpenAI's json_schema response_format, so a
  // requested shape is asked for through the system prompt instead — the
  // same best-effort path the planner already falls back to (see
  // planner.ts's buildRetryCorrection) when a model ignores it once.
  if (input.responseFormat) {
    systemParts.push(
      input.responseFormat === "json"
        ? "Respond with a single valid JSON object and no other text or markdown."
        : `Respond with a single valid JSON object matching this exact JSON Schema, and no other text or markdown: ${JSON.stringify(input.responseFormat)}`,
    );
  }

  const messages = input.messages
    .filter((message): message is ChatMessage => message.role !== "system")
    .map((message) => ({
      role: message.role === "assistant" ? "assistant" : "user",
      content: [
        ...(message.content ? [{ text: message.content }] : []),
        ...(message.images ?? []).map((image) => ({
          image: { format: "jpeg", source: { bytes: image } },
        })),
      ],
    }));

  return {
    messages,
    ...(systemParts.length > 0
      ? { system: systemParts.map((text) => ({ text })) }
      : {}),
    ...(input.temperature !== undefined
      ? { inferenceConfig: { temperature: input.temperature } }
      : {}),
  };
}

interface SignRequestOptions {
  readonly method: string;
  readonly url: URL;
  readonly body: string;
  readonly region: string;
  readonly accessKeyId: string;
  readonly secretAccessKey: string;
  readonly sessionToken?: string;
}

/**
 * Hand-rolled AWS SigV4 signing (no aws-sdk dependency, matching every other
 * provider in this module being a bare `fetch` call). Follows the standard
 * (non-S3) canonical-request algorithm:
 * https://docs.aws.amazon.com/general/latest/gr/sigv4-create-canonical-request.html
 */
function signRequest(options: SignRequestOptions): Record<string, string> {
  const now = new Date();
  const amzDate = now.toISOString().replace(/[:-]|\.\d{3}/g, "");
  const dateStamp = amzDate.slice(0, 8);

  const canonicalUri = options.url.pathname
    .split("/")
    .map((segment) => sigV4UriEncode(segment, false))
    .join("/");
  const canonicalQueryString = [...options.url.searchParams.entries()]
    .map(([key, value]) => [sigV4UriEncode(key), sigV4UriEncode(value)] as const)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([key, value]) => `${key}=${value}`)
    .join("&");

  const headers: Record<string, string> = {
    host: options.url.host,
    "content-type": "application/json",
    "x-amz-date": amzDate,
    ...(options.sessionToken
      ? { "x-amz-security-token": options.sessionToken }
      : {}),
  };
  const signedHeaderNames = Object.keys(headers).sort();
  const canonicalHeaders = signedHeaderNames
    .map((name) => `${name}:${headers[name]}\n`)
    .join("");
  const signedHeaders = signedHeaderNames.join(";");
  const payloadHash = sha256Hex(options.body);

  const canonicalRequest = [
    options.method,
    canonicalUri,
    canonicalQueryString,
    canonicalHeaders,
    signedHeaders,
    payloadHash,
  ].join("\n");

  const credentialScope = `${dateStamp}/${options.region}/${BEDROCK_SERVICE}/aws4_request`;
  const stringToSign = [
    "AWS4-HMAC-SHA256",
    amzDate,
    credentialScope,
    sha256Hex(canonicalRequest),
  ].join("\n");

  const kDate = hmac(`AWS4${options.secretAccessKey}`, dateStamp);
  const kRegion = hmac(kDate, options.region);
  const kService = hmac(kRegion, BEDROCK_SERVICE);
  const kSigning = hmac(kService, "aws4_request");
  const signature = hmac(kSigning, stringToSign).toString("hex");

  return {
    ...headers,
    authorization: `AWS4-HMAC-SHA256 Credential=${options.accessKeyId}/${credentialScope}, SignedHeaders=${signedHeaders}, Signature=${signature}`,
  };
}

function sigV4UriEncode(value: string, encodeSlash = true): string {
  return [...Buffer.from(value, "utf8")]
    .map((byte) => {
      const char = String.fromCharCode(byte);
      if (/[A-Za-z0-9\-_.~]/.test(char)) return char;
      if (char === "/") return encodeSlash ? "%2F" : "/";
      return `%${byte.toString(16).toUpperCase().padStart(2, "0")}`;
    })
    .join("");
}

/** Bedrock model ids contain ':' (e.g. an inference profile version suffix), which the URI path must percent-encode. */
function encodeModelIdForPath(modelId: string): string {
  return sigV4UriEncode(modelId, true);
}

function sha256Hex(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function hmac(key: string | Buffer, value: string): Buffer {
  return createHmac("sha256", key).update(value, "utf8").digest();
}

interface BedrockStreamEvent {
  readonly messageType: "event" | "exception";
  readonly eventType?: string;
  readonly exceptionType?: string;
  readonly payload: unknown;
}

/**
 * Parses the AWS `application/vnd.amazon.eventstream` binary framing used by
 * ConverseStream. Each message is: total-length(4) + headers-length(4) +
 * prelude-crc(4) + headers + payload + message-crc(4). CRCs are not
 * re-verified here — the stream already runs over TLS, and this decoder only
 * needs the structural framing, not tamper detection.
 */
async function* readEventStreamMessages(
  body: ReadableStream<Uint8Array>,
): AsyncIterable<BedrockStreamEvent> {
  const reader = body.getReader();
  let buffer = Buffer.alloc(0);

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (value) buffer = Buffer.concat([buffer, Buffer.from(value)]);

      while (buffer.length >= 12) {
        const totalLength = buffer.readUInt32BE(0);
        if (buffer.length < totalLength) break;

        const headersLength = buffer.readUInt32BE(4);
        const headersStart = 12;
        const headersEnd = headersStart + headersLength;
        const payloadEnd = totalLength - 4;

        if (headersEnd > payloadEnd) {
          throw new AIProviderError(
            "INVALID_RESPONSE",
            "Bedrock returned a malformed event-stream frame.",
          );
        }

        const headers = parseEventStreamHeaders(
          buffer.subarray(headersStart, headersEnd),
        );
        const payloadBytes = buffer.subarray(headersEnd, payloadEnd);
        buffer = buffer.subarray(totalLength);

        const messageType = headers[":message-type"] === "exception" ? "exception" : "event";
        let payload: unknown;
        try {
          payload = payloadBytes.length > 0
            ? (JSON.parse(payloadBytes.toString("utf8")) as unknown)
            : {};
        } catch {
          throw new AIProviderError(
            "INVALID_RESPONSE",
            "Bedrock returned malformed streaming JSON.",
          );
        }

        yield {
          messageType,
          ...(headers[":event-type"] ? { eventType: headers[":event-type"] } : {}),
          ...(headers[":exception-type"]
            ? { exceptionType: headers[":exception-type"] }
            : {}),
          payload,
        };
      }

      if (done) break;
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

function parseEventStreamHeaders(bytes: Buffer): Record<string, string> {
  const headers: Record<string, string> = {};
  let offset = 0;
  while (offset < bytes.length) {
    const nameLength = bytes.readUInt8(offset);
    offset += 1;
    const name = bytes.toString("utf8", offset, offset + nameLength);
    offset += nameLength;
    const valueType = bytes.readUInt8(offset);
    offset += 1;
    if (valueType !== 7) {
      throw new AIProviderError(
        "INVALID_RESPONSE",
        "Bedrock returned an unsupported event-stream header type.",
      );
    }
    const valueLength = bytes.readUInt16BE(offset);
    offset += 2;
    const value = bytes.toString("utf8", offset, offset + valueLength);
    offset += valueLength;
    headers[name] = value;
  }
  return headers;
}

const MAX_ERROR_BODY_CHARS = 500;

function truncateForLog(text: string): string | undefined {
  const trimmed = text.trim();
  if (!trimmed) return undefined;
  return trimmed.length > MAX_ERROR_BODY_CHARS
    ? `${trimmed.slice(0, MAX_ERROR_BODY_CHARS)}...`
    : trimmed;
}

/** Best-effort capture of Bedrock's own error text (e.g. an invalid model id) for diagnosis. */
async function readErrorBody(response: Response): Promise<string | undefined> {
  try {
    return truncateForLog(await response.text());
  } catch {
    return undefined;
  }
}
