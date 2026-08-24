import assert from "node:assert/strict";
import { test } from "node:test";

import { createApp } from "../src/app.js";
import type { AIProvider } from "../src/brain/ai-provider.js";
import { CoreUpdateHub } from "../src/core/core-update-hub.js";
import { decodeVoiceAudioFrame } from "../src/voice/audio-frame.js";
import type { ASRInput, ASRProvider, SynthesisInput, TTSProvider } from "../src/voice/provider.js";
import type { ServerVoiceMessage } from "../src/voice/voice-protocol.js";
import { createTestOverrides, InMemoryRepository, testConfig } from "./test-support.js";
import { createWavBytes } from "./voice-test-support.js";

const ANSWER =
  "India has a huge and young population. That creates enormous economic " +
  "potential, but it also strains housing and transport in the biggest cities.";

const chatProvider: AIProvider = {
  async chat() {
    return { content: '{"memories":[]}' };
  },
  async *streamChat() {
    for (const part of ANSWER.split(/(?<=\. )/)) {
      yield { content: part };
    }
  },
};

class SocketASRProvider implements ASRProvider {
  readonly inputs: ASRInput[] = [];

  async transcribe(input: ASRInput) {
    this.inputs.push(input);
    return { text: "Who is my travel partner?", language: "English" };
  }
}

class SocketTTSProvider implements TTSProvider {
  readonly texts: string[] = [];

  async synthesize(input: SynthesisInput) {
    this.texts.push(input.text);
    return { audio: new Uint8Array(createWavBytes(300)), contentType: "audio/wav" as const };
  }
}

/** Buffers everything a live socket receives, in arrival order. */
class SocketRecorder {
  readonly controls: ServerVoiceMessage[] = [];
  readonly frames: { turnSequence: number; chunkId: number; bytes: number }[] = [];
  readonly ordered: string[] = [];
  private readonly waiters: (() => void)[] = [];

  constructor(private readonly socket: WebSocket) {
    socket.binaryType = "arraybuffer";
    socket.addEventListener("message", (event: MessageEvent) => {
      if (typeof event.data === "string") {
        const message = JSON.parse(event.data) as ServerVoiceMessage;
        this.controls.push(message);
        this.ordered.push(message.type);
      } else {
        const frame = decodeVoiceAudioFrame(event.data as ArrayBuffer);
        assert.ok(frame, "Every binary voice frame must be decodable.");
        this.frames.push({
          turnSequence: frame.header.turnSequence,
          chunkId: frame.header.chunkId,
          bytes: frame.audio.byteLength,
        });
        this.ordered.push(`audio:${frame.header.chunkId}`);
      }
      for (const waiter of this.waiters.splice(0)) waiter();
    });
  }

  send(message: unknown): void {
    this.socket.send(JSON.stringify(message));
  }

  sendBinary(bytes: Uint8Array): void {
    this.socket.send(bytes);
  }

  controlsOfType<TType extends ServerVoiceMessage["type"]>(
    type: TType,
  ): Extract<ServerVoiceMessage, { type: TType }>[] {
    return this.controls.filter(
      (message): message is Extract<ServerVoiceMessage, { type: TType }> =>
        message.type === type,
    );
  }

  text(): string {
    return this.controlsOfType("assistant_text_delta")
      .map((message) => message.text)
      .join("");
  }

  async waitFor(condition: () => boolean, label: string): Promise<void> {
    const deadline = Date.now() + 5_000;
    while (!condition()) {
      if (Date.now() > deadline) {
        assert.fail(`Timed out waiting for ${label}.`);
      }
      await Promise.race([
        new Promise<void>((resolve) => this.waiters.push(resolve)),
        new Promise<void>((resolve) => setTimeout(resolve, 25)),
      ]);
    }
  }
}

async function openVoiceSocket(
  app: ReturnType<typeof createApp>,
): Promise<SocketRecorder> {
  const socket = await app.injectWS("/voice/chat");
  const recorder = new SocketRecorder(socket as unknown as WebSocket);
  return recorder;
}

