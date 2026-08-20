export const VOICE_PERFORMANCE_STAGES = [
  "audio-upload",
  "asr-duration",
  "chat-ttft",
  "first-tts-request",
  "tts-duration",
  "time-to-first-audio",
] as const;

export type VoicePerformanceStage =
  (typeof VOICE_PERFORMANCE_STAGES)[number];

/** Turn-level summary for one voice exchange. */
export interface VoicePerformanceLog {
  readonly kind: "voice";
  readonly turnId: string;
  readonly timingsMs: Readonly<
    Record<VoicePerformanceStage, number | null>
  >;
}

/**
 * Per speech chunk record covering the whole path from streamed text to the
 * browser finishing playback. It exists to attribute audible gaps to
 * synthesis speed, transport, decoding, or browser scheduling.
 */
export interface VoiceTtsChunkPerformanceLog {
  readonly kind: "voice-tts-chunk";
  readonly turnId: string;
  readonly chunkId: number;
  readonly textChars: number;
  readonly timestampsUnixMs: Readonly<{
    textReady: number | null;
    queued: number | null;
    synthesisStarted: number;
    synthesisFinished: number | null;
    websocketSent: number | null;
    audioReceived: number | null;
    playbackScheduled: number | null;
    playbackStarted: number | null;
    playbackEnded: number | null;
  }>;
  readonly synthesisDurationMs: number | null;
  readonly audioDurationMs: number | null;
  /** synthesisDurationMs / audioDurationMs; above 1 means slower than realtime. */
  readonly realtimeFactor: number | null;
  readonly decodeDurationMs: number | null;
  readonly underrunMs: number | null;
}

export type VoicePerformanceEntry =
  | VoicePerformanceLog
  | VoiceTtsChunkPerformanceLog;

export type VoicePerformanceLogSink = (entry: VoicePerformanceEntry) => void;

export type VoicePlaybackEvent =
  | "received"
  | "scheduled"
  | "started"
  | "ended"
  | "underrun";

export interface VoicePlaybackEventDetail {
  readonly decodeDurationMs?: number;
  readonly underrunMs?: number;
}

interface VoiceTtsChunkTiming {
  textChars: number;
  textReadyAtUnixMs?: number;
  queuedAtUnixMs?: number;
  synthesisStartedAtUnixMs?: number;
  synthesisFinishedAtUnixMs?: number;
  synthesisDurationMs?: number;
  audioDurationMs?: number;
  websocketSentAtUnixMs?: number;
  audioReceivedAtUnixMs?: number;
  playbackScheduledAtUnixMs?: number;
  playbackStartedAtUnixMs?: number;
  playbackEndedAtUnixMs?: number;
  decodeDurationMs?: number;
  underrunMs?: number;
  emitted: boolean;
}

interface VoiceTurnTiming {
  readonly startedAt: number;
  uploadStartedAt?: number;
  chatStartedAt?: number;
  chatFirstTokenAt?: number;
  firstTtsStartedAt?: number;
  summaryEmitted: boolean;
  cleanupTimeout?: NodeJS.Timeout;
  readonly timings: Map<VoicePerformanceStage, number>;
  readonly ttsChunks: Map<number, VoiceTtsChunkTiming>;
}

interface ChunkQueuedMetadata {
  readonly textChars: number;
  readonly textReadyAtUnixMs?: number;
}

const TURN_RETENTION_MS = 10 * 60 * 1_000;
const PLAYBACK_TELEMETRY_GRACE_MS = 500;
const MAX_TRACKED_TURNS = 1_000;

export class VoicePerformanceTracker {
  private readonly turns = new Map<string, VoiceTurnTiming>();

  constructor(
    private readonly sink: VoicePerformanceLogSink,
    private readonly nowFunction: () => number = () => performance.now(),
    private readonly unixNowFunction: () => number = () => Date.now(),
  ) {}

  beginAudioUpload(turnId: string): void {
    const now = this.nowFunction();
    const turn = this.ensureTurn(turnId, now);
    turn.uploadStartedAt ??= now;
  }

  markAudioUploaded(turnId: string): void {
    const now = this.nowFunction();
    const turn = this.ensureTurn(turnId, now);
    if (turn.uploadStartedAt !== undefined) {
      this.record(turn, "audio-upload", now - turn.uploadStartedAt);
    }
  }

