import type { FastifyInstance, FastifyReply } from "fastify";
import { z } from "zod";

import {
  captureFilename,
  SUPPORTED_CAPTURE_MIME_TYPES,
} from "../voice/audio-upload";
import type { ASRProvider, TTSProvider } from "../voice/provider";
import { createVoicePage } from "../voice/voice-ui";
import { ApiError } from "./api-error";

const MAX_AUDIO_BYTES = 25 * 1024 * 1024;
const MAX_TTS_CHARACTERS = 4_000;

const synthesisRequestSchema = z
  .object({
    text: z
      .string()
      .max(MAX_TTS_CHARACTERS)
      .refine((value) => value.trim().length > 0),
  })
  .strict();

interface VoiceRouteOptions {
  readonly asrProvider: ASRProvider;
  readonly ttsProvider: TTSProvider;
}

/**
 * The browser voice page plus the two REST voice endpoints.
 *
 * `/voice/transcribe` and `/voice/synthesize` exist only for diagnostics,
 * benchmarking, and backward compatibility. The realtime client drives ASR and
 * TTS through the `/voice/chat` WebSocket, so it never calls them.
 */
export function registerVoiceRoutes(
  app: FastifyInstance,
  options: VoiceRouteOptions,
): void {
  for (const contentType of SUPPORTED_CAPTURE_MIME_TYPES) {
    app.addContentTypeParser(
      contentType,
      { parseAs: "buffer", bodyLimit: MAX_AUDIO_BYTES },
      (_request, body, done) => done(null, body),
    );
  }

  app.get("/voice", (_request, reply) =>
    reply
      .header(
        "content-security-policy",
        "default-src 'self'; connect-src 'self'; media-src 'self' blob:; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src 'self' data:; object-src 'none'; base-uri 'none'; frame-ancestors 'none'",
      )
      .header("cache-control", "no-store")
      .type("text/html; charset=utf-8")
      .send(createVoicePage()),
  );

  app.post<{ Body: unknown }>(
    "/voice/transcribe",
    async (request, reply) => {
      const contentType = request.mediaType;
      if (!contentType || !SUPPORTED_CAPTURE_MIME_TYPES.has(contentType)) {
        throw new ApiError(
          400,
          "INVALID_AUDIO",
          "Upload a supported audio recording.",
        );
      }
      if (!Buffer.isBuffer(request.body) || request.body.byteLength === 0) {
        throw new ApiError(
          400,
          "INVALID_AUDIO",
          "The uploaded audio is empty or invalid.",
        );
      }

      const result = await withClientCancellation(reply, (signal) =>
        options.asrProvider.transcribe({
          audio: request.body as Buffer,
          contentType,
          filename: captureFilename(contentType),
          signal,
        }),
      );
      return reply.header("cache-control", "no-store").send(result);
    },
  );

  app.post<{ Body: unknown }>("/voice/synthesize", async (request, reply) => {
    if (request.mediaType !== "application/json") {
      throw new ApiError(
        415,
        "UNSUPPORTED_MEDIA_TYPE",
        "Content-Type must be application/json.",
      );
    }
    const parsed = synthesisRequestSchema.safeParse(request.body);
    if (!parsed.success) {
      throw new ApiError(
        400,
        "INVALID_REQUEST",
        `Text must contain 1–${MAX_TTS_CHARACTERS.toLocaleString("en-US")} characters.`,
      );
    }

    const result = await withClientCancellation(reply, (signal) =>
      options.ttsProvider.synthesize({
        text: parsed.data.text,
        signal,
      }),
    );

    return reply
      .header("cache-control", "no-store")
      .header("content-disposition", 'inline; filename="shiva.wav"')
      .type(result.contentType)
      .send(Buffer.from(result.audio));
  });
}

async function withClientCancellation<T>(
  reply: FastifyReply,
  operation: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
  const controller = new AbortController();
  const abortOnPrematureClose = (): void => {
    if (!reply.raw.writableEnded) {
      controller.abort();
    }
  };

  reply.raw.once("close", abortOnPrematureClose);
  if (reply.raw.destroyed && !reply.raw.writableEnded) {
    controller.abort();
  }

  try {
    return await operation(controller.signal);
  } finally {
    reply.raw.removeListener("close", abortOnPrematureClose);
  }
}