test("the voice socket carries a whole typed turn on one connection", async (context) => {
  const asr = new SocketASRProvider();
  const tts = new SocketTTSProvider();
  const app = createApp(testConfig, {
    ...createTestOverrides(chatProvider),
    asrProvider: asr,
    ttsProvider: tts,
  });
  context.after(() => app.close());
  await app.ready();

  const socket = await openVoiceSocket(app);
  socket.send({ type: "session_start" });
  await socket.waitFor(
    () => socket.controlsOfType("session_ready").length === 1,
    "session_ready",
  );
  const ready = socket.controlsOfType("session_ready")[0];
  assert.ok(ready);
  assert.equal(ready.protocolVersion, 1);
  assert.equal(ready.preferredAudioFormat, "pcm16");

  socket.send({ type: "user_text", text: "Tell me about India." });
  await socket.waitFor(
    () => socket.controlsOfType("turn_done").length === 1,
    "turn_done",
  );

  assert.equal(socket.text(), ANSWER);
  assert.ok(tts.texts.length >= 1, "speech must be synthesized");
  assert.ok(socket.frames.length >= 1, "audio must arrive as binary frames");
  assert.deepEqual(
    socket.frames.map((frame) => frame.chunkId),
    socket.frames.map((_frame, index) => index),
  );
  assert.ok(socket.frames.every((frame) => frame.bytes > 0));
  assert.ok(
    socket.ordered.indexOf("audio_start") < socket.ordered.indexOf("audio:0"),
  );
  assert.equal(
    socket.controlsOfType("audio_end")[0]?.chunkCount,
    socket.frames.length,
  );
  assert.equal(socket.controlsOfType("turn_done")[0]?.reason, "completed");
  assert.doesNotMatch(
    socket.ordered.join(","),
    /synthesize/,
    "TTS must stay on the socket, not a REST path",
  );
});

test("microphone bytes stream in as binary and come back as speech", async (context) => {
  const asr = new SocketASRProvider();
  const app = createApp(testConfig, {
    ...createTestOverrides(chatProvider),
    asrProvider: asr,
    ttsProvider: new SocketTTSProvider(),
  });
  context.after(() => app.close());
  await app.ready();

  const socket = await openVoiceSocket(app);
  socket.send({ type: "session_start" });
  await socket.waitFor(
    () => socket.controlsOfType("session_ready").length === 1,
    "session_ready",
  );

  socket.send({ type: "audio_start", mimeType: "audio/webm;codecs=opus" });
  socket.sendBinary(new Uint8Array([1, 2, 3]));
  socket.sendBinary(new Uint8Array([4, 5, 6]));
  socket.send({ type: "audio_end" });
  await socket.waitFor(
    () => socket.controlsOfType("turn_done").length === 1,
    "turn_done",
  );

  assert.deepEqual([...(asr.inputs[0]?.audio ?? [])], [1, 2, 3, 4, 5, 6]);
  assert.equal(asr.inputs[0]?.contentType, "audio/webm");
  assert.equal(
    socket.controlsOfType("transcript_final")[0]?.text,
    "Who is my travel partner?",
  );
  assert.ok(socket.frames.length >= 1);
});

test("an interrupt stops the turn and no later audio arrives", async (context) => {
  const app = createApp(testConfig, {
    ...createTestOverrides({
      async chat() {
        return { content: '{"memories":[]}' };
      },
      async *streamChat() {
        yield { content: "This first sentence is quite long enough to speak. " };
        await new Promise((resolve) => setTimeout(resolve, 200));
        yield { content: "This second sentence must never be spoken aloud." };
      },
    }),
    asrProvider: new SocketASRProvider(),
    ttsProvider: new SocketTTSProvider(),
  });
  context.after(() => app.close());
  await app.ready();

  const socket = await openVoiceSocket(app);
  socket.send({ type: "session_start" });
  await socket.waitFor(
    () => socket.controlsOfType("session_ready").length === 1,
    "session_ready",
  );
  socket.send({ type: "user_text", text: "Tell me a long story." });
  await socket.waitFor(() => socket.frames.length >= 1, "the first audio frame");

  socket.send({ type: "interrupt" });
  await socket.waitFor(
    () => socket.controlsOfType("turn_done").length === 1,
    "turn_done",
  );
  const framesAtInterrupt = socket.frames.length;
  assert.equal(socket.controlsOfType("turn_done")[0]?.reason, "interrupted");

  await new Promise((resolve) => setTimeout(resolve, 300));
  assert.equal(socket.frames.length, framesAtInterrupt, "stale audio leaked");
  assert.equal(socket.controlsOfType("audio_end").length, 0);
});

