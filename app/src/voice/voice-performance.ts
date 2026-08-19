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

/** Existing turn-level performance entry retained for compatibility. */
export interface VoicePerformanceLog {
  readonly kind: "voice";
  readonly turnId: string;
  readonly timingsMs: Readonly<
    Record<VoicePerformanceStage, number | null>
  >;
}

export interface VoiceTtsChunkPerformanceLog {
  readonly kind: "voice-tts-chunk";
  readonly turnId: string;
  readonly sequence: number;
  readonly textLength: number;
  readonly timestampsUnixMs: Readonly<{
    textReady: number | null;
    synthesisStarted: number;
    synthesisEnded: number | null;
    playbackScheduled: number | null;
    playbackStarted: number | null;
    playbackEnded: number | null;
  }>;
  readonly synthesisDurationMs: number | null;
  readonly audioDurationMs: number | null;
  readonly rtf: number | null;
}

export type VoicePerformanceEntry =
  | VoicePerformanceLog
  | VoiceTtsChunkPerformanceLog;

export type VoicePerformanceLogSink = (entry: VoicePerformanceEntry) => void;

export type VoicePlaybackEvent = "scheduled" | "started" | "ended";

interface VoiceTtsChunkTiming {
  textLength: number;
  textReadyAtUnixMs?: number;
  synthesisStartedAt: number;
  synthesisStartedAtUnixMs: number;
  synthesisEndedAtUnixMs?: number;
  synthesisDurationMs?: number;
  audioDurationMs?: number;
  playbackScheduledAtUnixMs?: number;
  playbackStartedAtUnixMs?: number;
  playbackEndedAtUnixMs?: number;
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

interface TtsStartMetadata {
  readonly textLength: number;
  readonly textReadyAtUnixMs?: number;
}

const TURN_RETENTION_MS = 10 * 60 * 1_000;
const PLAYBACK_TELEMETRY_GRACE_MS = 500;
const MAX_TRACKED_TURNS = 1_000;
const VOICE_TURN_ID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function parseVoiceTurnId(value: unknown): string | undefined {
  return typeof value === "string" && VOICE_TURN_ID.test(value)
    ? value
    : undefined;
}

export function parseVoiceTimestamp(value: unknown): number | undefined {
  if (typeof value !== "string" || value.trim().length === 0) {
    return undefined;
  }
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : undefined;
}

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
    turn.uploadStartedAt = now;
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
    this.ensureTurn(turnId, now).chatStartedAt = now;
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

  markTtsStarted(
    turnId: string,
    sequence: number,
    metadata: TtsStartMetadata,
  ): number {
    const now = this.nowFunction();
    const turn = this.ensureTurn(turnId, now);
    if (sequence === 0 && turn.firstTtsStartedAt === undefined) {
      turn.firstTtsStartedAt = now;
      const reference = turn.chatFirstTokenAt ?? turn.chatStartedAt;
      if (reference !== undefined) {
        this.record(turn, "first-tts-request", now - reference);
      }
    }
    turn.ttsChunks.set(sequence, {
      textLength: metadata.textLength,
      ...(metadata.textReadyAtUnixMs !== undefined
        ? { textReadyAtUnixMs: metadata.textReadyAtUnixMs }
        : {}),
      synthesisStartedAt: now,
      synthesisStartedAtUnixMs: this.unixNowFunction(),
      emitted: false,
    });
    return now;
  }

  finishTts(
    turnId: string,
    sequence: number,
    startedAt: number,
    audio: Uint8Array,
  ): void {
    const now = this.nowFunction();
    const turn = this.ensureTurn(turnId, now);
    const chunk = turn.ttsChunks.get(sequence);
    if (!chunk) {
      return;
    }

    chunk.synthesisDurationMs = roundMilliseconds(now - startedAt);
    chunk.synthesisEndedAtUnixMs = this.unixNowFunction();
    const audioDurationMs = getWavDurationMs(audio);
    if (audioDurationMs !== undefined) {
      chunk.audioDurationMs = roundMilliseconds(audioDurationMs);
    }

    if (sequence === 0) {
      this.record(turn, "tts-duration", now - startedAt);
      this.record(turn, "time-to-first-audio", now - turn.startedAt);
      this.emitSummary(turnId, turn);
    }

    this.tryEmitCompleteChunk(turnId, sequence, turn, chunk);
  }

  recordPlaybackEvent(
    turnId: string,
    sequence: number,
    event: VoicePlaybackEvent,
    timestampUnixMs = this.unixNowFunction(),
  ): void {
    const turn = this.turns.get(turnId);
    if (!turn) {
      return;
    }
    const chunk = turn.ttsChunks.get(sequence);
    if (!chunk) {
      return;
    }

    switch (event) {
      case "scheduled":
        chunk.playbackScheduledAtUnixMs = timestampUnixMs;
        break;
      case "started":
        chunk.playbackStartedAtUnixMs = timestampUnixMs;
        break;
      case "ended":
        chunk.playbackEndedAtUnixMs = timestampUnixMs;
        break;
    }
    this.tryEmitCompleteChunk(turnId, sequence, turn, chunk);
  }

