import assert from "node:assert/strict";

import type {
  AIProvider,
  ChatChunk,
  ChatInput,
} from "../src/brain/ai-provider.js";
import { MemoryRanker } from "../src/memory/memory-ranker.js";
import { MemoryRetriever } from "../src/memory/memory-retriever.js";
import { MemoryService } from "../src/memory/memory-service.js";
import { ShivaChatService } from "../src/services/chat-service.js";
import { decodeVoiceAudioFrame, type VoiceAudioFrame } from "../src/voice/audio-frame.js";
import type { VoicePlaybackCoordinator } from "../src/voice/playback-coordinator.js";
import type {
  ASRInput,
  ASRProvider,
  SynthesisInput,
  TTSProvider,
} from "../src/voice/provider.js";
import type { ServerVoiceMessage } from "../src/voice/voice-protocol.js";
import type { VoiceSessionTransport } from "../src/voice/voice-session.js";
import {
  FakeEmbeddingProvider,
  FakeExtractionEngine,
  InMemoryRepository,
  testConfig,
} from "./test-support.js";

/** Collects everything a session would put on the wire. */
export class RecordingTransport implements VoiceSessionTransport {
  readonly controls: ServerVoiceMessage[] = [];
  readonly frames: VoiceAudioFrame[] = [];
  readonly ordered: string[] = [];
  isOpen = true;
  closed = false;

  sendControl(message: ServerVoiceMessage): void {
    this.controls.push(message);
    this.ordered.push(message.type);
  }

  sendAudio(frame: Uint8Array): void {
    const decoded = decodeVoiceAudioFrame(frame);
    assert.ok(decoded, "A voice audio frame must be decodable.");
    this.frames.push(decoded);
    this.ordered.push(`audio:${decoded.header.chunkId}`);
  }

  close(): void {
    this.closed = true;
    this.isOpen = false;
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
}

export class FakeASRProvider implements ASRProvider {
  readonly inputs: ASRInput[] = [];
  transcript = "Who is my travel partner?";
  failure?: Error;

  async transcribe(input: ASRInput) {
    this.inputs.push(input);
    if (this.failure) {
      throw this.failure;
    }
    return { text: this.transcript, language: "English" };
  }
}

export class FakeTTSProvider implements TTSProvider {
  readonly texts: string[] = [];
  concurrentCalls = 0;
  maxConcurrentCalls = 0;
  audioDurationMs = 400;
  failure?: Error;

  constructor(
    private readonly delay: (text: string) => Promise<void> = async () => {},
  ) {}

  async synthesize(input: SynthesisInput) {
    this.texts.push(input.text);
    this.concurrentCalls += 1;
    this.maxConcurrentCalls = Math.max(
      this.maxConcurrentCalls,
      this.concurrentCalls,
    );
    try {
      await this.delay(input.text);
      input.signal?.throwIfAborted();
      if (this.failure) {
        throw this.failure;
      }
      return {
        audio: createWavBytes(this.audioDurationMs),
        contentType: "audio/wav" as const,
      };
    } finally {
      this.concurrentCalls -= 1;
    }
  }
}

class ControlledStream {
  private readonly queue: string[] = [];
  private finished = false;
  private wake: (() => void) | null = null;

  push(content: string): void {
    this.queue.push(content);
    this.release();
  }

  finish(): void {
    this.finished = true;
    this.release();
  }

  async next(): Promise<string | null> {
    while (true) {
      const value = this.queue.shift();
      if (value !== undefined) {
        return value;
      }
      if (this.finished) {
        return null;
      }
      await new Promise<void>((resolve) => {
        this.wake = resolve;
      });
    }
  }

  private release(): void {
    const wake = this.wake;
    this.wake = null;
    wake?.();
  }
}

/**
 * A provider whose generation is driven step by step from the test. `push` and
 * `finish` always target the most recently started stream, so superseded turns
 * cannot be woken by accident.
 */
export class ControlledChatProvider implements AIProvider {
  readonly prompts: string[][] = [];
  private readonly streams: ControlledStream[] = [];

  get startedStreams(): number {
    return this.streams.length;
  }