test("a reconnect resumes the same conversation and rejects bad messages", async (context) => {
  const repository = new InMemoryRepository();
  const app = createApp(testConfig, {
    ...createTestOverrides(chatProvider, repository),
    asrProvider: new SocketASRProvider(),
    ttsProvider: new SocketTTSProvider(),
  });
  context.after(() => app.close());
  await app.ready();

  const first = await openVoiceSocket(app);
  first.send({ type: "session_start" });
  await first.waitFor(
    () => first.controlsOfType("session_ready").length === 1,
    "session_ready",
  );
  first.send({ type: "user_text", text: "First question." });
  await first.waitFor(
    () => first.controlsOfType("turn_done").length === 1,
    "turn_done",
  );
  const conversationId = first.controlsOfType("turn_done")[0]?.conversationId;
  assert.equal(typeof conversationId, "string");

  const second = await openVoiceSocket(app);
  second.send({ type: "session_start", conversationId });
  await second.waitFor(
    () => second.controlsOfType("session_ready").length === 1,
    "session_ready",
  );
  assert.equal(
    second.controlsOfType("session_ready")[0]?.conversationId,
    conversationId,
  );

  // A malformed frame is reported without dropping the live session.
  second.send({ type: "user_text" });
  await second.waitFor(
    () => second.controlsOfType("error").length === 1,
    "an INVALID_MESSAGE error",
  );
  assert.equal(second.controlsOfType("error")[0]?.code, "INVALID_MESSAGE");

  second.send({ type: "user_text", text: "Second question." });
  await second.waitFor(
    () => second.controlsOfType("turn_done").length === 1,
    "turn_done",
  );
  assert.equal(
    second.controlsOfType("turn_done")[0]?.conversationId,
    conversationId,
  );
  assert.equal(
    repository.messages.filter((message) => message.role === "user").length,
    2,
  );
});

test("the voice socket receives Core agent outcomes without another client connection", async (context) => {
  const updates = new CoreUpdateHub();
  const app = createApp(testConfig, {
    ...createTestOverrides(chatProvider),
    asrProvider: new SocketASRProvider(),
    ttsProvider: new SocketTTSProvider(),
    coreUpdateHub: updates,
  });
  context.after(() => app.close());
  await app.ready();

  const conversationId = "10000000-0000-4000-8000-000000000201";
  const socket = await openVoiceSocket(app);
  socket.send({ type: "session_start", conversationId });
  await socket.waitFor(
    () => socket.controlsOfType("session_ready").length === 1,
    "session_ready",
  );

  updates.publish({
    messageId: "20000000-0000-4000-8000-000000000201",
    conversationId: "10000000-0000-4000-8000-000000000202",
    message: "Wrong conversation.",
    timestamp: "2026-08-24T10:00:00.000Z",
  });
  updates.publish({
    messageId: "20000000-0000-4000-8000-000000000202",
    conversationId,
    message: "Mom did not answer, so I added ₹500 to the expense sheet.",
    timestamp: "2026-08-24T10:00:01.000Z",
  });
  await socket.waitFor(
    () => socket.controlsOfType("core_update").length === 1,
    "Core agent outcome",
  );

  assert.deepEqual(socket.controlsOfType("core_update"), [
    {
      type: "core_update",
      messageId: "20000000-0000-4000-8000-000000000202",
      conversationId,
      message: "Mom did not answer, so I added ₹500 to the expense sheet.",
      timestamp: "2026-08-24T10:00:01.000Z",
    },
  ]);
});

test("a plain GET on the voice endpoint asks for an upgrade", async (context) => {
  const app = createApp(testConfig, {
    ...createTestOverrides(chatProvider),
    asrProvider: new SocketASRProvider(),
    ttsProvider: new SocketTTSProvider(),
  });
  context.after(() => app.close());

  const response = await app.inject({ method: "GET", url: "/voice/chat" });
  assert.equal(response.statusCode, 426);
  assert.equal(response.json().error.code, "UPGRADE_REQUIRED");
});
