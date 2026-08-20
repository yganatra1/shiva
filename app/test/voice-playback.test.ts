import assert from "node:assert/strict";
import { test } from "node:test";

import { createApp } from "../src/app.js";
import type { AIProvider } from "../src/brain/ai-provider.js";
import { VoicePlaybackCoordinator } from "../src/voice/playback-coordinator.js";
import {
  VoicePerformanceTracker,
  formatVoicePerformanceLog,
  type VoicePerformanceEntry,
  type VoiceTtsChunkPerformanceLog,
} from "../src/voice/voice-performance.js";
import {
  createTestOverrides,
  FakeExtractionEngine,
  InMemoryRepository,
  testConfig,
} from "./test-support.js";

const TURN_ID = "20000000-0000-4000-8000-000000000002";

test("playback coordinator waits for global idle and has a bounded fallback", async () => {
  const coordinator = new VoicePlaybackCoordinator(20);
  coordinator.beginTurn(TURN_ID);
  const secondTurn = "20000000-0000-4000-8000-000000000004";
  coordinator.beginTurn(secondTurn);

  let settled = false;
  const idle = coordinator.waitUntilAllIdle().then((outcome) => {
    settled = true;
    return outcome;
  });
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(settled, false);

  coordinator.markIdle(TURN_ID);
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(settled, false, "one active turn must keep the global gate closed");
  coordinator.markIdle(secondTurn);
  assert.equal(await idle, "idle");
  coordinator.markActive(TURN_ID);
  assert.equal(await coordinator.waitUntilAllIdle(), "idle");

  const timeoutTurn = "20000000-0000-4000-8000-000000000003";
  coordinator.beginTurn(timeoutTurn);
  assert.equal(
    await withTimeout(
      coordinator.waitUntilAllIdle(),
      200,
      "The unref'ed playback fail-safe did not retire the active turn.",
    ),
    "timeout",
  );
  assert.equal(await coordinator.waitUntilAllIdle(), "idle");
  coordinator.close();
  assert.equal(await coordinator.waitUntilAllIdle(), "closed");
});

test("all automatic memory extraction waits behind global voice playback", async (context) => {
  let extractionCount = 0;
  let signalExtraction: (() => void) | undefined;
  const extractionStarted = new Promise<void>((resolve) => {
    signalExtraction = resolve;
  });
  class SignalingExtractionEngine extends FakeExtractionEngine {
    override async extract() {
      extractionCount += 1;
      signalExtraction?.();
      return [];
    }
  }
  const provider: AIProvider = {
    async chat() {
      throw new Error("The fake extraction engine handles extraction.");
    },
    async *streamChat() {
      yield { content: "A text response." };
    },
  };
  const coordinator = new VoicePlaybackCoordinator(1_000);
  coordinator.beginTurn(TURN_ID);
  const app = createApp(testConfig, {
    ...createTestOverrides(
      provider,
      new InMemoryRepository(),
      undefined,
      new SignalingExtractionEngine(),
    ),
    voicePlaybackCoordinator: coordinator,
  });
  context.after(() => app.close());

  const response = await app.inject({
    method: "POST",
    url: "/chat",
    headers: { "content-type": "application/json" },
    payload: { message: "This is an ordinary text interaction." },
  });
  assert.equal(response.statusCode, 200);
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(extractionCount, 0);

  coordinator.markIdle(TURN_ID);
  await withTimeout(extractionStarted, 500, "Text memory did not resume.");
  assert.equal(extractionCount, 1);
});