  /**
   * Starting a turn does asynchronous repository work before iteration begins,
   * so tests must await registration before pushing into a stream.
   */
  async whenStreaming(count: number): Promise<void> {
    await waitFor(
      () => this.streams.length >= count,
      `Controlled chat stream ${count} never started.`,
    );
  }

  async chat() {
    return { content: '{"memories":[]}' };
  }

  push(content: string): void {
    this.streams[this.streams.length - 1]?.push(content);
  }

  finish(): void {
    this.streams[this.streams.length - 1]?.finish();
  }

  async *streamChat(input: ChatInput): AsyncIterable<ChatChunk> {
    this.prompts.push(input.messages.map((message) => message.content));
    const stream = new ControlledStream();
    this.streams.push(stream);
    const abort = () => stream.finish();
    input.signal?.addEventListener("abort", abort, { once: true });
    try {
      while (true) {
        const content = await stream.next();
        if (content === null) {
          input.signal?.throwIfAborted();
          return;
        }
        yield { content };
      }
    } finally {
      input.signal?.removeEventListener("abort", abort);
    }
  }
}

export function staticChatProvider(...contents: readonly string[]): AIProvider {
  return {
    async chat() {
      return { content: '{"memories":[]}' };
    },
    async *streamChat() {
      for (const content of contents) {
        yield { content };
      }
    },
  };
}

export function createChatService(
  provider: AIProvider,
  repository = new InMemoryRepository(),
  extractionEngine = new FakeExtractionEngine(),
  playbackCoordinator?: VoicePlaybackCoordinator,
): { chatService: ShivaChatService; repository: InMemoryRepository } {
  const embeddingProvider = new FakeEmbeddingProvider();
  const chatService = new ShivaChatService({
    provider,
    repository,
    memoryRetriever: new MemoryRetriever(
      repository,
      embeddingProvider,
      new MemoryRanker(),
      testConfig.memoryRetrievalLimit,
    ),
    memoryService: new MemoryService(
      repository,
      embeddingProvider,
      extractionEngine,
    ),
    userId: testConfig.userId,
    userName: testConfig.userName,
    timeZone: testConfig.timeZone,
    workingMemoryMessageLimit: testConfig.workingMemoryMessageLimit,
    // Mirrors the production wiring so deferred memory cannot compete with
    // live speech in tests either.
    ...(playbackCoordinator
      ? {
          automaticMemoryGate: {
            waitUntilReady: async () =>
              (await playbackCoordinator.waitUntilAllIdle()) !== "closed",
            isClosed: () => playbackCoordinator.isClosed(),
          },
        }
      : {}),
  });
  return { chatService, repository };
}

export function sequentialIds(prefix = 1): () => string {
  let counter = 0;
  return () => {
    counter += 1;
    return `${String(prefix).repeat(8)}-0000-4000-8000-${String(counter).padStart(12, "0")}`;
  };
}

/** A minimal 16 kHz mono PCM16 WAV of the requested duration. */
export function createWavBytes(durationMs: number, sampleRate = 16_000): Buffer {
  const dataLength =
    Math.round((sampleRate * durationMs) / 1_000) * 2;
  const wav = Buffer.alloc(44 + dataLength);
  wav.write("RIFF", 0, "ascii");
  wav.writeUInt32LE(36 + dataLength, 4);
  wav.write("WAVE", 8, "ascii");
  wav.write("fmt ", 12, "ascii");
  wav.writeUInt32LE(16, 16);
  wav.writeUInt16LE(1, 20);
  wav.writeUInt16LE(1, 22);
  wav.writeUInt32LE(sampleRate, 24);
  wav.writeUInt32LE(sampleRate * 2, 28);
  wav.writeUInt16LE(2, 32);
  wav.writeUInt16LE(16, 34);
  wav.write("data", 36, "ascii");
  wav.writeUInt32LE(dataLength, 40);
  for (let frame = 0; frame < dataLength / 2; frame += 1) {
    wav.writeInt16LE(frame % 2 === 0 ? 8_000 : -8_000, 44 + frame * 2);
  }
  return wav;
}

export async function waitFor(
  condition: () => boolean,
  message = "Timed out waiting for a voice condition.",
  attempts = 2_000,
): Promise<void> {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    if (condition()) return;
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  assert.fail(message);
}