  recordAsrDuration(turnId: string, durationMs: number): void {
    this.record(this.ensureTurn(turnId), "asr-duration", durationMs);
  }

  markChatStarted(turnId: string): void {
    const now = this.nowFunction();
    this.ensureTurn(turnId, now).chatStartedAt ??= now;
  }

  markChatFirstToken(turnId: string): void {
    const now = this.nowFunction();
    const turn = this.ensureTurn(turnId, now);
    if (turn.chatFirstTokenAt !== undefined) {
      return;
    }
    turn.chatFirstTokenAt = now;
    if (turn.chatStartedAt !== undefined) {
      this.record(turn, "chat-ttft", now - turn.chatStartedAt);
    }
  }

  /** Records the moment a phrase left the chunker and entered the TTS queue. */
  markChunkQueued(
    turnId: string,
    chunkId: number,
    metadata: ChunkQueuedMetadata,
  ): void {
    const turn = this.ensureTurn(turnId);
    const chunk = this.ensureChunk(turn, chunkId);
    chunk.textChars = metadata.textChars;
    chunk.queuedAtUnixMs ??= this.unixNowFunction();
    if (metadata.textReadyAtUnixMs !== undefined) {
      chunk.textReadyAtUnixMs ??= metadata.textReadyAtUnixMs;
    }
  }

  /** Returns the monotonic start time to hand back to `finishTts`. */
  markTtsStarted(turnId: string, chunkId: number): number {
    const now = this.nowFunction();
    const turn = this.ensureTurn(turnId, now);
    if (chunkId === 0 && turn.firstTtsStartedAt === undefined) {
      turn.firstTtsStartedAt = now;
      const reference = turn.chatFirstTokenAt ?? turn.chatStartedAt;
      if (reference !== undefined) {
        this.record(turn, "first-tts-request", now - reference);
      }
    }
    const chunk = this.ensureChunk(turn, chunkId);
    chunk.synthesisStartedAtUnixMs ??= this.unixNowFunction();
    return now;
  }

  finishTts(
    turnId: string,
    chunkId: number,
    startedAt: number,
    audioDurationMs?: number,
  ): void {
    const now = this.nowFunction();
    const turn = this.ensureTurn(turnId, now);
    const chunk = turn.ttsChunks.get(chunkId);
    if (!chunk) {
      return;
    }

    chunk.synthesisDurationMs = roundMilliseconds(now - startedAt);
    chunk.synthesisFinishedAtUnixMs = this.unixNowFunction();
    if (audioDurationMs !== undefined) {
      chunk.audioDurationMs = roundMilliseconds(audioDurationMs);
    }
    if (chunkId === 0) {
      this.record(turn, "tts-duration", now - startedAt);
    }
    this.tryEmitCompleteChunk(turnId, chunkId, turn, chunk);
  }

  /** Records the moment a binary audio frame was handed to the socket. */
  markAudioSent(turnId: string, chunkId: number): void {
    const now = this.nowFunction();
    const turn = this.ensureTurn(turnId, now);
    const chunk = turn.ttsChunks.get(chunkId);
    if (!chunk) {
      return;
    }
    chunk.websocketSentAtUnixMs ??= this.unixNowFunction();
    if (chunkId === 0 && !turn.timings.has("time-to-first-audio")) {
      this.record(turn, "time-to-first-audio", now - turn.startedAt);
    }
  }

  recordPlaybackEvent(
    turnId: string,
    chunkId: number,
    event: VoicePlaybackEvent,
    timestampUnixMs = this.unixNowFunction(),
    detail: VoicePlaybackEventDetail = {},
  ): void {
    const turn = this.turns.get(turnId);
    if (!turn) {
      return;
    }
    const chunk = turn.ttsChunks.get(chunkId);
    if (!chunk) {
      return;
    }

    switch (event) {
      case "received":
        chunk.audioReceivedAtUnixMs = timestampUnixMs;
        break;
      case "scheduled":
        chunk.playbackScheduledAtUnixMs = timestampUnixMs;
        break;
      case "started":
        chunk.playbackStartedAtUnixMs = timestampUnixMs;
        break;
      case "ended":
        chunk.playbackEndedAtUnixMs = timestampUnixMs;
        break;
      case "underrun":
        break;
    }
    if (detail.decodeDurationMs !== undefined) {
      chunk.decodeDurationMs = roundMilliseconds(detail.decodeDurationMs);
    }
    if (detail.underrunMs !== undefined) {
      chunk.underrunMs = roundMilliseconds(detail.underrunMs);
    }
    this.tryEmitCompleteChunk(turnId, chunkId, turn, chunk);
  }

