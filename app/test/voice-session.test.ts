import assert from "node:assert/strict";
import { test } from "node:test";

import { AIProviderError } from "../src/brain/ai-provider.js";
import { VoicePlaybackCoordinator } from "../src/voice/playback-coordinator.js";
import { VoiceProviderError } from "../src/voice/provider.js";
import {
  formatVoicePerformanceLog,
  VoicePerformanceTracker,
  type VoicePerformanceEntry,
  type VoiceTtsChunkPerformanceLog,
} from "../src/voice/voice-performance.js";
import { VoiceSession } from "../src/voice/voice-session.js";
import {
  ControlledChatProvider,
  createChatService,
  createWavBytes,
  FakeASRProvider,
  FakeTTSProvider,
  RecordingTransport,
  RecordingTransport as Transport,
  sequentialIds,
  staticChatProvider,
  waitFor,
} from "./voice-test-support.js";
import { FakeExtractionEngine, InMemoryRepository } from "./test-support.js";

const LONG_ANSWER =
  "India has a huge and young population. That creates enormous economic " +
  "potential, but it also puts real pressure on infrastructure, housing, and " +
  "public services in the largest cities.";

interface SessionHarness {
  readonly session: VoiceSession;
  readonly transport: Transport;
  readonly asr: FakeASRProvider;
  readonly tts: FakeTTSProvider;
}

function createSession(
  options: {
    readonly provider?: Parameters<typeof createChatService>[0];
    readonly tts?: FakeTTSProvider;
    readonly asr?: FakeASRProvider;
    readonly repository?: InMemoryRepository;
    readonly playbackCoordinator?: VoicePlaybackCoordinator;
    readonly performance?: VoicePerformanceTracker;
    readonly extractionEngine?: FakeExtractionEngine;
  } = {},
): SessionHarness {
  const transport = new RecordingTransport();
  const tts = options.tts ?? new FakeTTSProvider();
  const asr = options.asr ?? new FakeASRProvider();
  const { chatService } = createChatService(
    options.provider ?? staticChatProvider(LONG_ANSWER),
    options.repository ?? new InMemoryRepository(),
    options.extractionEngine ?? new FakeExtractionEngine(),
    options.playbackCoordinator,
  );
  const session = new VoiceSession({
    transport,
    chatService,
    asrProvider: asr,
    ttsProvider: tts,
    createId: sequentialIds(),
    chunker: {
      firstMinChars: 20,
      firstTargetChars: 40,
      subsequentMinChars: 40,
      subsequentTargetChars: 80,
      hardMaxChars: 120,
    },
    ...(options.playbackCoordinator
      ? { playbackCoordinator: options.playbackCoordinator }
      : {}),
    ...(options.performance ? { performance: options.performance } : {}),
  });
  return { session, transport, asr, tts };
}

function startSession(harness: SessionHarness, conversationId?: string): void {
  harness.session.handleTextMessage(
    JSON.stringify(
      conversationId
        ? { type: "session_start", conversationId }
        : { type: "session_start" },
    ),
  );
}

