import type { FastifyInstance, FastifyReply } from "fastify";
import { z } from "zod";

import type { ASRProvider, TTSProvider } from "../voice/provider.js";
import type { VoicePlaybackCoordinator } from "../voice/playback-coordinator.js";
import {
  parseVoiceTimestamp,
  parseVoiceTurnId,
  type VoicePerformanceTracker,
} from "../voice/voice-performance.js";
import { createVoicePage } from "../voice/voice-ui.js";
import { ApiError } from "./api-error.js";

const MAX_AUDIO_BYTES = 25 * 1024 * 1024;
const MAX_TTS_CHARACTERS = 4_000;
const SUPPORTED_AUDIO_TYPES = new Set([
  "audio/webm",
  "audio/ogg",
  "audio/mp4",
  "audio/mpeg",
  "audio/wav",
  "audio/x-wav",
  "video/webm",
  "application/octet-stream",
]);

const synthesisRequestSchema = z
  .object({
    text: z
      .string()
      .max(MAX_TTS_CHARACTERS)
      .refine((value) => value.trim().length > 0),
  })
  .strict();

const playbackEventSchema = z
  .object({
    event: z.enum(["scheduled", "started", "ended", "idle"]),
    sequence: z.number().int().nonnegative().optional(),
    timestampMs: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).optional(),
  })
  .strict()
  .superRefine((value, context) => {
    if (value.event !== "idle" && value.sequence === undefined) {
      context.addIssue({
        code: "custom",
        path: ["sequence"],
        message: "A sequence is required for chunk playback events.",
      });
    }
  });

interface VoiceRouteOptions {
  readonly asrProvider: ASRProvider;
  readonly ttsProvider: TTSProvider;
  readonly playbackCoordinator: VoicePlaybackCoordinator;
  readonly performance?: VoicePerformanceTracker;
}

export function registerVoiceRoutes(
  app: FastifyInstance,
  options: VoiceRouteOptions,
): void {
  for (const contentType of SUPPORTED_AUDIO_TYPES) {
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
    {
      onRequest: async (request) => {
        const turnId = parseVoiceTurnId(
          request.headers["x-shiva-voice-turn-id"],
        );
        if (turnId) {
          options.performance?.beginAudioUpload(turnId);
        }
      },
    },
    async (request, reply) => {
      const turnId = parseVoiceTurnId(
        request.headers["x-shiva-voice-turn-id"],
      );
      if (turnId) {
        options.performance?.markAudioUploaded(turnId);
      }

      const contentType = request.mediaType;
      if (!contentType || !SUPPORTED_AUDIO_TYPES.has(contentType)) {
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

      const startedAt = performance.now();
      try {
        const result = await withClientCancellation(reply, (signal) =>
          options.asrProvider.transcribe({
            audio: request.body as Buffer,
            contentType,
            filename: audioFilename(contentType),
            signal,
          }),
        );
        return reply.header("cache-control", "no-store").send(result);
      } finally {
        if (turnId) {
          options.performance?.recordAsrDuration(
            turnId,
            performance.now() - startedAt,
          );
        }
      }
    },
  );

  app.post<{ Body: unknown }>(
    "/voice/synthesize",
    async (request, reply) => {
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

      const turnId = parseVoiceTurnId(
        request.headers["x-shiva-voice-turn-id"],
      );
      const sequence = parseSequence(
        request.headers["x-shiva-voice-sequence"],
      );
      const textReadyAtUnixMs = parseVoiceTimestamp(
        request.headers["x-shiva-text-ready-at"],
      );
      if (turnId) {
        options.playbackCoordinator.markActive(turnId);
      }
      const startedAt = turnId
        ? options.performance?.markTtsStarted(turnId, sequence, {
            textLength: parsed.data.text.length,
            ...(textReadyAtUnixMs !== undefined ? { textReadyAtUnixMs } : {}),
          })
        : undefined;
      const result = await withClientCancellation(reply, (signal) =>
        options.ttsProvider.synthesize({
          text: parsed.data.text,
          signal,
        }),
      );
      if (turnId && startedAt !== undefined) {
        options.performance?.finishTts(
          turnId,
          sequence,
          startedAt,
          result.audio,
        );
      }

      return reply
        .header("cache-control", "no-store")
        .header("content-disposition", 'inline; filename="shiva.wav"')
        .type(result.contentType)
        .send(Buffer.from(result.audio));
    },
  );

  app.post<{ Body: unknown }>("/voice/playback", async (request, reply) => {
    if (request.mediaType !== "application/json") {
      throw new ApiError(
        415,
        "UNSUPPORTED_MEDIA_TYPE",
        "Content-Type must be application/json.",
      );
    }

    const turnId = parseVoiceTurnId(
      request.headers["x-shiva-voice-turn-id"],
    );
    const parsed = playbackEventSchema.safeParse(request.body);
    if (!turnId || !parsed.success) {
      throw new ApiError(
        400,
        "INVALID_REQUEST",
        "A valid voice turn ID and playback event are required.",
      );
    }

    const timestampUnixMs = parsed.data.timestampMs ?? Date.now();
    if (parsed.data.event === "idle") {
      options.performance?.finishPlaybackTurn(turnId);
      options.playbackCoordinator.markIdle(turnId);
    } else {
      options.playbackCoordinator.markActive(turnId);
      options.performance?.recordPlaybackEvent(
        turnId,
        parsed.data.sequence as number,
        parsed.data.event,
        timestampUnixMs,
      );
    }

    return reply.code(204).send();
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

function parseSequence(value: unknown): number {
  if (typeof value !== "string") {
    return 0;
  }
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : 0;
}

function audioFilename(contentType: string): string {
  switch (contentType) {
    case "audio/ogg":
      return "recording.ogg";
    case "audio/mp4":
      return "recording.m4a";
    case "audio/mpeg":
      return "recording.mp3";
    case "audio/wav":
    case "audio/x-wav":
      return "recording.wav";
    default:
      return "recording.webm";
  }
}