  finishPlaybackTurn(turnId: string): void {
    const turn = this.turns.get(turnId);
    if (!turn) {
      return;
    }
    if ([...turn.ttsChunks.values()].every((chunk) => chunk.emitted)) {
      this.deleteTurn(turnId, turn);
      return;
    }

    // Playback events are sent independently with keepalive fetches, so an
    // idle request can overtake an immediately preceding ended request. Keep
    // a short grace window before emitting a partial record.
    turn.cleanupTimeout ??= setTimeout(() => {
      for (const [sequence, chunk] of turn.ttsChunks) {
        this.emitTtsChunk(turnId, sequence, chunk);
      }
      this.deleteTurn(turnId, turn);
    }, PLAYBACK_TELEMETRY_GRACE_MS);
    turn.cleanupTimeout.unref();
  }

  private ensureTurn(turnId: string, startedAt = this.nowFunction()): VoiceTurnTiming {
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
    sequence: number,
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
      sequence,
      textLength: chunk.textLength,
      timestampsUnixMs: {
        textReady: chunk.textReadyAtUnixMs ?? null,
        synthesisStarted: chunk.synthesisStartedAtUnixMs,
        synthesisEnded: chunk.synthesisEndedAtUnixMs ?? null,
        playbackScheduled: chunk.playbackScheduledAtUnixMs ?? null,
        playbackStarted: chunk.playbackStartedAtUnixMs ?? null,
        playbackEnded: chunk.playbackEndedAtUnixMs ?? null,
      },
      synthesisDurationMs,
      audioDurationMs,
      rtf:
        synthesisDurationMs !== null &&
        audioDurationMs !== null &&
        audioDurationMs > 0
          ? roundRatio(synthesisDurationMs / audioDurationMs)
          : null,
    });
  }

  private tryEmitCompleteChunk(
    turnId: string,
    sequence: number,
    turn: VoiceTurnTiming,
    chunk: VoiceTtsChunkTiming,
  ): void {
    if (
      chunk.synthesisEndedAtUnixMs === undefined ||
      chunk.playbackScheduledAtUnixMs === undefined ||
      chunk.playbackStartedAtUnixMs === undefined ||
      chunk.playbackEndedAtUnixMs === undefined
    ) {
      return;
    }
    this.emitTtsChunk(turnId, sequence, chunk);
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
        for (const [sequence, chunk] of turn.ttsChunks) {
          this.emitTtsChunk(turnId, sequence, chunk);
        }
        this.deleteTurn(turnId, turn);
      }
    }
    while (this.turns.size >= MAX_TRACKED_TURNS) {
      const oldest = this.turns.keys().next().value as string | undefined;
      if (!oldest) {
        break;
      }
      const turn = this.turns.get(oldest);
      if (turn) {
        for (const [sequence, chunk] of turn.ttsChunks) {
          this.emitTtsChunk(oldest, sequence, chunk);
        }
        this.deleteTurn(oldest, turn);
      }
    }
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
      `sequence=${entry.sequence}`,
      `text-length=${entry.textLength}`,
      `text-ready-at=${formatTimestamp(timestamps.textReady)}`,
      `synthesis-start=${formatTimestamp(timestamps.synthesisStarted)}`,
      `synthesis-end=${formatTimestamp(timestamps.synthesisEnded)}`,
      `synthesis=${formatNullableMilliseconds(entry.synthesisDurationMs)}`,
      `audio-duration=${formatNullableMilliseconds(entry.audioDurationMs)}`,
      `rtf=${entry.rtf?.toFixed(3) ?? "n/a"}`,
      `playback-scheduled=${formatTimestamp(timestamps.playbackScheduled)}`,
      `playback-start=${formatTimestamp(timestamps.playbackStarted)}`,
      `playback-end=${formatTimestamp(timestamps.playbackEnded)}`,
    ].join(" ");
  }

  const timings = VOICE_PERFORMANCE_STAGES.flatMap((stage) => {
    const value = entry.timingsMs[stage];
    return value === null ? [] : [`${stage}=${value.toFixed(2)}ms`];
  });
  return `[SHIVA VOICE PERF] ${timings.join(" ")}`;
}

export function getWavDurationMs(audio: Uint8Array): number | undefined {
  if (audio.byteLength < 12) {
    return undefined;
  }
  const view = new DataView(audio.buffer, audio.byteOffset, audio.byteLength);
  if (
    readFourCc(view, 0) !== "RIFF" ||
    readFourCc(view, 8) !== "WAVE"
  ) {
    return undefined;
  }

  let byteRate: number | undefined;
  let dataBytes: number | undefined;
  let offset = 12;
  while (offset + 8 <= view.byteLength) {
    const chunkType = readFourCc(view, offset);
    const declaredSize = view.getUint32(offset + 4, true);
    const dataOffset = offset + 8;
    const availableSize = Math.min(declaredSize, view.byteLength - dataOffset);

    if (chunkType === "fmt " && availableSize >= 16) {
      const candidate = view.getUint32(dataOffset + 8, true);
      if (candidate > 0) {
        byteRate = candidate;
      }
    } else if (chunkType === "data") {
      dataBytes = availableSize;
    }

    if (byteRate !== undefined && dataBytes !== undefined) {
      return (dataBytes / byteRate) * 1_000;
    }

    const paddedSize = declaredSize + (declaredSize % 2);
    if (paddedSize > view.byteLength - dataOffset) {
      break;
    }
    offset = dataOffset + paddedSize;
  }

  return undefined;
}

function readFourCc(view: DataView, offset: number): string {
  return String.fromCharCode(
    view.getUint8(offset),
    view.getUint8(offset + 1),
    view.getUint8(offset + 2),
    view.getUint8(offset + 3),
  );
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