test("a typed turn streams text, then ordered binary audio, on one session", async () => {
  const harness = createSession();
  startSession(harness);

  const ready = harness.transport.controlsOfType("session_ready")[0];
  assert.ok(ready);
  assert.equal(ready.protocolVersion, 1);
  assert.equal(ready.preferredAudioFormat, "pcm16");
  assert.equal(ready.conversationId, null);

  harness.session.handleTextMessage(
    JSON.stringify({ type: "user_text", text: "Tell me about India." }),
  );
  await harness.session.whenSettled();
  await waitFor(() => harness.transport.controlsOfType("turn_done").length === 1);

  assert.equal(harness.transport.text(), LONG_ANSWER);
  assert.ok(harness.tts.texts.length >= 2, "the answer must be chunked");
  assert.equal(harness.tts.texts.join(" ").replace(/\s+/g, " "), LONG_ANSWER);
  assert.equal(harness.tts.maxConcurrentCalls, 1, "TTS must stay serial");

  const chunkIds = harness.transport.frames.map((frame) => frame.header.chunkId);
  assert.deepEqual(
    chunkIds,
    chunkIds.map((_value, index) => index),
    "audio frames must arrive in chunk order",
  );
  for (const frame of harness.transport.frames) {
    assert.equal(frame.header.format, "pcm16");
    assert.equal(frame.header.sampleRate, 16_000);
    assert.equal(frame.header.channels, 1);
    assert.equal(frame.header.turnSequence, 1);
    assert.ok(frame.audio.byteLength > 0);
  }

  const audioStart = harness.transport.controlsOfType("audio_start")[0];
  const audioEnd = harness.transport.controlsOfType("audio_end")[0];
  const turnDone = harness.transport.controlsOfType("turn_done")[0];
  assert.ok(audioStart && audioEnd && turnDone);
  assert.equal(audioEnd.chunkCount, harness.transport.frames.length);
  assert.equal(turnDone.reason, "completed");
  assert.equal(typeof turnDone.conversationId, "string");

  const order = harness.transport.ordered;
  assert.ok(
    order.indexOf("audio_start") < order.indexOf("audio:0"),
    "audio_start must precede the first frame",
  );
  assert.ok(
    order.lastIndexOf("audio:0") < order.indexOf("audio_end"),
    "audio_end must follow every frame",
  );
});

test("speech starts while Gemma is still generating", async () => {
  const provider = new ControlledChatProvider();
  const harness = createSession({ provider });
  startSession(harness);
  harness.session.handleTextMessage(
    JSON.stringify({ type: "user_text", text: "Tell me about India." }),
  );

  await provider.whenStreaming(1);
  provider.push("India has a huge and young population. ");
  await waitFor(
    () => harness.transport.frames.length >= 1,
    "the first phrase must be synthesized before generation finishes",
  );
  assert.equal(harness.transport.controlsOfType("assistant_text_done").length, 0);
  assert.equal(harness.transport.controlsOfType("turn_done").length, 0);

  provider.push("That creates enormous economic potential for the decade ahead.");
  provider.finish();
  await harness.session.whenSettled();
  await waitFor(() => harness.transport.controlsOfType("turn_done").length === 1);
  assert.ok(harness.transport.frames.length >= 2);
});

test("microphone input is transcribed and answered on the same connection", async () => {
  const harness = createSession();
  startSession(harness);

  harness.session.handleTextMessage(
    JSON.stringify({ type: "audio_start", mimeType: "audio/webm;codecs=opus" }),
  );
  harness.session.handleBinaryMessage(new Uint8Array([1, 2, 3]));
  harness.session.handleBinaryMessage(new Uint8Array([4, 5]));
  harness.session.handleTextMessage(JSON.stringify({ type: "audio_end" }));
  await harness.session.whenSettled();
  await waitFor(() => harness.transport.controlsOfType("turn_done").length === 1);

  const input = harness.asr.inputs[0];
  assert.ok(input);
  assert.deepEqual([...input.audio], [1, 2, 3, 4, 5]);
  assert.equal(input.contentType, "audio/webm");
  assert.equal(input.filename, "recording.webm");

  const transcript = harness.transport.controlsOfType("transcript_final")[0];
  assert.ok(transcript);
  assert.equal(transcript.text, "Who is my travel partner?");
  assert.ok(harness.transport.frames.length >= 1);
});

test("interrupting a turn stops generation and blocks further audio", async () => {
  const provider = new ControlledChatProvider();
  const tts = new FakeTTSProvider(
    (text) =>
      new Promise<void>((resolve) =>
        setTimeout(resolve, text.includes("second") ? 40 : 0),
      ),
  );
  const harness = createSession({ provider, tts });
  startSession(harness);
  harness.session.handleTextMessage(
    JSON.stringify({ type: "user_text", text: "Tell me a long story." }),
  );

  await provider.whenStreaming(1);
  provider.push("This first sentence is long enough to be spoken aloud. ");
  await waitFor(() => harness.transport.frames.length === 1);
  provider.push("This second sentence should never reach the speaker at all.");

  harness.session.handleTextMessage(JSON.stringify({ type: "interrupt" }));
  const framesAtInterrupt = harness.transport.frames.length;
  const turnDone = harness.transport.controlsOfType("turn_done")[0];
  assert.ok(turnDone);
  assert.equal(turnDone.reason, "interrupted");

  provider.finish();
  await harness.session.whenSettled();
  await new Promise<void>((resolve) => setTimeout(resolve, 60));
  assert.equal(harness.transport.frames.length, framesAtInterrupt);
  assert.equal(harness.transport.controlsOfType("audio_end").length, 0);
});