test("automatic voice memory extraction waits for playback idle", async (context) => {
  let extractionCount = 0;
  let signalExtraction: (() => void) | undefined;
  const extractionStarted = new Promise<void>((resolve) => {
    signalExtraction = resolve;
  });
  class SignalingExtractionEngine extends FakeExtractionEngine {
    override async extract() {
      extractionCount += 1;
      signalExtraction?.();
      return [];
    }
  }

  const provider: AIProvider = {
    async chat() {
      throw new Error("The fake extraction engine handles extraction.");
    },
    async *streamChat() {
      yield { content: "A short spoken response." };
    },
  };
  const coordinator = new VoicePlaybackCoordinator(1_000);
  const app = createApp(testConfig, {
    ...createTestOverrides(
      provider,
      new InMemoryRepository(),
      undefined,
      new SignalingExtractionEngine(),
    ),
    voicePlaybackCoordinator: coordinator,
  });
  context.after(() => app.close());

  const response = await app.inject({
    method: "POST",
    url: "/voice/chat",
    headers: {
      "content-type": "application/json",
      "x-shiva-voice-turn-id": TURN_ID,
    },
    payload: { message: "Tell me something interesting." },
  });
  assert.equal(response.statusCode, 200);

  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(extractionCount, 0);

  for (const event of ["scheduled", "started", "ended"] as const) {
    const telemetry = await app.inject({
      method: "POST",
      url: "/voice/playback",
      headers: {
        "content-type": "application/json",
        "x-shiva-voice-turn-id": TURN_ID,
      },
      payload: { event, sequence: 0, timestampMs: Date.now() },
    });
    assert.equal(telemetry.statusCode, 204);
  }
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(extractionCount, 0, "chunk end must not imply whole-turn idle");

  const idle = await app.inject({
    method: "POST",
    url: "/voice/playback",
    headers: {
      "content-type": "application/json",
      "x-shiva-voice-turn-id": TURN_ID,
    },
    payload: { event: "idle", timestampMs: Date.now() },
  });
  assert.equal(idle.statusCode, 204);
  await withTimeout(extractionStarted, 500, "Memory extraction did not resume.");
  assert.equal(extractionCount, 1);
});

test("explicit voice memory processing does not wait for playback idle", async (context) => {
  const extraction = new FakeExtractionEngine();
  let extractionCount = 0;
  const originalExtract = extraction.extract.bind(extraction);
  extraction.extract = async (input) => {
    extractionCount += 1;
    return originalExtract(input);
  };
  const provider: AIProvider = {
    async chat() {
      throw new Error("The fake extraction engine handles extraction.");
    },
    async *streamChat() {
      yield { content: "I could not find material information to save." };
    },
  };
  const app = createApp(testConfig, {
    ...createTestOverrides(
      provider,
      new InMemoryRepository(),
      undefined,
      extraction,
    ),
    voicePlaybackCoordinator: new VoicePlaybackCoordinator(1_000),
  });
  context.after(() => app.close());

  const response = await app.inject({
    method: "POST",
    url: "/voice/chat",
    headers: {
      "content-type": "application/json",
      "x-shiva-voice-turn-id": TURN_ID,
    },
    payload: { message: "Remember that." },
  });

  assert.equal(response.statusCode, 200);
  assert.equal(extractionCount, 1);
});

test("automatic memory jobs run one at a time in interaction order", async (context) => {
  let signalFirstStarted: (() => void) | undefined;
  let releaseFirst: (() => void) | undefined;
  let signalSecondStarted: (() => void) | undefined;
  const firstStarted = new Promise<void>((resolve) => {
    signalFirstStarted = resolve;
  });
  const firstRelease = new Promise<void>((resolve) => {
    releaseFirst = resolve;
  });
  const secondStarted = new Promise<void>((resolve) => {
    signalSecondStarted = resolve;
  });
  const starts: string[] = [];

  class OrderedExtractionEngine extends FakeExtractionEngine {
    override async extract(input: Parameters<FakeExtractionEngine["extract"]>[0]) {
      starts.push(input.userMessage);
      if (starts.length === 1) {
        signalFirstStarted?.();
        await firstRelease;
      } else {
        signalSecondStarted?.();
      }
      return [];
    }
  }
  const provider: AIProvider = {
    async chat() {
      throw new Error("The fake extraction engine handles extraction.");
    },
    async *streamChat() {
      yield { content: "Response." };
    },
  };
  const app = createApp(
    testConfig,
    createTestOverrides(
      provider,
      new InMemoryRepository(),
      undefined,
      new OrderedExtractionEngine(),
    ),
  );
  context.after(() => app.close());

  for (const message of ["First interaction.", "Second interaction."]) {
    const response = await app.inject({
      method: "POST",
      url: "/chat",
      headers: { "content-type": "application/json" },
      payload: { message },
    });
    assert.equal(response.statusCode, 200);
  }

  await withTimeout(firstStarted, 500, "The first memory job did not start.");
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.deepEqual(starts, ["First interaction."]);

  releaseFirst?.();
  await withTimeout(secondStarted, 500, "The second memory job did not start.");
  assert.deepEqual(starts, ["First interaction.", "Second interaction."]);
});

