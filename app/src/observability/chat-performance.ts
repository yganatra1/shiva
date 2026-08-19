export const CHAT_PERFORMANCE_STAGES = [
  "resolve-user",
  "conversation",
  "save-message",
  "working-memory",
  "explicit-memory",
  "embedding",
  "memory-search",
  "ranking",
  "memory-touch",
  "prompt-build",
  "pre-ollama",
  "ollama-ttft",
  "generation",
  "ollama-total",
  "save-assistant",
  "memory-schedule",
  "total-ttft",
  "total-request",
] as const;

export type ChatPerformanceStage = (typeof CHAT_PERFORMANCE_STAGES)[number];
export type ChatPerformanceOutcome =
  | "success"
  | "error"
  | "cancelled"
  | "stream-error";

export interface ForegroundPerformanceLog {
  readonly kind: "foreground";
  readonly requestId: string;
  readonly conversationId?: string;
  readonly outcome: ChatPerformanceOutcome;
  readonly timingsMs: Readonly<
    Record<ChatPerformanceStage, number | null>
  >;
}

export interface AsyncMemoryPerformanceLog {
  readonly kind: "async-memory";
  readonly requestId: string;
  readonly conversationId: string;
  readonly outcome: "success" | "error";
  readonly queueDelayMs: number;
  readonly durationMs: number;
  readonly totalSinceScheduledMs: number;
}

export type ChatPerformanceLog =
  | ForegroundPerformanceLog
  | AsyncMemoryPerformanceLog;

export type ChatPerformanceLogSink = (entry: ChatPerformanceLog) => void;

interface ChatPerformanceTraceOptions {
  readonly requestId: string;
  readonly sink: ChatPerformanceLogSink;
  readonly now?: () => number;
}

export class ChatPerformanceTrace {
  private readonly startedAt: number;
  private readonly timings = new Map<ChatPerformanceStage, number>();
  private readonly nowFunction: () => number;
  private conversationId: string | undefined;
  private ollamaStartedAt: number | undefined;
  private firstTokenAt: number | undefined;
  private foregroundEmitted = false;

  constructor(private readonly options: ChatPerformanceTraceOptions) {
    this.nowFunction = options.now ?? (() => performance.now());
    this.startedAt = this.nowFunction();
  }

  async measure<T>(
    stage: ChatPerformanceStage,
    operation: () => Promise<T>,
  ): Promise<T> {
    const startedAt = this.nowFunction();
    try {
      return await operation();
    } finally {
      this.record(stage, this.nowFunction() - startedAt);
    }
  }

  measureSync<T>(stage: ChatPerformanceStage, operation: () => T): T {
    const startedAt = this.nowFunction();
    try {
      return operation();
    } finally {
      this.record(stage, this.nowFunction() - startedAt);
    }
  }

  setConversationId(conversationId: string): void {
    this.conversationId = conversationId;
  }

  markBeforeOllama(): void {
    const now = this.nowFunction();
    this.ollamaStartedAt = now;
    this.record("pre-ollama", now - this.startedAt);
  }

  markOllamaFirstToken(): void {
    if (this.firstTokenAt !== undefined) {
      return;
    }

    const now = this.nowFunction();
    this.firstTokenAt = now;
    if (this.ollamaStartedAt !== undefined) {
      this.record("ollama-ttft", now - this.ollamaStartedAt);
    }
    this.record("total-ttft", now - this.startedAt);
  }

  markOllamaComplete(): void {
    const now = this.nowFunction();
    if (this.ollamaStartedAt !== undefined) {
      this.record("ollama-total", now - this.ollamaStartedAt);
    }
    if (this.firstTokenAt !== undefined) {
      this.record("generation", now - this.firstTokenAt);
    }
  }

  now(): number {
    return this.nowFunction();
  }

  record(stage: ChatPerformanceStage, durationMs: number): void {
    this.timings.set(stage, roundMilliseconds(durationMs));
  }

  finishForeground(outcome: ChatPerformanceOutcome): void {
    if (this.foregroundEmitted) {
      return;
    }

    this.foregroundEmitted = true;
    this.record("total-request", this.nowFunction() - this.startedAt);
    this.emit({
      kind: "foreground",
      requestId: this.options.requestId,
      ...(this.conversationId ? { conversationId: this.conversationId } : {}),
      outcome,
      timingsMs: createTimingSnapshot(this.timings),
    });
  }

  finishAsyncMemory(
    conversationId: string,
    scheduledAt: number,
    startedAt: number,
    outcome: "success" | "error",
  ): void {
    const completedAt = this.nowFunction();
    this.emit({
      kind: "async-memory",
      requestId: this.options.requestId,
      conversationId,
      outcome,
      queueDelayMs: roundMilliseconds(startedAt - scheduledAt),
      durationMs: roundMilliseconds(completedAt - startedAt),
      totalSinceScheduledMs: roundMilliseconds(completedAt - scheduledAt),
    });
  }

  private emit(entry: ChatPerformanceLog): void {
    try {
      this.options.sink(entry);
    } catch {
      // Diagnostics must never affect the chat or memory pipeline.
    }
  }
}

export async function measureChatPerformance<T>(
  trace: ChatPerformanceTrace | undefined,
  stage: ChatPerformanceStage,
  operation: () => Promise<T>,
): Promise<T> {
  return trace ? trace.measure(stage, operation) : operation();
}

export function measureChatPerformanceSync<T>(
  trace: ChatPerformanceTrace | undefined,
  stage: ChatPerformanceStage,
  operation: () => T,
): T {
  return trace ? trace.measureSync(stage, operation) : operation();
}

export function formatChatPerformanceLog(entry: ChatPerformanceLog): string {
  if (entry.kind === "async-memory") {
    return `[SHIVA PERF ASYNC] queue-delay=${formatMilliseconds(entry.queueDelayMs)} memory-extraction=${formatMilliseconds(entry.durationMs)} total=${formatMilliseconds(entry.totalSinceScheduledMs)} outcome=${entry.outcome}`;
  }

  const timings = CHAT_PERFORMANCE_STAGES.flatMap((stage) => {
    const value = entry.timingsMs[stage];
    return value === null ? [] : [`${stage}=${formatMilliseconds(value)}`];
  });
  return `[SHIVA PERF] ${timings.join(" ")} outcome=${entry.outcome}`;
}

function createTimingSnapshot(
  timings: ReadonlyMap<ChatPerformanceStage, number>,
): Record<ChatPerformanceStage, number | null> {
  return Object.fromEntries(
    CHAT_PERFORMANCE_STAGES.map((stage) => [stage, timings.get(stage) ?? null]),
  ) as Record<ChatPerformanceStage, number | null>;
}

function roundMilliseconds(value: number): number {
  return Math.round(Math.max(0, value) * 100) / 100;
}

function formatMilliseconds(value: number): string {
  return `${value.toFixed(2)}ms`;
}