test("a new turn supersedes the old one and stale audio never leaks", async () => {
  const provider = new ControlledChatProvider();
  const slowTts = new FakeTTSProvider(
    (text) =>
      new Promise<void>((resolve) =>
        setTimeout(resolve, text.includes("stale") ? 50 : 0),
      ),
  );
  const harness = createSession({ provider, tts: slowTts });
  startSession(harness);

  harness.session.handleTextMessage(
    JSON.stringify({ type: "user_text", text: "First question." }),
  );
  await provider.whenStreaming(1);
  provider.push("This stale answer must never be heard by anyone at all.");
  await waitFor(() => slowTts.texts.length === 1);

  harness.session.handleTextMessage(
    JSON.stringify({ type: "user_text", text: "Second question." }),
  );
  await provider.whenStreaming(2);
  provider.push("This is the fresh answer that should actually be spoken.");
  provider.finish();
  await harness.session.whenSettled();
  await waitFor(() => harness.transport.controlsOfType("turn_done").length === 2);
  await new Promise<void>((resolve) => setTimeout(resolve, 80));

  const turnSequences = new Set(
    harness.transport.frames.map((frame) => frame.header.turnSequence),
  );
  assert.deepEqual([...turnSequences], [2], "only the newest turn may emit audio");
  const reasons = harness.transport
    .controlsOfType("turn_done")
    .map((message) => message.reason);
  assert.deepEqual(reasons, ["interrupted", "completed"]);
});

test("a TTS outage reports once and still finishes the text turn", async () => {
  const tts = new FakeTTSProvider();
  tts.failure = new VoiceProviderError("tts", "UNAVAILABLE", "internal detail");
  const harness = createSession({ tts });
  startSession(harness);

  harness.session.handleTextMessage(
    JSON.stringify({ type: "user_text", text: "Tell me about India." }),
  );
  await harness.session.whenSettled();
  await waitFor(() => harness.transport.controlsOfType("turn_done").length === 1);

  const errors = harness.transport.controlsOfType("error");
  assert.equal(errors.length, 1);
  assert.equal(errors[0]?.code, "TTS_UNAVAILABLE");
  assert.doesNotMatch(errors[0]?.message ?? "", /internal detail/);
  assert.equal(harness.transport.frames.length, 0);
  assert.equal(harness.transport.text(), LONG_ANSWER);
  assert.equal(harness.transport.controlsOfType("turn_done")[0]?.reason, "error");
});

test("an ASR outage fails only the current turn", async () => {
  const asr = new FakeASRProvider();
  asr.failure = new VoiceProviderError("asr", "UNAVAILABLE", "internal detail");
  const harness = createSession({ asr });
  startSession(harness);

  harness.session.handleTextMessage(JSON.stringify({ type: "audio_start" }));
  harness.session.handleBinaryMessage(new Uint8Array([1]));
  harness.session.handleTextMessage(JSON.stringify({ type: "audio_end" }));
  await harness.session.whenSettled();

  assert.equal(harness.transport.controlsOfType("error")[0]?.code, "ASR_UNAVAILABLE");
  assert.equal(harness.transport.controlsOfType("turn_done")[0]?.reason, "error");

  harness.session.handleTextMessage(
    JSON.stringify({ type: "user_text", text: "Typing instead." }),
  );
  await harness.session.whenSettled();
  await waitFor(() => harness.transport.controlsOfType("turn_done").length === 2);
  assert.equal(harness.transport.controlsOfType("turn_done")[1]?.reason, "completed");
});

