import assert from "node:assert/strict";
import { test } from "node:test";

import { planAudioPlayback, findAudibleWindow } from "../src/voice/audio-scheduling.js";
import { VoiceAudioPlayer } from "../src/voice/client/voice-audio-player.js";
import {
  VoiceSocketClient,
  type SocketLike,
} from "../src/voice/client/voice-socket-client.js";
import {
  decodeVoiceAudioFrame,
  encodeVoiceAudioFrame,
} from "../src/voice/audio-frame.js";
import type { ServerVoiceMessage } from "../src/voice/voice-protocol.js";

class FakeBuffer {
  constructor(
    readonly numberOfChannels: number,
    readonly length: number,
    readonly sampleRate: number,
    private readonly channels: Float32Array[],
  ) {}

  get duration(): number {
    return this.length / this.sampleRate;
  }

  getChannelData(channel: number): Float32Array {
    return this.channels[channel] ?? new Float32Array(this.length);
  }
}

class FakeBufferSource {
  buffer: FakeBuffer | null = null;
  started = false;
  private endedListener: (() => void) | null = null;

  constructor(private readonly onStart: () => void = () => {}) {}

  connect(): void {}
  disconnect(): void {}

  addEventListener(
    type: "ended",
    listener: () => void,
    _options?: { readonly once?: boolean },
  ): void {
    if (type === "ended") this.endedListener = listener;
  }

  start(): void {
    this.started = true;
    this.onStart();
  }

  stop(): void {
    this.endedListener?.();
  }

  finish(): void {
    this.endedListener?.();
  }
}

class FakeAudioContext {
  currentTime = 1;
  state = "running";
  destination = {};
  readonly sources: FakeBufferSource[] = [];

  async resume(): Promise<void> {}

  createBuffer(
    channels: number,
    length: number,
    sampleRate: number,
  ): FakeBuffer {
    const data = Array.from(
      { length: channels },
      () => {
        const samples = new Float32Array(length);
        samples.fill(0.2);
        return samples;
      },
    );
    return new FakeBuffer(channels, length, sampleRate, data);
  }

  createBufferSource(): FakeBufferSource {
    const source = new FakeBufferSource();
    this.sources.push(source);
    return source;
  }

  async decodeAudioData(): Promise<FakeBuffer> {
    throw new Error("PCM frames should not call decodeAudioData.");
  }
}

test("the gapless player schedules consecutive PCM chunks on one timeline", async () => {
  const context = new FakeAudioContext();
  const events: string[] = [];
  const timers = new Map<number, () => void>();
  let nextTimer = 1;
  let now = 0;

  const player = new VoiceAudioPlayer({
    context,
    planPlayback: planAudioPlayback,
    findAudible: findAudibleWindow,
    onEvent: (event) => events.push(event.type),
    unixNow: () => 1_000 + now,
    monotonicNow: () => now,
    setTimer: (callback) => {
      const id = nextTimer++;
      timers.set(id, callback);
      return id;
    },
    clearTimer: (id) => void timers.delete(id),
  });

  player.beginTurn(1);
  const pcm = new Uint8Array(640);
  for (let index = 0; index < pcm.byteLength; index += 2) {
    pcm[index] = 0;
    pcm[index + 1] = 64;
  }

  player.enqueue({
    turnSequence: 1,
    chunkId: 0,
    format: "pcm16",
    sampleRate: 16_000,
    channels: 1,
    audio: pcm,
  });
  player.enqueue({
    turnSequence: 1,
    chunkId: 1,
    format: "pcm16",
    sampleRate: 16_000,
    channels: 1,
    audio: pcm,
  });

  await waitFor(() => context.sources.length === 2);
  assert.equal(context.sources.every((source) => source.started), true);
  assert.ok(events.includes("scheduled"));

  for (const timer of [...timers.values()]) timer();
  assert.ok(events.filter((event) => event === "started").length >= 1);

  player.stop();
  assert.equal(player.isIdle(), true);
});

test("stale-turn audio is ignored after beginTurn advances", async () => {
  const context = new FakeAudioContext();
  const player = new VoiceAudioPlayer({
    context,
    planPlayback: planAudioPlayback,
    findAudible: findAudibleWindow,
    onEvent: () => {},
    unixNow: () => Date.now(),
    monotonicNow: () => 0,
    setTimer: () => 1,
    clearTimer: () => {},
  });

  player.beginTurn(1);
  player.beginTurn(2);
  player.enqueue({
    turnSequence: 1,
    chunkId: 0,
    format: "pcm16",
    sampleRate: 16_000,
    channels: 1,
    audio: new Uint8Array([0, 64, 0, 64]),
  });
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(context.sources.length, 0);
});

class FakeSocket implements SocketLike {
  binaryType = "blob";
  readyState = 0;
  sent: Array<string | Uint8Array> = [];
  onopen: (() => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  onmessage: ((event: { data: unknown }) => void) | null = null;

  send(data: string | Uint8Array): void {
    this.sent.push(data);
  }

  close(): void {
    this.readyState = 3;
    this.onclose?.();
  }

  open(): void {
    this.readyState = 1;
    this.onopen?.();
  }
}

test("the socket client reconnects and delivers control plus binary audio", async () => {
  const sockets: FakeSocket[] = [];
  const states: string[] = [];
  const controls: ServerVoiceMessage[] = [];
  const frames: number[] = [];
  const timers = new Map<number, () => void>();
  let nextTimer = 1;

  const client = new VoiceSocketClient({
    url: "ws://voice.test/voice/chat",
    createSocket: () => {
      const socket = new FakeSocket();
      sockets.push(socket);
      return socket;
    },
    decodeAudioFrame: decodeVoiceAudioFrame,
    onStateChange: (state) => states.push(state),
    onControl: (message) => controls.push(message),
    onAudio: (frame) => frames.push(frame.header.chunkId),
    setTimer: (callback) => {
      const id = nextTimer++;
      timers.set(id, callback);
      return id;
    },
    clearTimer: (id) => void timers.delete(id),
    reconnectDelaysMs: [0],
  });

  client.connect();
  assert.equal(states.at(-1), "connecting");
  sockets[0]?.open();
  assert.equal(states.at(-1), "open");
  assert.equal(
    client.send({ type: "session_start" }),
    true,
  );

  sockets[0]?.onmessage?.({
    data: JSON.stringify({
      type: "session_ready",
      sessionId: "10000000-0000-4000-8000-000000000001",
      protocolVersion: 1,
      conversationId: null,
      preferredAudioFormat: "pcm16",
      audioFrameHeaderBytes: 24,
    }),
  });
  assert.equal(controls[0]?.type, "session_ready");

  const audio = encodeVoiceAudioFrame(
    {
      format: "pcm16",
      channels: 1,
      sampleRate: 16_000,
      turnSequence: 1,
      chunkId: 0,
      audioDurationMs: 10,
    },
    new Uint8Array([1, 2]),
  );
  sockets[0]?.onmessage?.({ data: audio.buffer });
  assert.deepEqual(frames, [0]);

  sockets[0]?.close();
  assert.equal(states.at(-1), "reconnecting");
  for (const timer of timers.values()) timer();
  assert.equal(sockets.length, 2);
  sockets[1]?.open();
  assert.equal(states.at(-1), "open");

  client.close();
  assert.equal(states.at(-1), "closed");
});

async function waitFor(condition: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (condition()) return;
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  assert.fail("Timed out waiting for a client condition.");
}
