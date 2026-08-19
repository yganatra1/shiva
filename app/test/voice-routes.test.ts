import assert from "node:assert/strict";
import { test } from "node:test";
import { Script } from "node:vm";

import { createApp } from "../src/app.js";
import type { AIProvider, ChatMessage } from "../src/brain/ai-provider.js";
import { VoiceConversationState } from "../src/voice/conversation-state.js";
import { createVoiceClientScript } from "../src/voice/voice-ui.js";
import {
  VoiceProviderError,
  type ASRInput,
  type ASRProvider,
  type SynthesisInput,
  type TTSProvider,
} from "../src/voice/provider.js";
import type { VoicePerformanceEntry } from "../src/voice/voice-performance.js";
import { createTestOverrides, testConfig } from "./test-support.js";

const TURN_ID = "10000000-0000-4000-8000-000000000001";

class FakeASRProvider implements ASRProvider {
  readonly inputs: ASRInput[] = [];

  async transcribe(input: ASRInput) {
    this.inputs.push(input);
    return { text: "Who is my travel partner?", language: "English" };
  }
}

class FakeTTSProvider implements TTSProvider {
  readonly texts: string[] = [];

  async synthesize(input: SynthesisInput) {
    this.texts.push(input.text);
    return { audio: wavBytes(), contentType: "audio/wav" as const };
  }
}

const chatProvider: AIProvider = {
  async chat() {
    return { content: '{"memories":[]}' };
  },
  async *streamChat() {
    yield { content: "Your travel partner is Charmi." };
  },
};