test("a model outage is reported without leaking upstream detail", async () => {
  const provider = {
    async chat() {
      return { content: '{"memories":[]}' };
    },
    // eslint-disable-next-line require-yield
    async *streamChat(): AsyncIterable<{ readonly content: string }> {
      throw new AIProviderError("UNAVAILABLE", "http://127.0.0.1:11434 refused");
    },
  };
  const harness = createSession({ provider });
  startSession(harness);

  harness.session.handleTextMessage(
    JSON.stringify({ type: "user_text", text: "Hello." }),
  );
  await harness.session.whenSettled();

  const error = harness.transport.controlsOfType("error")[0];
  assert.equal(error?.code, "MODEL_UNAVAILABLE");
  assert.doesNotMatch(error?.message ?? "", /11434/);
});

test("the protocol rejects malformed messages and unstarted sessions", async () => {
  const harness = createSession();

  harness.session.handleTextMessage("not json");
  harness.session.handleTextMessage(JSON.stringify({ type: "unknown" }));
  harness.session.handleTextMessage(JSON.stringify({ type: "user_text", text: "  " }));
  assert.deepEqual(
    harness.transport.controlsOfType("error").map((error) => error.code),
    ["INVALID_MESSAGE", "INVALID_MESSAGE", "INVALID_MESSAGE"],
  );

  harness.session.handleTextMessage(
    JSON.stringify({ type: "user_text", text: "Too early." }),
  );
  harness.session.handleBinaryMessage(new Uint8Array([1]));
  assert.deepEqual(
    harness.transport
      .controlsOfType("error")
      .slice(3)
      .map((error) => error.code),
    ["SESSION_NOT_STARTED", "SESSION_NOT_STARTED"],
  );
  assert.equal(harness.transport.frames.length, 0);
  await harness.session.whenSettled();
});

test("binary audio without an active capture is refused", async () => {
  const harness = createSession();
  startSession(harness);
  harness.session.handleBinaryMessage(new Uint8Array([1, 2]));

  assert.equal(harness.transport.controlsOfType("error")[0]?.code, "INVALID_AUDIO");
  await harness.session.whenSettled();
});

test("the session reuses one conversation across turns and reconnects", async () => {
  const repository = new InMemoryRepository();
  const first = createSession({ repository });
  startSession(first);
  first.session.handleTextMessage(
    JSON.stringify({ type: "user_text", text: "First question." }),
  );
  await first.session.whenSettled();
  await waitFor(() => first.transport.controlsOfType("turn_done").length === 1);
  const conversationId =
    first.transport.controlsOfType("turn_done")[0]?.conversationId;
  assert.ok(conversationId);

  first.session.handleTextMessage(
    JSON.stringify({ type: "user_text", text: "Second question." }),
  );
  await first.session.whenSettled();
  await waitFor(() => first.transport.controlsOfType("turn_done").length === 2);
  assert.equal(
    first.transport.controlsOfType("turn_done")[1]?.conversationId,
    conversationId,
  );

  // A reconnect resumes the same Shiva conversation.
  const resumed = createSession({ repository });
  startSession(resumed, conversationId);
  assert.equal(
    resumed.transport.controlsOfType("session_ready")[0]?.conversationId,
    conversationId,
  );
  resumed.session.handleTextMessage(
    JSON.stringify({ type: "user_text", text: "Third question." }),
  );
  await resumed.session.whenSettled();
  await waitFor(() => resumed.transport.controlsOfType("turn_done").length === 1);
  assert.equal(
    resumed.transport.controlsOfType("turn_done")[0]?.conversationId,
    conversationId,
  );
  assert.equal(
    repository.messages.filter((message) => message.role === "user").length,
    3,
  );
});

test("an unknown conversation is reported and cleared", async () => {
  const harness = createSession();
  startSession(harness, "99999999-0000-4000-8000-000000000009");
  harness.session.handleTextMessage(
    JSON.stringify({ type: "user_text", text: "Continue." }),
  );
  await harness.session.whenSettled();

  assert.equal(
    harness.transport.controlsOfType("error")[0]?.code,
    "CONVERSATION_NOT_FOUND",
  );

  harness.session.handleTextMessage(
    JSON.stringify({ type: "user_text", text: "Start fresh." }),
  );
  await harness.session.whenSettled();
  await waitFor(() => harness.transport.controlsOfType("turn_done").length === 2);
  assert.equal(harness.transport.controlsOfType("turn_done")[1]?.reason, "completed");
});