  /** Emits the turn summary once every foreground stage has been observed. */
  finishTurn(turnId: string): void {
    const turn = this.turns.get(turnId);
    if (turn) {
      this.emitSummary(turnId, turn);
    }
  }

  finishPlaybackTurn(turnId: string): void {
    const turn = this.turns.get(turnId);
    if (!turn) {
      return;
    }
    this.emitSummary(turnId, turn);
    if ([...turn.ttsChunks.values()].every((chunk) => chunk.emitted)) {
      this.deleteTurn(turnId, turn);
      return;
    }

    // A browser can report whole-turn idle immediately after the last chunk
    // ended, so keep a short grace window before emitting partial records.
    turn.cleanupTimeout ??= setTimeout(() => {
      for (const [chunkId, chunk] of turn.ttsChunks) {
        this.emitTtsChunk(turnId, chunkId, chunk);
      }
      this.deleteTurn(turnId, turn);
    }, PLAYBACK_TELEMETRY_GRACE_MS);
    turn.cleanupTimeout.unref();
  }

  private ensureTurn(
    turnId: string,
    startedAt = this.nowFunction(),
  ): VoiceTurnTiming {
    const existing = this.turns.get(turnId);
    if (existing) {
      return existing;
    }

    this.prune(startedAt);
    const created: VoiceTurnTiming = {
      startedAt,
      summaryEmitted: false,
      timings: new Map(),
      ttsChunks: new Map(),
    };
    this.turns.set(turnId, created);
    return created;
  }

  private ensureChunk(
    turn: VoiceTurnTiming,
    chunkId: number,
  ): VoiceTtsChunkTiming {
    const existing = turn.ttsChunks.get(chunkId);
    if (existing) {
      return existing;
    }
    const created: VoiceTtsChunkTiming = { textChars: 0, emitted: false };
    turn.ttsChunks.set(chunkId, created);
    return created;
  }

  private record(
    turn: VoiceTurnTiming,
    stage: VoicePerformanceStage,
    durationMs: number,
  ): void {
    turn.timings.set(stage, roundMilliseconds(durationMs));
  }

  private emitSummary(turnId: string, turn: VoiceTurnTiming): void {
    if (turn.summaryEmitted) {
      return;
    }
    turn.summaryEmitted = true;
    const timingsMs = Object.fromEntries(
      VOICE_PERFORMANCE_STAGES.map((stage) => [
        stage,
        turn.timings.get(stage) ?? null,
      ]),
    ) as Record<VoicePerformanceStage, number | null>;

    this.emit({ kind: "voice", turnId, timingsMs });
  }

  private emitTtsChunk(
    turnId: string,
    chunkId: number,
    chunk: VoiceTtsChunkTiming,
  ): void {
    if (chunk.emitted) {
      return;
    }
    chunk.emitted = true;
    const synthesisDurationMs = chunk.synthesisDurationMs ?? null;
    const audioDurationMs = chunk.audioDurationMs ?? null;
    this.emit({
      kind: "voice-tts-chunk",
      turnId,
      chunkId,
      textChars: chunk.textChars,
      timestampsUnixMs: {
        textReady: chunk.textReadyAtUnixMs ?? null,
        queued: chunk.queuedAtUnixMs ?? null,
        synthesisStarted: chunk.synthesisStartedAtUnixMs ?? 0,
        synthesisFinished: chunk.synthesisFinishedAtUnixMs ?? null,
        websocketSent: chunk.websocketSentAtUnixMs ?? null,
        audioReceived: chunk.audioReceivedAtUnixMs ?? null,
        playbackScheduled: chunk.playbackScheduledAtUnixMs ?? null,
        playbackStarted: chunk.playbackStartedAtUnixMs ?? null,
        playbackEnded: chunk.playbackEndedAtUnixMs ?? null,
      },
      synthesisDurationMs,
      audioDurationMs,
      realtimeFactor:
        synthesisDurationMs !== null &&
        audioDurationMs !== null &&
        audioDurationMs > 0
          ? roundRatio(synthesisDurationMs / audioDurationMs)
          : null,
      decodeDurationMs: chunk.decodeDurationMs ?? null,
      underrunMs: chunk.underrunMs ?? null,
    });
  }

