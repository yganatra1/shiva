import type { AudibleWindow, AudioPlaybackPlan } from "../audio-scheduling";

export interface AudioBufferLike {
  readonly numberOfChannels: number;
  readonly sampleRate: number;
  readonly duration: number;
  getChannelData(channel: number): Float32Array;
}

export interface AudioBufferSourceLike {
  buffer: AudioBufferLike | null;
  connect(destination: unknown): void;
  disconnect(): void;
  start(when: number, offset?: number, duration?: number): void;
  stop(when?: number): void;
  addEventListener(
    type: "ended",
    listener: () => void,
    options?: { readonly once?: boolean },
  ): void;
}

export interface AudioContextLike {
  readonly currentTime: number;
  readonly state: string;
  readonly destination: unknown;
  resume(): Promise<void>;
  createBuffer(
    channels: number,
    length: number,
    sampleRate: number,
  ): AudioBufferLike;
  createBufferSource(): AudioBufferSourceLike;
  decodeAudioData(data: ArrayBuffer): Promise<AudioBufferLike>;
}

export interface VoiceAudioChunk {
  readonly turnSequence: number;
  readonly chunkId: number;
  readonly format: "pcm16" | "wav";
  readonly sampleRate: number;
  readonly channels: number;
  readonly audio: Uint8Array;
}

export type VoiceAudioPlayerEvent =
  | {
      readonly type: "scheduled";
      readonly turnSequence: number;
      readonly chunkId: number;
      readonly timestampMs: number;
      readonly decodeDurationMs: number;
      readonly startAtSeconds: number;
      readonly underrunMs: number;
    }
  | {
      readonly type: "started" | "ended";
      readonly turnSequence: number;
      readonly chunkId: number;
      readonly timestampMs: number;
    }
  | {
      readonly type: "underrun";
      readonly turnSequence: number;
      readonly chunkId: number;
      readonly timestampMs: number;
      readonly underrunMs: number;
    }
  | {
      readonly type: "drained";
      readonly turnSequence: number;
    }
  | {
      readonly type: "error";
      readonly turnSequence: number;
      readonly chunkId: number;
      readonly message: string;
    };

export interface VoiceAudioPlayerOptions {
  readonly context: AudioContextLike;
  readonly planPlayback: (
    currentTime: number,
    scheduledUntil: number | null,
    durationSeconds: number,
  ) => AudioPlaybackPlan;
  readonly findAudible: (
    channels: readonly Float32Array[],
    sampleRate: number,
  ) => AudibleWindow;
  readonly onEvent: (event: VoiceAudioPlayerEvent) => void;
  readonly unixNow: () => number;
  readonly monotonicNow: () => number;
  readonly setTimer: (callback: () => void, delayMs: number) => number;
  readonly clearTimer: (timer: number) => void;
  readonly underrunThresholdMs?: number;
}

/**
 * Keeps one continuous Web Audio timeline for the whole session.
 *
 * Incoming frames are decoded and appended directly after the previously
 * scheduled buffer, so JavaScript timing never inserts a pause between speech
 * chunks. Only a genuinely empty queue produces a gap, and that is reported as
 * an underrun instead of being hidden.
 *
 * The class has no imports at runtime so the voice page can embed it with
 * `VoiceAudioPlayer.toString()`.
 */