test("coordinator shutdown skips automatic memory jobs waiting on playback", async (context) => {
  let extractionCount = 0;
  class CountingExtractionEngine extends FakeExtractionEngine {
    override async extract() {
      extractionCount += 1;
      return [];
    }
  }
  const provider: AIProvider = {
    async chat() {
      throw new Error("The fake extraction engine handles extraction.");
    },
    async *streamChat() {
      yield { content: "Response." };
    },
  };
  const coordinator = new VoicePlaybackCoordinator(1_000);
  coordinator.beginTurn(TURN_ID);
  const app = createApp(testConfig, {
    ...createTestOverrides(
      provider,
      new InMemoryRepository(),
      undefined,
      new CountingExtractionEngine(),
    ),
    voicePlaybackCoordinator: coordinator,
  });
  context.after(() => app.close());

  const response = await app.inject({
    method: "POST",
    url: "/chat",
    headers: { "content-type": "application/json" },
    payload: { message: "Do not extract this during shutdown." },
  });
  assert.equal(response.statusCode, 200);
  await new Promise<void>((resolve) => setImmediate(resolve));

  await app.close();
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(extractionCount, 0);
});

test("shutdown drains an automatic memory job already using persistence", async (context) => {
  let signalExtractionStarted: (() => void) | undefined;
  let releaseExtraction: (() => void) | undefined;
  const extractionStarted = new Promise<void>((resolve) => {
    signalExtractionStarted = resolve;
  });
  const extractionRelease = new Promise<void>((resolve) => {
    releaseExtraction = resolve;
  });
  class BlockingExtractionEngine extends FakeExtractionEngine {
    override async extract() {
      signalExtractionStarted?.();
      await extractionRelease;
      return [];
    }
  }
  const provider: AIProvider = {
    async chat() {
      throw new Error("The fake extraction engine handles extraction.");
    },
    async *streamChat() {
      yield { content: "Response." };
    },
  };
  const app = createApp(
    testConfig,
    createTestOverrides(
      provider,
      new InMemoryRepository(),
      undefined,
      new BlockingExtractionEngine(),
    ),
  );
  context.after(async () => {
    releaseExtraction?.();
    await app.close();
  });

  const response = await app.inject({
    method: "POST",
    url: "/chat",
    headers: { "content-type": "application/json" },
    payload: { message: "Finish persisting this before shutdown." },
  });
  assert.equal(response.statusCode, 200);
  await withTimeout(
    extractionStarted,
    500,
    "The background memory job did not start.",
  );

  let closeSettled = false;
  const closing = app.close().then(() => {
    closeSettled = true;
  });
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(closeSettled, false, "shutdown did not drain active memory work");

  releaseExtraction?.();
  await withTimeout(closing, 500, "Shutdown did not finish after memory drained.");
  assert.equal(closeSettled, true);
});

test("every synthesized WAV chunk logs synthesis, RTF, and browser playback telemetry", () => {
  const entries: VoicePerformanceEntry[] = [];
  let monotonicNow = 100;
  let unixNow = 1_000;
  const tracker = new VoicePerformanceTracker(
    (entry) => entries.push(entry),
    () => monotonicNow,
    () => unixNow,
  );

  tracker.markChatStarted(TURN_ID);
  monotonicNow = 150;
  tracker.markChatFirstToken(TURN_ID);
  monotonicNow = 200;
  unixNow = 1_100;
  const startedAt = tracker.markTtsStarted(TURN_ID, 0, {
    textLength: 12,
    textReadyAtUnixMs: 1_050,
  });
  monotonicNow = 700;
  unixNow = 1_600;
  tracker.finishTts(TURN_ID, 0, startedAt, wavWithDuration(2_000));
  tracker.recordPlaybackEvent(TURN_ID, 0, "scheduled", 1_650);
  tracker.recordPlaybackEvent(TURN_ID, 0, "started", 1_700);
  tracker.recordPlaybackEvent(TURN_ID, 0, "ended", 3_700);
  tracker.finishPlaybackTurn(TURN_ID);

  assert.equal(entries[0]?.kind, "voice");
  const chunk = entries.find(
    (entry): entry is VoiceTtsChunkPerformanceLog =>
      entry.kind === "voice-tts-chunk",
  );
  assert.deepEqual(chunk, {
    kind: "voice-tts-chunk",
    turnId: TURN_ID,
    sequence: 0,
    textLength: 12,
    timestampsUnixMs: {
      textReady: 1_050,
      synthesisStarted: 1_100,
      synthesisEnded: 1_600,
      playbackScheduled: 1_650,
      playbackStarted: 1_700,
      playbackEnded: 3_700,
    },
    synthesisDurationMs: 500,
    audioDurationMs: 2_000,
    rtf: 0.25,
  });
  assert.match(formatVoicePerformanceLog(chunk), /rtf=0\.250/);
});

