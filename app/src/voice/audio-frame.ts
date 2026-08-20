export type VoiceAudioFormat = "pcm16" | "wav";

export const VOICE_AUDIO_FRAME_HEADER_BYTES = 24;
export const VOICE_AUDIO_FRAME_VERSION = 1;

export interface VoiceAudioFrameHeader {
  readonly format: VoiceAudioFormat;
  readonly channels: number;
  readonly sampleRate: number;
  readonly turnSequence: number;
  readonly chunkId: number;
  readonly audioDurationMs: number;
}

export interface VoiceAudioFrame {
  readonly header: VoiceAudioFrameHeader;
  readonly audio: Uint8Array;
}

/**
 * Every binary voice frame carries a fixed 24-byte little-endian header so the
 * browser can route audio to the right turn without a correlated JSON message:
 *
 *   0..3   magic "SHVA"
 *   4      protocol version
 *   5      payload format (1 = PCM16LE, 2 = WAV)
 *   6..7   channel count
 *   8..11  sample rate
 *   12..15 turn sequence
 *   16..19 chunk id within the turn
 *   20..23 generated audio duration in milliseconds
 */
export function encodeVoiceAudioFrame(
  header: VoiceAudioFrameHeader,
  audio: Uint8Array,
): Uint8Array {
  const frame = new Uint8Array(VOICE_AUDIO_FRAME_HEADER_BYTES + audio.byteLength);
  const view = new DataView(frame.buffer, frame.byteOffset, frame.byteLength);
  frame[0] = 0x53;
  frame[1] = 0x48;
  frame[2] = 0x56;
  frame[3] = 0x41;
  view.setUint8(4, VOICE_AUDIO_FRAME_VERSION);
  view.setUint8(5, header.format === "pcm16" ? 1 : 2);
  view.setUint16(6, clampUnsigned(header.channels, 0xffff), true);
  view.setUint32(8, clampUnsigned(header.sampleRate, 0xffffffff), true);
  view.setUint32(12, clampUnsigned(header.turnSequence, 0xffffffff), true);
  view.setUint32(16, clampUnsigned(header.chunkId, 0xffffffff), true);
  view.setUint32(20, clampUnsigned(header.audioDurationMs, 0xffffffff), true);
  frame.set(audio, VOICE_AUDIO_FRAME_HEADER_BYTES);
  return frame;
}

/**
 * Decodes a binary voice frame and returns null for anything unrecognized.
 *
 * The browser client embeds this function with `Function#toString`, so it must
 * stay self-contained and must not reference module-level bindings.
 */
export function decodeVoiceAudioFrame(
  data: ArrayBuffer | Uint8Array,
): VoiceAudioFrame | null {
  const bytes = data instanceof Uint8Array ? data : new Uint8Array(data);
  if (bytes.byteLength < 24) return null;
  if (
    bytes[0] !== 0x53 ||
    bytes[1] !== 0x48 ||
    bytes[2] !== 0x56 ||
    bytes[3] !== 0x41 ||
    bytes[4] !== 1
  ) {
    return null;
  }

  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const format = view.getUint8(5);
  if (format !== 1 && format !== 2) return null;

  return {
    header: {
      format: format === 1 ? "pcm16" : "wav",
      channels: view.getUint16(6, true),
      sampleRate: view.getUint32(8, true),
      turnSequence: view.getUint32(12, true),
      chunkId: view.getUint32(16, true),
      audioDurationMs: view.getUint32(20, true),
    },
    audio: bytes.subarray(24),
  };
}

function clampUnsigned(value: number, maximum: number): number {
  if (!Number.isFinite(value) || value <= 0) return 0;
  return Math.min(maximum, Math.round(value));
}