test("deferred memory extraction waits for reported playback and closing releases it", async () => {
  const extraction = new (class extends FakeExtractionEngine {
    started = 0;
    override async extract() {
      this.started += 1;
      return [];
    }
  })();
  const coordinator = new VoicePlaybackCoordinator(1_000);
  const harness = createSession({
    playbackCoordinator: coordinator,
    extractionEngine: extraction,
  });
  startSession(harness);
  harness.session.handleTextMessage(
    JSON.stringify({ type: "user_text", text: "Tell me about India." }),
  );
  await harness.session.whenSettled();
  await waitFor(() => harness.transport.controlsOfType("turn_done").length === 1);

  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(extraction.started, 0, "live speech must not compete with memory");

  const turnId = harness.transport.controlsOfType("turn_done")[0]?.turnId;
  assert.ok(turnId);
  harness.session.handleTextMessage(
    JSON.stringify({ type: "playback", turnId, event: "idle" }),
  );
  await waitFor(() => extraction.started === 1, "memory did not resume");
  coordinator.close();
});

test("closing a session releases the memory gate for unplayed audio", async () => {
  const coordinator = new VoicePlaybackCoordinator(1_000);
  const harness = createSession({ playbackCoordinator: coordinator });
  startSession(harness);
  harness.session.handleTextMessage(
    JSON.stringify({ type: "user_text", text: "Tell me about India." }),
  );
  await harness.session.whenSettled();
  await waitFor(() => harness.transport.controlsOfType("turn_done").length === 1);

  harness.session.close();
  assert.equal(await coordinator.waitUntilAllIdle(), "idle");
  coordinator.close();
});

test("per chunk metrics expose realtime factor, transport, and underruns", async () => {
  const entries: VoicePerformanceEntry[] = [];
  const performance = new VoicePerformanceTracker((entry) => entries.push(entry));
  const tts = new FakeTTSProvider();
  tts.audioDurationMs = 1_000;
  const harness = createSession({
    tts,
    performance,
    provider: staticChatProvider(
      "This single spoken sentence is long enough to be one chunk.",
    ),
  });
  startSession(harness);
  harness.session.handleTextMessage(
    JSON.stringify({ type: "user_text", text: "Say one thing." }),
  );
  await harness.session.whenSettled();
  await waitFor(() => harness.transport.frames.length === 1);

  const turnId = harness.transport.controlsOfType("audio_start")[0]?.turnId;
  assert.ok(turnId);
  for (const event of [
    "received",
    "scheduled",
    "underrun",
    "started",
    "ended",
  ] as const) {
    harness.session.handleTextMessage(
      JSON.stringify({
        type: "playback",
        turnId,
        event,
        chunkId: 0,
        timestampMs: Date.now(),
        ...(event === "scheduled" ? { decodeDurationMs: 3.5 } : {}),
        ...(event === "underrun" ? { underrunMs: 180 } : {}),
      }),
    );
  }
  harness.session.handleTextMessage(
    JSON.stringify({ type: "playback", turnId, event: "idle" }),
  );

  const chunk = entries.find(
    (entry): entry is VoiceTtsChunkPerformanceLog =>
      entry.kind === "voice-tts-chunk",
  );
  assert.ok(chunk, "a chunk record must be emitted");
  assert.equal(chunk.chunkId, 0);
  assert.ok(chunk.textChars > 0);
  assert.equal(chunk.audioDurationMs, 1_000);
  assert.equal(typeof chunk.synthesisDurationMs, "number");
  assert.equal(typeof chunk.realtimeFactor, "number");
  assert.equal(chunk.decodeDurationMs, 3.5);
  assert.equal(chunk.underrunMs, 180);
  assert.ok(chunk.timestampsUnixMs.queued);
  assert.ok(chunk.timestampsUnixMs.websocketSent);
  assert.ok(chunk.timestampsUnixMs.audioReceived);
  assert.match(formatVoicePerformanceLog(chunk), /rtf=\d/);

  const summary = entries.find((entry) => entry.kind === "voice");
  assert.ok(summary && summary.kind === "voice");
  assert.equal(typeof summary.timingsMs["chat-ttft"], "number");
  assert.equal(typeof summary.timingsMs["tts-duration"], "number");
  assert.equal(typeof summary.timingsMs["time-to-first-audio"], "number");
});