test("voice routes reject missing telemetry identity and malformed TTS sequences", async (context) => {
  let synthesisCount = 0;
  const provider: AIProvider = {
    async chat() {
      return { content: '{"memories":[]}' };
    },
    async *streamChat() {
      yield { content: "Hello." };
    },
  };
  const app = createApp(testConfig, {
    ...createTestOverrides(provider),
    ttsProvider: {
      async synthesize() {
        synthesisCount += 1;
        return {
          audio: wavWithDuration(100),
          contentType: "audio/wav" as const,
        };
      },
    },
  });
  context.after(() => app.close());

  const missingTurn = await app.inject({
    method: "POST",
    url: "/voice/playback",
    headers: { "content-type": "application/json" },
    payload: { event: "idle" },
  });
  assert.equal(missingTurn.statusCode, 400);

  const missingSequence = await app.inject({
    method: "POST",
    url: "/voice/playback",
    headers: {
      "content-type": "application/json",
      "x-shiva-voice-turn-id": TURN_ID,
    },
    payload: { event: "started" },
  });
  assert.equal(missingSequence.statusCode, 400);

  for (const sequence of [undefined, "invalid", "-1", "1.5", "1e2"]) {
    const response = await app.inject({
      method: "POST",
      url: "/voice/synthesize",
      headers: {
        "content-type": "application/json",
        "x-shiva-voice-turn-id": TURN_ID,
        ...(sequence === undefined
          ? {}
          : { "x-shiva-voice-sequence": sequence }),
      },
      payload: { text: "Hello." },
    });
    assert.equal(response.statusCode, 400, String(sequence));
  }
  assert.equal(synthesisCount, 0);

  const validSequence = await app.inject({
    method: "POST",
    url: "/voice/synthesize",
    headers: {
      "content-type": "application/json",
      "x-shiva-voice-turn-id": TURN_ID,
      "x-shiva-voice-sequence": "0",
    },
    payload: { text: "Hello." },
  });
  assert.equal(validSequence.statusCode, 200);
  assert.equal(synthesisCount, 1);
});

function wavWithDuration(durationMs: number): Uint8Array {
  const sampleRate = 16_000;
  const bytesPerSample = 2;
  const dataLength = Math.round(
    (sampleRate * bytesPerSample * durationMs) / 1_000,
  );
  const wav = Buffer.alloc(44 + dataLength);
  wav.write("RIFF", 0, "ascii");
  wav.writeUInt32LE(36 + dataLength, 4);
  wav.write("WAVE", 8, "ascii");
  wav.write("fmt ", 12, "ascii");
  wav.writeUInt32LE(16, 16);
  wav.writeUInt16LE(1, 20);
  wav.writeUInt16LE(1, 22);
  wav.writeUInt32LE(sampleRate, 24);
  wav.writeUInt32LE(sampleRate * bytesPerSample, 28);
  wav.writeUInt16LE(bytesPerSample, 32);
  wav.writeUInt16LE(16, 34);
  wav.write("data", 36, "ascii");
  wav.writeUInt32LE(dataLength, 40);
  return wav;
}

async function withTimeout<T>(
  operation: Promise<T>,
  timeoutMs: number,
  message: string,
): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error(message)), timeoutMs);
  });
  try {
    return await Promise.race([operation, timeout]);
  } finally {
    if (timer) {
      clearTimeout(timer);
    }
  }
}
