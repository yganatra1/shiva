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

export interface VoicePerformanceLog {
  readonly kind: "voice";
  readonly turnId: string;
  readonly timingsMs: Readonly<
    Record<VoicePerformanceStage, number | null>
  >;
}

export type VoicePerformanceLogSink = (entry: VoicePerformanceLog) => void;

interface VoiceTurnTiming {
  readonly startedAt: number;
  uploadStartedAt?: number;
  chatStartedAt?: number;
  chatFirstTokenAt?: number;
  firstTtsStartedAt?: number;
  emitted: boolean;
  readonly timings: Map<VoicePerformanceStage, number>;
}

const TURN_RETENTION_MS = 10 * 60 * 1_000;
const MAX_TRACKED_TURNS = 1_000;
const VOICE_TURN_ID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function parseVoiceTurnId(value: unknown): string | undefined {
  return typeof value === "string" && VOICE_TURN_ID.test(value)
    ? value
    : undefined;
}

export class VoicePerformanceTracker {
  private readonly turns = new Map<string, VoiceTurnTiming>();

  constructor(
    private readonly sink: VoicePerformanceLogSink,
    private readonly nowFunction: () => number = () => performance.now(),
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

  markTtsStarted(turnId: string, sequence: number): number {
    const now = this.nowFunction();
    const turn = this.ensureTurn(turnId, now);
    if (sequence === 0 && turn.firstTtsStartedAt === undefined) {
      turn.firstTtsStartedAt = now;
      const reference = turn.chatFirstTokenAt ?? turn.chatStartedAt;
      if (reference !== undefined) {
        this.record(turn, "first-tts-request", now - reference);
      }
    }
    return now;
  }

  finishTts(turnId: string, sequence: number, startedAt: number): void {
    if (sequence !== 0) {
      return;
    }
    const now = this.nowFunction();
    const turn = this.ensureTurn(turnId, now);
    this.record(turn, "tts-duration", now - startedAt);
    this.record(turn, "time-to-first-audio", now - turn.startedAt);
    this.emit(turnId, turn);
  }

  private ensureTurn(turnId: string, startedAt = this.nowFunction()): VoiceTurnTiming {
    const existing = this.turns.get(turnId);
    if (existing) {
      return existing;
    }

    this.prune(startedAt);
    const created: VoiceTurnTiming = {
      startedAt,
      emitted: false,
      timings: new Map(),
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

  private emit(turnId: string, turn: VoiceTurnTiming): void {
    if (turn.emitted) {
      return;
    }
    turn.emitted = true;
    const timingsMs = Object.fromEntries(
      VOICE_PERFORMANCE_STAGES.map((stage) => [
        stage,
        turn.timings.get(stage) ?? null,
      ]),
    ) as Record<VoicePerformanceStage, number | null>;

    try {
      this.sink({ kind: "voice", turnId, timingsMs });
    } catch {
      // Observability must never affect the voice pipeline.
    } finally {
      this.turns.delete(turnId);
    }
  }

  private prune(now: number): void {
    for (const [turnId, turn] of this.turns) {
      if (now - turn.startedAt > TURN_RETENTION_MS) {
        this.turns.delete(turnId);
      }
    }
    while (this.turns.size >= MAX_TRACKED_TURNS) {
      const oldest = this.turns.keys().next().value as string | undefined;
      if (!oldest) {
        break;
      }
      this.turns.delete(oldest);
    }
  }
}

export function formatVoicePerformanceLog(entry: VoicePerformanceLog): string {
  const timings = VOICE_PERFORMANCE_STAGES.flatMap((stage) => {
    const value = entry.timingsMs[stage];
    return value === null ? [] : [`${stage}=${value.toFixed(2)}ms`];
  });
  return `[SHIVA VOICE PERF] ${timings.join(" ")}`;
}

function roundMilliseconds(value: number): number {
  return Math.round(Math.max(0, value) * 100) / 100;
}