test("voice proxy routes use provider abstractions and serve the browser UI", async (context) => {
  const asr = new FakeASRProvider();
  const tts = new FakeTTSProvider();
  const app = createApp(testConfig, {
    ...createTestOverrides(chatProvider),
    asrProvider: asr,
    ttsProvider: tts,
  });
  context.after(() => app.close());

  const page = await app.inject({ method: "GET", url: "/voice" });
  assert.equal(page.statusCode, 200);
  assert.match(page.body, /getUserMedia/);
  assert.match(page.body, /\/voice\/chat/);
  assert.match(page.body, /AudioContext/);
  assert.match(page.body, /\/voice\/playback/);
  assert.match(page.body, /x-shiva-text-ready-at/);
  assert.doesNotMatch(page.body, /synthesisChain/);
  assert.doesNotMatch(page.body, /fetch\("\/chat"/);

  const transcription = await app.inject({
    method: "POST",
    url: "/voice/transcribe",
    headers: { "content-type": "audio/webm" },
    payload: Buffer.from([1, 2, 3]),
  });
  assert.equal(transcription.statusCode, 200);
  assert.deepEqual(transcription.json(), {
    text: "Who is my travel partner?",
    language: "English",
  });
  assert.equal(asr.inputs[0]?.contentType, "audio/webm");

  const synthesis = await app.inject({
    method: "POST",
    url: "/voice/synthesize",
    headers: { "content-type": "application/json" },
    payload: { text: "Your travel partner is Charmi." },
  });
  assert.equal(synthesis.statusCode, 200);
  assert.equal(synthesis.headers["content-type"], "audio/wav");
  assert.deepEqual(tts.texts, ["Your travel partner is Charmi."]);
});

test("voice routes map invalid audio and provider outages safely", async (context) => {
  const asr: ASRProvider = {
    async transcribe() {
      throw new VoiceProviderError("asr", "UNAVAILABLE", "internal address");
    },
  };
  const tts: TTSProvider = {
    async synthesize() {
      throw new VoiceProviderError("tts", "UNAVAILABLE", "internal address");
    },
  };
  const app = createApp(testConfig, {
    ...createTestOverrides(chatProvider),
    asrProvider: asr,
    ttsProvider: tts,
  });
  context.after(() => app.close());

  const invalid = await app.inject({
    method: "POST",
    url: "/voice/transcribe",
    headers: { "content-type": "audio/webm" },
    payload: Buffer.alloc(0),
  });
  assert.equal(invalid.statusCode, 400);
  assert.equal(invalid.json().error.code, "INVALID_AUDIO");

  const asrUnavailable = await app.inject({
    method: "POST",
    url: "/voice/transcribe",
    headers: { "content-type": "audio/webm" },
    payload: Buffer.from([1]),
  });
  assert.equal(asrUnavailable.statusCode, 503);
  assert.deepEqual(asrUnavailable.json(), {
    error: {
      code: "ASR_UNAVAILABLE",
      message: "Shiva's transcription service is currently unavailable.",
    },
  });

  const ttsUnavailable = await app.inject({
    method: "POST",
    url: "/voice/synthesize",
    headers: { "content-type": "application/json" },
    payload: { text: "Hello" },
  });
  assert.equal(ttsUnavailable.statusCode, 503);
  assert.equal(ttsUnavailable.json().error.code, "TTS_UNAVAILABLE");
});

test("voice chat reuses the shared pipeline and conversation ID with voice guidance", async (context) => {
  const prompts: readonly ChatMessage[][] = [];
  const mutablePrompts = prompts as ChatMessage[][];
  const provider: AIProvider = {
    async chat() {
      return { content: '{"memories":[]}' };
    },
    async *streamChat(input) {
      mutablePrompts.push([...input.messages]);
      yield { content: "A concise spoken answer." };
    },
  };
  const app = createApp(testConfig, {
    ...createTestOverrides(provider),
    asrProvider: new FakeASRProvider(),
    ttsProvider: new FakeTTSProvider(),
  });
  context.after(() => app.close());

  const first = await app.inject({
    method: "POST",
    url: "/voice/chat",
    headers: { "content-type": "application/json" },
    payload: { message: "Tell me something." },
  });
  const conversationId = first.headers["x-shiva-conversation-id"];
  assert.equal(first.statusCode, 200);
  assert.equal(typeof conversationId, "string");

  const second = await app.inject({
    method: "POST",
    url: "/voice/chat",
    headers: { "content-type": "application/json" },
    payload: { message: "Continue.", conversationId },
  });
  assert.equal(second.statusCode, 200);
  assert.equal(second.headers["x-shiva-conversation-id"], conversationId);
  assert.match(
    prompts[0]?.map((message) => message.content).join("\n") ?? "",
    /spoken aloud.*smooth, connected natural speech/s,
  );
  assert.doesNotMatch(
    prompts[0]?.map((message) => message.content).join("\n") ?? "",
    /Prefer short sentences/,
  );

  await app.inject({
    method: "POST",
    url: "/chat",
    headers: { "content-type": "application/json" },
    payload: { message: "Text mode." },
  });
  assert.doesNotMatch(
    prompts[2]?.map((message) => message.content).join("\n") ?? "",
    /spoken aloud/,
  );
});

test("voice performance tracing correlates upload, chat TTFT, and first audio", async (context) => {
  const logs: VoicePerformanceEntry[] = [];
  const app = createApp(
    { ...testConfig, performanceLogging: true },
    {
      ...createTestOverrides(chatProvider),
      asrProvider: new FakeASRProvider(),
      ttsProvider: new FakeTTSProvider(),
      voicePerformanceLogSink: (entry) => logs.push(entry),
    },
  );
  context.after(() => app.close());

  await app.inject({
    method: "POST",
    url: "/voice/transcribe",
    headers: {
      "content-type": "audio/webm",
      "x-shiva-voice-turn-id": TURN_ID,
    },
    payload: Buffer.from([1]),
  });
  await app.inject({
    method: "POST",
    url: "/voice/chat",
    headers: {
      "content-type": "application/json",
      "x-shiva-voice-turn-id": TURN_ID,
    },
    payload: { message: "Hello" },
  });
  await app.inject({
    method: "POST",
    url: "/voice/synthesize",
    headers: {
      "content-type": "application/json",
      "x-shiva-voice-turn-id": TURN_ID,
      "x-shiva-voice-sequence": "0",
    },
    payload: { text: "Hello." },
  });

  assert.equal(logs.length, 1);
  const summary = logs.find((entry) => entry.kind === "voice");
  assert.ok(summary);
  for (const stage of [
    "audio-upload",
    "asr-duration",
    "chat-ttft",
    "first-tts-request",
    "tts-duration",
    "time-to-first-audio",
  ] as const) {
    assert.equal(typeof summary.timingsMs[stage], "number", stage);
  }
});

test("browser conversation state captures, reuses, and clears the existing ID contract", () => {
  const values = new Map<string, string>();
  const storage = {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => void values.set(key, value),
    removeItem: (key: string) => void values.delete(key),
  };
  const state = new VoiceConversationState(storage);

  assert.deepEqual(state.chatPayload("First"), { message: "First" });
  state.captureResponse({ get: () => TURN_ID });
  assert.deepEqual(state.chatPayload("Second"), {
    message: "Second",
    conversationId: TURN_ID,
  });
  state.clear();
  assert.deepEqual(state.chatPayload("Fresh"), { message: "Fresh" });
});

test("served voice client is valid framework-free JavaScript", () => {
  assert.doesNotThrow(() => new Script(createVoiceClientScript()));
});

function wavBytes(): Uint8Array {
  return new Uint8Array([
    82, 73, 70, 70, 36, 0, 0, 0, 87, 65, 86, 69, 102, 109, 116, 32,
  ]);
}
