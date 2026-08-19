import assert from "node:assert/strict";
import { test } from "node:test";

import { HttpASRProvider } from "../src/voice/http-asr-provider.js";
import { HttpTTSProvider } from "../src/voice/http-tts-provider.js";
import { VoiceProviderError } from "../src/voice/provider.js";

test("HTTP ASR provider uploads audio and validates the transcription", async () => {
  let uploadedFile: unknown;
  const provider = new HttpASRProvider({
    baseUrl: "http://127.0.0.1:8101",
    requestTimeoutMs: 1_000,
    fetchImplementation: (async (_input, init) => {
      assert.ok(init?.body instanceof FormData);
      uploadedFile = init.body.get("file");
      return Response.json({
        text: "Who is my travel partner?",
        language: "English",
      });
    }) as typeof fetch,
  });

  const result = await provider.transcribe({
    audio: new Uint8Array([1, 2, 3]),
    contentType: "audio/webm",
    filename: "recording.webm",
  });

  assert.ok(uploadedFile instanceof Blob);
  assert.equal(uploadedFile.type, "audio/webm");
  assert.deepEqual(result, {
    text: "Who is my travel partner?",
    language: "English",
  });
});

test("HTTP ASR provider classifies invalid audio and unavailability", async () => {
  const input = {
    audio: new Uint8Array([1]),
    contentType: "audio/webm",
    filename: "recording.webm",
  };
  const invalid = new HttpASRProvider({
    baseUrl: "http://127.0.0.1:8101",
    requestTimeoutMs: 1_000,
    fetchImplementation: (async () =>
      new Response("invalid", { status: 400 })) as typeof fetch,
  });
  const unavailable = new HttpASRProvider({
    baseUrl: "http://127.0.0.1:8101",
    requestTimeoutMs: 1_000,
    fetchImplementation: (async () => {
      throw new TypeError("connection refused");
    }) as typeof fetch,
  });
  const upstreamUnavailable = new HttpASRProvider({
    baseUrl: "http://127.0.0.1:8101",
    requestTimeoutMs: 1_000,
    fetchImplementation: (async () =>
      Response.json(
        { detail: "internal diagnostic that must not escape" },
        { status: 503 },
      )) as typeof fetch,
  });

  await expectVoiceFailure(invalid.transcribe(input), "asr", "INVALID_AUDIO");
  await expectVoiceFailure(
    unavailable.transcribe(input),
    "asr",
    "UNAVAILABLE",
  );
  await expectVoiceFailure(
    upstreamUnavailable.transcribe(input),
    "asr",
    "UNAVAILABLE",
  );
});

test("HTTP TTS provider sends text and accepts only valid WAV", async () => {
  let requestBody: unknown;
  const provider = new HttpTTSProvider({
    baseUrl: "http://127.0.0.1:8102",
    requestTimeoutMs: 1_000,
    fetchImplementation: (async (_input, init) => {
      requestBody = JSON.parse(String(init?.body)) as unknown;
      return new Response(wavBytes(), {
        headers: { "content-type": "audio/wav" },
      });
    }) as typeof fetch,
  });

  const result = await provider.synthesize({ text: "Hello, Yash." });

  assert.deepEqual(requestBody, { text: "Hello, Yash." });
  assert.equal(result.contentType, "audio/wav");
  assert.deepEqual(result.audio, wavBytes());
});

test("HTTP TTS provider rejects malformed audio", async () => {
  const provider = new HttpTTSProvider({
    baseUrl: "http://127.0.0.1:8102",
    requestTimeoutMs: 1_000,
    fetchImplementation: (async () =>
      new Response("not-wave", {
        headers: { "content-type": "audio/wav" },
      })) as typeof fetch,
  });

  await expectVoiceFailure(
    provider.synthesize({ text: "Hello" }),
    "tts",
    "INVALID_RESPONSE",
  );
});

test("HTTP TTS provider classifies an upstream 503 as unavailable", async () => {
  const provider = new HttpTTSProvider({
    baseUrl: "http://127.0.0.1:8102",
    requestTimeoutMs: 1_000,
    fetchImplementation: (async () =>
      Response.json(
        { detail: "internal diagnostic that must not escape" },
        { status: 503 },
      )) as typeof fetch,
  });

  await expectVoiceFailure(
    provider.synthesize({ text: "Hello" }),
    "tts",
    "UNAVAILABLE",
  );
});

function wavBytes(): Uint8Array {
  return new Uint8Array([
    82, 73, 70, 70, 36, 0, 0, 0, 87, 65, 86, 69, 102, 109, 116, 32,
  ]);
}

async function expectVoiceFailure(
  operation: Promise<unknown>,
  service: "asr" | "tts",
  failure: VoiceProviderError["failure"],
): Promise<void> {
  await assert.rejects(
    operation,
    (error: unknown) =>
      error instanceof VoiceProviderError &&
      error.service === service &&
      error.failure === failure,
  );
}
