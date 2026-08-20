import assert from "node:assert/strict";
import { test } from "node:test";

import {
  decodeVoiceAudioFrame,
  encodeVoiceAudioFrame,
  VOICE_AUDIO_FRAME_HEADER_BYTES,
} from "../src/voice/audio-frame.js";
import {
  hasWavHeader,
  parseWavPcm16,
  wavDurationMs,
} from "../src/voice/wav-audio.js";
import { createWavBytes } from "./voice-test-support.js";

test("binary voice frames round-trip header metadata and payload", () => {
  const audio = new Uint8Array([1, 2, 3, 4, 5, 6]);
  const frame = encodeVoiceAudioFrame(
    {
      format: "pcm16",
      channels: 1,
      sampleRate: 24_000,
      turnSequence: 7,
      chunkId: 3,
      audioDurationMs: 420,
    },
    audio,
  );

  assert.equal(frame.byteLength, VOICE_AUDIO_FRAME_HEADER_BYTES + audio.byteLength);
  const decoded = decodeVoiceAudioFrame(frame);
  assert.ok(decoded);
  assert.deepEqual(decoded.header, {
    format: "pcm16",
    channels: 1,
    sampleRate: 24_000,
    turnSequence: 7,
    chunkId: 3,
    audioDurationMs: 420,
  });
  assert.deepEqual([...decoded.audio], [...audio]);
});

test("embedded decode stays self-contained for the browser client", () => {
  const EmbeddedDecode = Function(
    `"use strict"; return (${decodeVoiceAudioFrame.toString()});`,
  )() as typeof decodeVoiceAudioFrame;
  const frame = encodeVoiceAudioFrame(
    {
      format: "wav",
      channels: 2,
      sampleRate: 16_000,
      turnSequence: 1,
      chunkId: 0,
      audioDurationMs: 10,
    },
    new Uint8Array([9, 8, 7]),
  );
  const decoded = EmbeddedDecode(frame);
  assert.ok(decoded);
  assert.equal(decoded.header.format, "wav");
  assert.deepEqual([...decoded.audio], [9, 8, 7]);
});

test("decode rejects truncated or unrecognized frames", () => {
  assert.equal(decodeVoiceAudioFrame(new Uint8Array(8)), null);
  const frame = encodeVoiceAudioFrame(
    {
      format: "pcm16",
      channels: 1,
      sampleRate: 16_000,
      turnSequence: 1,
      chunkId: 0,
      audioDurationMs: 1,
    },
    new Uint8Array([1]),
  );
  frame[0] = 0;
  assert.equal(decodeVoiceAudioFrame(frame), null);
});

test("WAV PCM16 parsing strips the container and reports duration", () => {
  const wav = new Uint8Array(createWavBytes(250));
  assert.equal(hasWavHeader(wav), true);
  const parsed = parseWavPcm16(wav);
  assert.ok(parsed);
  assert.equal(parsed.sampleRate, 16_000);
  assert.equal(parsed.channels, 1);
  assert.equal(parsed.durationMs, 250);
  assert.equal(parsed.samples.byteLength, wav.byteLength - 44);
  assert.equal(wavDurationMs(wav), 250);
});

test("non PCM16 WAV payloads fall back instead of claiming PCM", () => {
  const wav = Buffer.from("RIFF....WAVEfmt ");
  assert.equal(parseWavPcm16(new Uint8Array(wav)), undefined);
  assert.equal(hasWavHeader(new Uint8Array([1, 2, 3])), false);
});