test("oversized microphone capture is rejected before transcription", async () => {
  const transport = new RecordingTransport();
  const asr = new FakeASRProvider();
  const { chatService } = createChatService(staticChatProvider("Fine."));
  const session = new VoiceSession({
    transport,
    chatService,
    asrProvider: asr,
    ttsProvider: new FakeTTSProvider(),
    createId: sequentialIds(),
    maxCapturedAudioBytes: 8,
  });
  session.handleTextMessage(JSON.stringify({ type: "session_start" }));
  session.handleTextMessage(JSON.stringify({ type: "audio_start" }));
  session.handleBinaryMessage(new Uint8Array(16));
  session.handleTextMessage(JSON.stringify({ type: "audio_end" }));
  await session.whenSettled();

  assert.equal(transport.controlsOfType("error")[0]?.code, "INVALID_AUDIO");
  assert.equal(asr.inputs.length, 0);
  assert.equal(transport.controlsOfType("turn_done")[0]?.reason, "error");
});

test("silent recordings are reported instead of reaching the model", async () => {
  const asr = new FakeASRProvider();
  asr.transcript = "   ";
  const harness = createSession({ asr });
  startSession(harness);
  harness.session.handleTextMessage(JSON.stringify({ type: "audio_start" }));
  harness.session.handleBinaryMessage(new Uint8Array([9]));
  harness.session.handleTextMessage(JSON.stringify({ type: "audio_end" }));
  await harness.session.whenSettled();

  assert.equal(harness.transport.controlsOfType("error")[0]?.code, "INVALID_AUDIO");
  assert.equal(harness.tts.texts.length, 0);
});

test("session_end closes the transport", async () => {
  const harness = createSession();
  startSession(harness);
  harness.session.handleTextMessage(JSON.stringify({ type: "session_end" }));

  assert.equal(harness.transport.closed, true);
  await harness.session.whenSettled();
});

test("non PCM synthesis output falls back to WAV frames", async () => {
  const tts: FakeTTSProvider = new FakeTTSProvider();
  const mp3Like = Buffer.concat([
    Buffer.from("RIFF"),
    Buffer.alloc(4),
    Buffer.from("WAVE"),
    Buffer.from("fmt "),
  ]);
  Object.assign(tts, {
    synthesize: async () => ({
      audio: new Uint8Array(mp3Like),
      contentType: "audio/wav" as const,
    }),
  });
  const harness = createSession({
    tts,
    provider: staticChatProvider("One sentence that is long enough to speak."),
  });
  startSession(harness);
  harness.session.handleTextMessage(
    JSON.stringify({ type: "user_text", text: "Say something." }),
  );
  await harness.session.whenSettled();
  await waitFor(() => harness.transport.frames.length === 1);

  const frame = harness.transport.frames[0];
  assert.ok(frame);
  assert.equal(frame.header.format, "wav");
  assert.deepEqual([...frame.audio], [...mp3Like]);
  assert.equal(
    harness.transport.controlsOfType("audio_start")[0]?.format,
    "wav",
  );
});

test("a synthesized chunk carries its own generated audio duration", async () => {
  const wav = createWavBytes(750);
  const tts = new FakeTTSProvider();
  tts.audioDurationMs = 750;
  const harness = createSession({
    tts,
    provider: staticChatProvider("One sentence that is long enough to speak."),
  });
  startSession(harness);
  harness.session.handleTextMessage(
    JSON.stringify({ type: "user_text", text: "Say something." }),
  );
  await harness.session.whenSettled();
  await waitFor(() => harness.transport.frames.length === 1);

  const frame = harness.transport.frames[0];
  assert.ok(frame);
  assert.equal(frame.header.audioDurationMs, 750);
  assert.equal(frame.audio.byteLength, wav.byteLength - 44);
});
