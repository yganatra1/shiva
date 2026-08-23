import { z } from "zod";

import type { VoiceAudioFormat } from "./audio-frame";

export const VOICE_PROTOCOL_VERSION = 1;
export const MAX_VOICE_TEXT_CHARACTERS = 20_000;

/**
 * Control messages travel as JSON text frames. Speech audio travels as binary
 * frames in both directions: client binary frames are microphone container
 * bytes, server binary frames are `audio-frame.ts` payloads.
 *
 * The `audio_start`/`audio_end` names appear in both directions and are
 * disambiguated by direction: client-to-server means microphone capture,
 * server-to-client means Shiva's spoken response.
 */
const clientVoiceMessageSchema = z.discriminatedUnion("type", [
  z
    .object({
      type: z.literal("session_start"),
      conversationId: z.string().uuid().optional(),
    })
    .strict(),
  z
    .object({
      type: z.literal("user_text"),
      text: z
        .string()
        .max(MAX_VOICE_TEXT_CHARACTERS)
        .refine((text) => text.trim().length > 0, {
          message: "Message must contain non-whitespace characters.",
        }),
    })
    .strict(),
  z
    .object({
      type: z.literal("audio_start"),
      mimeType: z.string().trim().min(1).max(128).optional(),
    })
    .strict(),
  z.object({ type: z.literal("audio_end") }).strict(),
  z.object({ type: z.literal("interrupt") }).strict(),
  z.object({ type: z.literal("session_end") }).strict(),
  z
    .object({
      type: z.literal("playback"),
      turnId: z.string().uuid(),
      event: z.enum([
        "received",
        "scheduled",
        "started",
        "ended",
        "underrun",
        "idle",
      ]),
      chunkId: z.number().int().nonnegative().max(0xffffffff).optional(),
      timestampMs: z
        .number()
        .int()
        .nonnegative()
        .max(Number.MAX_SAFE_INTEGER)
        .optional(),
      decodeDurationMs: z.number().nonnegative().max(600_000).optional(),
      underrunMs: z.number().nonnegative().max(600_000).optional(),
    })
    .strict()
    .superRefine((value, context) => {
      if (value.event !== "idle" && value.chunkId === undefined) {
        context.addIssue({
          code: "custom",
          path: ["chunkId"],
          message: "A chunk id is required for chunk playback events.",
        });
      }
    }),
]);

export type ClientVoiceMessage = z.infer<typeof clientVoiceMessageSchema>;
export type ClientVoiceMessageType = ClientVoiceMessage["type"];

export type VoiceTurnEndReason = "completed" | "interrupted" | "error";

export type VoiceErrorCode =
  | "INVALID_MESSAGE"
  | "SESSION_NOT_STARTED"
  | "INVALID_AUDIO"
  | "ASR_UNAVAILABLE"
  | "TTS_UNAVAILABLE"
  | "MODEL_UNAVAILABLE"
  | "CONVERSATION_NOT_FOUND"
  | "INTERNAL_ERROR";

export type ServerVoiceMessage =
  | {
      readonly type: "session_ready";
      readonly sessionId: string;
      readonly protocolVersion: number;
      readonly conversationId: string | null;
      /** Format the gateway will use whenever TTS output can be unwrapped. */
      readonly preferredAudioFormat: VoiceAudioFormat;
      readonly audioFrameHeaderBytes: number;
    }
  | {
      readonly type: "transcript_partial";
      readonly turnId: string;
      readonly text: string;
    }
  | {
      readonly type: "transcript_final";
      readonly turnId: string;
      readonly text: string;
      readonly language: string;
    }
  | {
      readonly type: "assistant_text_delta";
      readonly turnId: string;
      readonly text: string;
    }
  | {
      readonly type: "assistant_text_done";
      readonly turnId: string;
      readonly text: string;
    }
  | {
      readonly type: "audio_start";
      readonly turnId: string;
      readonly turnSequence: number;
      readonly format: VoiceAudioFormat;
      readonly sampleRate: number;
      readonly channels: number;
    }
  | {
      readonly type: "audio_end";
      readonly turnId: string;
      readonly turnSequence: number;
      readonly chunkCount: number;
    }
  | {
      readonly type: "turn_done";
      readonly turnId: string;
      readonly turnSequence: number;
      readonly conversationId: string | null;
      readonly reason: VoiceTurnEndReason;
    }
  | {
      readonly type: "error";
      readonly code: VoiceErrorCode;
      readonly message: string;
      readonly turnId?: string;
    };

export type ServerVoiceMessageType = ServerVoiceMessage["type"];

export type ParsedClientVoiceMessage =
  | { readonly ok: true; readonly message: ClientVoiceMessage }
  | { readonly ok: false; readonly reason: string };

export function parseClientVoiceMessage(raw: string): ParsedClientVoiceMessage {
  if (raw.length > MAX_VOICE_TEXT_CHARACTERS * 2) {
    return { ok: false, reason: "The control message is too large." };
  }

  let payload: unknown;
  try {
    payload = JSON.parse(raw);
  } catch {
    return { ok: false, reason: "The control message is not valid JSON." };
  }

  const parsed = clientVoiceMessageSchema.safeParse(payload);
  if (!parsed.success) {
    return {
      ok: false,
      reason: "The control message does not match the voice protocol.",
    };
  }
  return { ok: true, message: parsed.data };
}