export const VoiceAudioPlayer = (() => class {
  private generation = 0;
  private activeTurnSequence = -1;
  private scheduledUntil: number | null = null;
  private tail: Promise<void> = Promise.resolve();
  private pending = 0;
  private readonly sources = new Set<AudioBufferSourceLike>();
  private readonly timers = new Set<number>();

  constructor(private readonly options: VoiceAudioPlayerOptions) {}

  /** Starts a new turn timeline and discards anything still queued. */
  beginTurn(turnSequence: number): void {
    this.stop();
    this.activeTurnSequence = turnSequence;
  }

  enqueue(chunk: VoiceAudioChunk): void {
    if (chunk.turnSequence !== this.activeTurnSequence) return;

    const generation = this.generation;
    this.pending += 1;
    this.tail = this.tail.then(() => this.play(chunk, generation));
  }

  /** Immediately silences playback and clears the queue. */
  stop(): void {
    this.generation += 1;
    this.pending = 0;
    this.scheduledUntil = null;
    this.tail = Promise.resolve();
    for (const timer of this.timers) this.options.clearTimer(timer);
    this.timers.clear();
    for (const source of this.sources) {
      try {
        source.stop();
      } catch {
        // The source may already have finished.
      }
      try {
        source.disconnect();
      } catch {
        // Nothing remains connected.
      }
    }
    this.sources.clear();
  }

  isIdle(): boolean {
    return this.pending === 0 && this.sources.size === 0;
  }

  private async play(chunk: VoiceAudioChunk, generation: number): Promise<void> {
    try {
      if (generation !== this.generation) return;
      const decodeStartedAt = this.options.monotonicNow();
      const buffer = await this.decode(chunk);
      if (generation !== this.generation || buffer === null) return;
      const decodeDurationMs = this.options.monotonicNow() - decodeStartedAt;
      this.schedule(chunk, buffer, decodeDurationMs);
    } catch (error) {
      if (generation !== this.generation) return;
      this.options.onEvent({
        type: "error",
        turnSequence: chunk.turnSequence,
        chunkId: chunk.chunkId,
        message:
          error instanceof Error ? error.message : "Audio could not be played.",
      });
    } finally {
      if (generation === this.generation) {
        this.pending = Math.max(0, this.pending - 1);
        this.reportDrainedIfIdle(chunk.turnSequence);
      }
    }
  }

  private async decode(chunk: VoiceAudioChunk): Promise<AudioBufferLike | null> {
    const context = this.options.context;
    if (context.state === "suspended") await context.resume();

    if (chunk.format === "wav") {
      const copy = chunk.audio.slice();
      return await context.decodeAudioData(
        copy.buffer as ArrayBuffer,
      );
    }

    const channels = Math.max(1, chunk.channels);
    const bytesPerFrame = channels * 2;
    const frames = Math.floor(chunk.audio.byteLength / bytesPerFrame);
    if (frames === 0 || chunk.sampleRate <= 0) return null;

    // PCM16 needs no container decode, so this stays synchronous and cheap.
    const buffer = context.createBuffer(channels, frames, chunk.sampleRate);
    const view = new DataView(
      chunk.audio.buffer,
      chunk.audio.byteOffset,
      chunk.audio.byteLength,
    );
    for (let channel = 0; channel < channels; channel += 1) {
      const target = buffer.getChannelData(channel);
      for (let frame = 0; frame < frames; frame += 1) {
        target[frame] =
          view.getInt16((frame * channels + channel) * 2, true) / 32_768;
      }
    }
    return buffer;
  }

  private schedule(
    chunk: VoiceAudioChunk,
    buffer: AudioBufferLike,
    decodeDurationMs: number,
  ): void {
    const context = this.options.context;
    const channels: Float32Array[] = [];
    for (let channel = 0; channel < buffer.numberOfChannels; channel += 1) {
      channels.push(buffer.getChannelData(channel));
    }
    const audible = this.options.findAudible(channels, buffer.sampleRate);
    if (audible.durationSeconds <= 0) return;

    const plan = this.options.planPlayback(
      context.currentTime,
      this.scheduledUntil,
      audible.durationSeconds,
    );
    const previousScheduledUntil = this.scheduledUntil;
    const source = context.createBufferSource();
    source.buffer = buffer;
    source.connect(context.destination);
    this.sources.add(source);
    this.scheduledUntil = plan.endAt;

    const generation = this.generation;
    source.addEventListener(
      "ended",
      () => {
        this.sources.delete(source);
        if (generation !== this.generation) return;
        this.options.onEvent({
          type: "ended",
          turnSequence: chunk.turnSequence,
          chunkId: chunk.chunkId,
          timestampMs: this.options.unixNow(),
        });
        this.reportDrainedIfIdle(chunk.turnSequence);
      },
      { once: true },
    );

    try {
      source.start(plan.startAt, audible.offsetSeconds, audible.durationSeconds);
    } catch (error) {
      this.sources.delete(source);
      this.scheduledUntil = previousScheduledUntil;
      try {
        source.disconnect();
      } catch {
        // Nothing remains connected.
      }
      throw error;
    }

    this.options.onEvent({
      type: "scheduled",
      turnSequence: chunk.turnSequence,
      chunkId: chunk.chunkId,
      timestampMs: this.options.unixNow(),
      decodeDurationMs,
      startAtSeconds: plan.startAt,
      underrunMs: plan.underrunMs,
    });
    if (plan.underrunMs > (this.options.underrunThresholdMs ?? 50)) {
      this.options.onEvent({
        type: "underrun",
        turnSequence: chunk.turnSequence,
        chunkId: chunk.chunkId,
        timestampMs: this.options.unixNow(),
        underrunMs: plan.underrunMs,
      });
    }

    const startDelayMs = Math.max(0, (plan.startAt - context.currentTime) * 1_000);
    const timer = this.options.setTimer(() => {
      this.timers.delete(timer);
      if (generation !== this.generation) return;
      this.options.onEvent({
        type: "started",
        turnSequence: chunk.turnSequence,
        chunkId: chunk.chunkId,
        timestampMs: this.options.unixNow(),
      });
    }, startDelayMs);
    this.timers.add(timer);
  }

  private reportDrainedIfIdle(turnSequence: number): void {
    if (!this.isIdle()) return;
    this.options.onEvent({ type: "drained", turnSequence });
  }
})();