  private tryEmitCompleteChunk(
    turnId: string,
    chunkId: number,
    turn: VoiceTurnTiming,
    chunk: VoiceTtsChunkTiming,
  ): void {
    if (
      chunk.synthesisFinishedAtUnixMs === undefined ||
      chunk.playbackScheduledAtUnixMs === undefined ||
      chunk.playbackStartedAtUnixMs === undefined ||
      chunk.playbackEndedAtUnixMs === undefined
    ) {
      return;
    }
    this.emitTtsChunk(turnId, chunkId, chunk);
    if (
      turn.cleanupTimeout &&
      [...turn.ttsChunks.values()].every((candidate) => candidate.emitted)
    ) {
      this.deleteTurn(turnId, turn);
    }
  }

  private deleteTurn(turnId: string, turn: VoiceTurnTiming): void {
    if (turn.cleanupTimeout) {
      clearTimeout(turn.cleanupTimeout);
      delete turn.cleanupTimeout;
    }
    this.turns.delete(turnId);
  }

  private emit(entry: VoicePerformanceEntry): void {
    try {
      this.sink(entry);
    } catch {
      // Observability must never affect the voice pipeline.
    }
  }

  private prune(now: number): void {
    for (const [turnId, turn] of this.turns) {
      if (now - turn.startedAt > TURN_RETENTION_MS) {
        this.flushTurn(turnId, turn);
      }
    }
    while (this.turns.size >= MAX_TRACKED_TURNS) {
      const oldest = this.turns.keys().next().value as string | undefined;
      if (!oldest) {
        break;
      }
      const turn = this.turns.get(oldest);
      if (turn) {
        this.flushTurn(oldest, turn);
      }
    }
  }

  private flushTurn(turnId: string, turn: VoiceTurnTiming): void {
    for (const [chunkId, chunk] of turn.ttsChunks) {
      this.emitTtsChunk(turnId, chunkId, chunk);
    }
    this.deleteTurn(turnId, turn);
  }
}

export function formatVoicePerformanceLog(
  entry: VoicePerformanceEntry,
): string {
  if (entry.kind === "voice-tts-chunk") {
    const timestamps = entry.timestampsUnixMs;
    return [
      "[SHIVA VOICE TTS PERF]",
      `turn=${entry.turnId}`,
      `chunk=${entry.chunkId}`,
      `text-chars=${entry.textChars}`,
      `text-ready-at=${formatTimestamp(timestamps.textReady)}`,
      `queued-at=${formatTimestamp(timestamps.queued)}`,
      `synthesis-start=${formatTimestamp(timestamps.synthesisStarted)}`,
      `synthesis-end=${formatTimestamp(timestamps.synthesisFinished)}`,
      `synthesis=${formatNullableMilliseconds(entry.synthesisDurationMs)}`,
      `audio-duration=${formatNullableMilliseconds(entry.audioDurationMs)}`,
      `rtf=${entry.realtimeFactor?.toFixed(3) ?? "n/a"}`,
      `websocket-sent-at=${formatTimestamp(timestamps.websocketSent)}`,
      `audio-received-at=${formatTimestamp(timestamps.audioReceived)}`,
      `decode=${formatNullableMilliseconds(entry.decodeDurationMs)}`,
      `playback-scheduled=${formatTimestamp(timestamps.playbackScheduled)}`,
      `playback-start=${formatTimestamp(timestamps.playbackStarted)}`,
      `playback-end=${formatTimestamp(timestamps.playbackEnded)}`,
      `underrun=${formatNullableMilliseconds(entry.underrunMs)}`,
    ].join(" ");
  }

  const timings = VOICE_PERFORMANCE_STAGES.flatMap((stage) => {
    const value = entry.timingsMs[stage];
    return value === null ? [] : [`${stage}=${value.toFixed(2)}ms`];
  });
  return `[SHIVA VOICE PERF] turn=${entry.turnId} ${timings.join(" ")}`;
}

function roundMilliseconds(value: number): number {
  return Math.round(Math.max(0, value) * 100) / 100;
}

function roundRatio(value: number): number {
  return Math.round(Math.max(0, value) * 1_000) / 1_000;
}

function formatTimestamp(value: number | null): string {
  return value === null ? "n/a" : String(value);
}

function formatNullableMilliseconds(value: number | null): string {
  return value === null ? "n/a" : `${value.toFixed(2)}ms`;
}
