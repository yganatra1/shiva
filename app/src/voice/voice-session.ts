import { randomUUID } from "node:crypto";

import { AIProviderError } from "../brain/ai-provider";
import type { CoreUpdate } from "../core/core-update-hub";
import {
  CoreUpdateReplayCursorNotFoundError,
  type CoreUpdateReplaySource,
} from "../core/core-update-replay";
import { ConversationNotFoundError } from "../memory/memory-repository";
import type { ShivaChatService } from "../services/chat-service";
import {
  encodeVoiceAudioFrame,
  VOICE_AUDIO_FRAME_HEADER_BYTES,
  type VoiceAudioFormat,
} from "./audio-frame";
import {
  captureFilename,
  DEFAULT_CAPTURE_MIME_TYPE,
  normalizeCaptureMimeType,
} from "./audio-upload";
import type { VoicePlaybackCoordinator } from "./playback-coordinator";
import {
  VoiceProviderError,
  type ASRProvider,
  type TTSProvider,
} from "./provider";
import {
  StreamingSpeechChunker,
  type StreamingSpeechChunkerOptions,
} from "./speech-chunker";
import {
  SpeechSynthesisQueue,
  type SpeechSynthesisQueueItem,
  type SpeechSynthesisQueuePhase,
  type SpeechSynthesisQueuePort,
} from "./speech-synthesis-queue";
import {
  parseClientVoiceMessage,
  VOICE_PROTOCOL_VERSION,
  type ClientVoiceMessage,
  type ServerVoiceMessage,
  type VoiceErrorCode,
  type VoiceTurnEndReason,
} from "./voice-protocol";
import type { VoicePerformanceTracker } from "./voice-performance";
import { parseWavPcm16, wavDurationMs } from "./wav-audio";

const DEFAULT_MAX_CAPTURED_AUDIO_BYTES = 25 * 1024 * 1024;
const MAX_TRACKED_TURN_IDS = 64;
const CORE_UPDATE_REPLAY_LIMIT = 100;

export interface VoiceSessionTransport {
  readonly isOpen: boolean;
  sendControl(message: ServerVoiceMessage): void;
  sendAudio(frame: Uint8Array): void;
  close(): void;
}

export interface VoiceSessionLogger {
  warn(payload: object, message: string): void;
  error(payload: object, message: string): void;
}

export interface VoiceCoreUpdateSource {
  subscribe(listener: (update: CoreUpdate) => void): () => void;
  readonly replay?: CoreUpdateReplaySource;
}

export interface VoiceSessionOptions {
  readonly transport: VoiceSessionTransport;
  readonly chatService: ShivaChatService;
  readonly asrProvider: ASRProvider;
  readonly ttsProvider: TTSProvider;
  readonly playbackCoordinator?: VoicePlaybackCoordinator;
  readonly performance?: VoicePerformanceTracker;
  readonly logger?: VoiceSessionLogger;
  readonly chunker?: StreamingSpeechChunkerOptions;
  readonly maxCapturedAudioBytes?: number;
  readonly createId?: () => string;
  readonly now?: () => number;
  readonly coreUpdates?: VoiceCoreUpdateSource;
}

interface VoiceCoreUpdateReplayState {
  buffering: boolean;
  readonly buffered: CoreUpdate[];
}

interface SpeechChunkJob extends SpeechSynthesisQueueItem {}

interface SynthesizedChunk {
  readonly format: VoiceAudioFormat;
  readonly sampleRate: number;
  readonly channels: number;
  readonly audio: Uint8Array;
  readonly durationMs: number | undefined;
}

interface AudioCapture {
  readonly mimeType: string;
  readonly chunks: Uint8Array[];
  bytes: number;
  closed: boolean;
}

type TurnStart =
  | { readonly kind: "text"; readonly text: string }
  | { readonly kind: "audio"; readonly mimeType: string };

class VoiceTurn {
  readonly abort = new AbortController();
  readonly chunker: InstanceType<typeof StreamingSpeechChunker>;
  readonly settledChunks = new Set<number>();
  queue!: SpeechSynthesisQueuePort<SpeechChunkJob>;
  capture: AudioCapture | null = null;
  nextChunkId = 0;
  pendingChunks = 0;
  deliveredChunks = 0;
  audioStartSent = false;
  ttsFailureReported = false;
  textDone = false;
  cancelled = false;
  finished = false;

  constructor(
    readonly turnId: string,
    readonly turnSequence: number,
    chunkerOptions: StreamingSpeechChunkerOptions | undefined,
  ) {
    this.chunker = new StreamingSpeechChunker(chunkerOptions ?? {});
  }
}

/**
 * Owns one browser voice connection end to end.
 *
 * Microphone bytes or typed text enter here, and the session drives ASR, the
 * shared `ShivaChatService`, the speech chunker, a strictly serial TTS worker,
 * and binary audio delivery. The browser never orchestrates any of it, so a
 * turn cannot be split across several HTTP requests.
 */
export class VoiceSession {
  private readonly sessionId: string;
  private readonly createId: () => string;
  private readonly now: () => number;
  private readonly maxCapturedAudioBytes: number;
  private readonly running = new Set<Promise<void>>();
  private readonly knownTurnIds = new Set<string>();
  private readonly openPlaybackTurns = new Set<string>();
  private conversationId: string | null = null;
  private activeTurn: VoiceTurn | null = null;
  private coreUpdateConversationId: string | null = null;
  private coreUpdateGeneration = 0;
  private coreUpdateUnsubscribe: (() => void) | null = null;
  private readonly deliveredCoreUpdateIds = new Set<string>();
  private turnSequence = 0;
  private started = false;
  private closed = false;

  constructor(private readonly options: VoiceSessionOptions) {
    this.createId = options.createId ?? randomUUID;
    this.now = options.now ?? (() => performance.now());
    this.maxCapturedAudioBytes =
      options.maxCapturedAudioBytes ?? DEFAULT_MAX_CAPTURED_AUDIO_BYTES;
    this.sessionId = this.createId();
  }

  handleTextMessage(raw: string): void {
    if (this.closed) {
      return;
    }
    const parsed = parseClientVoiceMessage(raw);
    if (!parsed.ok) {
      this.sendError("INVALID_MESSAGE", parsed.reason);
      return;
    }
    this.dispatch(parsed.message);
  }

  handleBinaryMessage(bytes: Uint8Array): void {
    if (this.closed) {
      return;
    }
    if (!this.requireSession()) {
      return;
    }

    const turn = this.activeTurn;
    const capture = turn?.capture;
    if (!turn || !capture || capture.closed) {
      this.sendError(
        "INVALID_AUDIO",
        "Send audio_start before streaming microphone audio.",
      );
      return;
    }
    if (bytes.byteLength === 0) {
      return;
    }

    capture.bytes += bytes.byteLength;
    if (capture.bytes > this.maxCapturedAudioBytes) {
      this.sendError(
        "INVALID_AUDIO",
        "The captured audio exceeded the supported size.",
        turn.turnId,
      );
      this.abandonTurn(turn, "error");
      return;
    }
    capture.chunks.push(bytes);
  }

  /** Resolves when no turn work is still in flight. */
  async whenSettled(): Promise<void> {
    while (this.running.size > 0) {
      await Promise.all([...this.running]);
    }
  }

  close(): void {
    if (this.closed) {
      return;
    }
    this.closed = true;
    const turn = this.activeTurn;
    if (turn && !turn.finished) {
      this.abandonTurn(turn, "interrupted");
    }
    for (const turnId of [...this.openPlaybackTurns]) {
      this.releasePlayback(turnId);
    }
    this.detachCoreUpdates();
  }

  private dispatch(message: ClientVoiceMessage): void {
    switch (message.type) {
      case "session_start":
        this.startSession(message.conversationId, message.afterMessageId);
        return;
      case "user_text":
        if (!this.requireSession()) return;
        this.beginTurn({ kind: "text", text: message.text.trim() });
        return;
      case "audio_start":
        if (!this.requireSession()) return;
        this.beginTurn({
          kind: "audio",
          mimeType: normalizeCaptureMimeType(message.mimeType),
        });
        return;
      case "audio_end":
        if (!this.requireSession()) return;
        this.finishCapture();
        return;
      case "interrupt": {
        const turn = this.activeTurn;
        if (turn && !turn.finished) {
          this.abandonTurn(turn, "interrupted");
        }
        return;
      }
      case "playback":
        this.recordPlayback(message);
        return;
      case "session_end":
        this.close();
        this.options.transport.close();
        return;
    }
  }

  /**
   * Starts or resumes the session. An omitted conversation ID deliberately
   * clears the current one so the browser's "New conversation" action needs no
   * extra message type, and a reconnect resumes by sending its stored ID.
   */
  private startSession(
    conversationId: string | undefined,
    afterMessageId: string | undefined,
  ): void {
    const activeTurn = this.activeTurn;
    if (activeTurn && !activeTurn.finished) {
      this.abandonTurn(activeTurn, "interrupted");
    }
    this.started = true;
    this.conversationId = conversationId ?? null;
    this.send({
      type: "session_ready",
      sessionId: this.sessionId,
      protocolVersion: VOICE_PROTOCOL_VERSION,
      conversationId: this.conversationId,
      preferredAudioFormat: "pcm16",
      audioFrameHeaderBytes: VOICE_AUDIO_FRAME_HEADER_BYTES,
    });
    this.activateCoreUpdates(this.conversationId, afterMessageId);
  }

  private requireSession(): boolean {
    if (this.started) {
      return true;
    }
    this.sendError(
      "SESSION_NOT_STARTED",
      "Send session_start before any voice turn.",
    );
    return false;
  }

  private beginTurn(input: TurnStart): void {
    const previous = this.activeTurn;
    if (previous && !previous.finished) {
      this.abandonTurn(previous, "interrupted");
    }

    this.turnSequence += 1;
    const turn = new VoiceTurn(
      this.createId(),
      this.turnSequence,
      this.options.chunker,
    );
    turn.queue = new SpeechSynthesisQueue<SpeechChunkJob, SynthesizedChunk>({
      worker: (job, signal) => this.synthesize(turn, job, signal),
      onReady: (job, chunk, signal) => {
        try {
          this.deliverAudio(turn, job, chunk, signal);
        } finally {
          this.settleChunk(turn, job.sequence);
        }
      },
      onError: (error, job, phase) => {
        this.settleChunk(turn, job.sequence);
        this.reportSynthesisFailure(turn, error, phase);
      },
    });
    this.activeTurn = turn;
    this.rememberTurn(turn.turnId);
    this.options.playbackCoordinator?.beginTurn(turn.turnId);

    if (input.kind === "audio") {
      turn.capture = {
        mimeType: input.mimeType,
        chunks: [],
        bytes: 0,
        closed: false,
      };
      this.options.performance?.beginAudioUpload(turn.turnId);
      return;
    }

    this.track(this.streamAssistantTurn(turn, input.text));
  }

  private finishCapture(): void {
    const turn = this.activeTurn;
    const capture = turn?.capture;
    if (!turn || !capture || capture.closed) {
      this.sendError("INVALID_AUDIO", "No microphone capture is in progress.");
      return;
    }

    capture.closed = true;
    this.options.performance?.markAudioUploaded(turn.turnId);
    if (capture.bytes === 0) {
      this.sendError(
        "INVALID_AUDIO",
        "No audio was captured for this turn.",
        turn.turnId,
      );
      this.abandonTurn(turn, "error");
      return;
    }

    this.track(this.transcribeAndRespond(turn, capture));
  }

  private async transcribeAndRespond(
    turn: VoiceTurn,
    capture: AudioCapture,
  ): Promise<void> {
    const audio = concatenate(capture.chunks, capture.bytes);
    const startedAt = this.now();
    let text: string;
    let language: string;
    try {
      const transcript = await this.options.asrProvider.transcribe({
        audio,
        contentType: capture.mimeType || DEFAULT_CAPTURE_MIME_TYPE,
        filename: captureFilename(capture.mimeType),
        signal: turn.abort.signal,
      });
      text = transcript.text.trim();
      language = transcript.language;
    } catch (error: unknown) {
      if (turn.cancelled) {
        return;
      }
      this.failTurn(turn, error);
      return;
    } finally {
      this.options.performance?.recordAsrDuration(
        turn.turnId,
        this.now() - startedAt,
      );
    }

    if (turn.cancelled) {
      return;
    }
    if (text.length === 0) {
      this.sendError(
        "INVALID_AUDIO",
        "No speech could be recognized in that recording.",
        turn.turnId,
      );
      this.abandonTurn(turn, "error");
      return;
    }

    this.send({
      type: "transcript_final",
      turnId: turn.turnId,
      text,
      language,
    });
    await this.streamAssistantTurn(turn, text);
  }

  private async streamAssistantTurn(
    turn: VoiceTurn,
    message: string,
  ): Promise<void> {
    try {
      this.options.performance?.markChatStarted(turn.turnId);
      const prepared = await this.options.chatService.startResponseTo(
        message,
        this.conversationId ?? undefined,
        turn.abort.signal,
        { mode: "voice" },
      );
      if (turn.cancelled || this.closed) return;
      this.conversationId = prepared.conversationId;
      if (this.coreUpdateConversationId !== prepared.conversationId) {
        this.activateCoreUpdates(prepared.conversationId, undefined);
      }

      let assistantText = "";
      let awaitingFirstToken = true;
      for await (const chunk of prepared.chunks) {
        if (turn.cancelled) {
          return;
        }
        if (awaitingFirstToken) {
          awaitingFirstToken = false;
          this.options.performance?.markChatFirstToken(turn.turnId);
        }
        if (chunk.content.length === 0) {
          continue;
        }
        assistantText += chunk.content;
        this.send({
          type: "assistant_text_delta",
          turnId: turn.turnId,
          text: chunk.content,
        });
        // Speech for the opening phrase starts here, while Gemma is still
        // generating the rest of the answer.
        this.queueSpeech(turn, turn.chunker.push(chunk.content));
      }

      if (turn.cancelled) {
        return;
      }
      this.queueSpeech(turn, turn.chunker.finish());
      this.send({
        type: "assistant_text_done",
        turnId: turn.turnId,
        text: assistantText,
      });
      turn.textDone = true;
      this.maybeCompleteTurn(turn);
    } catch (error: unknown) {
      if (turn.cancelled) {
        return;
      }
      this.failTurn(turn, error);
    }
  }

  private queueSpeech(turn: VoiceTurn, phrases: readonly string[]): void {
    for (const phrase of phrases) {
      const text = phrase.trim();
      if (turn.cancelled || text.length === 0) {
        continue;
      }
      const job: SpeechChunkJob = {
        sequence: turn.nextChunkId,
        text,
        textReadyAt: Date.now(),
      };
      turn.nextChunkId += 1;
      turn.pendingChunks += 1;
      this.options.performance?.markChunkQueued(turn.turnId, job.sequence, {
        textChars: text.length,
        textReadyAtUnixMs: job.textReadyAt,
      });
      if (!turn.queue.enqueue(job, turn.abort.signal)) {
        this.settleChunk(turn, job.sequence);
      }
    }
  }

  private async synthesize(
    turn: VoiceTurn,
    job: SpeechChunkJob,
    signal: AbortSignal,
  ): Promise<SynthesizedChunk> {
    const startedAt = this.options.performance?.markTtsStarted(
      turn.turnId,
      job.sequence,
    );
    const result = await this.options.ttsProvider.synthesize({
      text: job.text,
      signal,
    });
    const chunk = toSynthesizedChunk(result.audio);
    if (startedAt !== undefined) {
      this.options.performance?.finishTts(
        turn.turnId,
        job.sequence,
        startedAt,
        chunk.durationMs,
      );
    }
    return chunk;
  }

  private deliverAudio(
    turn: VoiceTurn,
    job: SpeechChunkJob,
    chunk: SynthesizedChunk,
    signal: AbortSignal,
  ): void {
    if (turn.cancelled || signal.aborted || !this.options.transport.isOpen) {
      return;
    }

    if (!turn.audioStartSent) {
      turn.audioStartSent = true;
      this.send({
        type: "audio_start",
        turnId: turn.turnId,
        turnSequence: turn.turnSequence,
        format: chunk.format,
        sampleRate: chunk.sampleRate,
        channels: chunk.channels,
      });
    }

    const frame = encodeVoiceAudioFrame(
      {
        format: chunk.format,
        channels: chunk.channels,
        sampleRate: chunk.sampleRate,
        turnSequence: turn.turnSequence,
        chunkId: job.sequence,
        audioDurationMs: chunk.durationMs ?? 0,
      },
      chunk.audio,
    );
    try {
      this.options.transport.sendAudio(frame);
    } catch (error: unknown) {
      this.options.logger?.warn(
        { err: error, turnId: turn.turnId, chunkId: job.sequence },
        "Voice audio frame could not be delivered",
      );
      return;
    }
    turn.deliveredChunks += 1;
    this.openPlaybackTurns.add(turn.turnId);
    this.options.performance?.markAudioSent(turn.turnId, job.sequence);
    this.options.playbackCoordinator?.markActive(turn.turnId);
  }

  private reportSynthesisFailure(
    turn: VoiceTurn,
    error: unknown,
    phase: SpeechSynthesisQueuePhase,
  ): void {
    if (turn.cancelled || isAbortError(error)) {
      return;
    }
    this.options.logger?.warn(
      { err: error, turnId: turn.turnId, phase },
      "Voice speech synthesis failed",
    );
    if (turn.ttsFailureReported) {
      return;
    }
    turn.ttsFailureReported = true;
    const classified = classifyVoiceFailure(error);
    this.sendError(classified.code, classified.message, turn.turnId);
  }

  private settleChunk(turn: VoiceTurn, chunkId: number): void {
    if (turn.settledChunks.has(chunkId)) {
      return;
    }
    turn.settledChunks.add(chunkId);
    turn.pendingChunks = Math.max(0, turn.pendingChunks - 1);
    this.maybeCompleteTurn(turn);
  }

  private maybeCompleteTurn(turn: VoiceTurn): void {
    if (
      turn.finished ||
      turn.cancelled ||
      !turn.textDone ||
      turn.pendingChunks > 0
    ) {
      return;
    }
    this.completeTurn(turn, turn.ttsFailureReported ? "error" : "completed");
  }

  private completeTurn(turn: VoiceTurn, reason: VoiceTurnEndReason): void {
    if (turn.finished) {
      return;
    }
    turn.finished = true;
    if (turn.audioStartSent) {
      this.send({
        type: "audio_end",
        turnId: turn.turnId,
        turnSequence: turn.turnSequence,
        chunkCount: turn.deliveredChunks,
      });
    }
    this.send({
      type: "turn_done",
      turnId: turn.turnId,
      turnSequence: turn.turnSequence,
      conversationId: this.conversationId,
      reason,
    });
    this.options.performance?.finishTurn(turn.turnId);
    if (this.activeTurn === turn) {
      this.activeTurn = null;
    }
    // Without delivered audio the browser will never report playback idle, so
    // the deferred-memory gate has to be released here instead.
    if (turn.deliveredChunks === 0 || !this.options.transport.isOpen) {
      this.releasePlayback(turn.turnId);
    }
  }

  /** Cancels a turn's generation, synthesis, and queued audio immediately. */
  private abandonTurn(turn: VoiceTurn, reason: VoiceTurnEndReason): void {
    turn.cancelled = true;
    turn.pendingChunks = 0;
    if (turn.capture) {
      turn.capture.closed = true;
      turn.capture.chunks.length = 0;
    }
    turn.abort.abort();
    turn.queue.cancel();
    if (turn.finished) {
      return;
    }
    turn.finished = true;
    this.send({
      type: "turn_done",
      turnId: turn.turnId,
      turnSequence: turn.turnSequence,
      conversationId: this.conversationId,
      reason,
    });
    this.options.performance?.finishTurn(turn.turnId);
    if (this.activeTurn === turn) {
      this.activeTurn = null;
    }
    this.releasePlayback(turn.turnId);
  }

  private failTurn(turn: VoiceTurn, error: unknown): void {
    if (error instanceof ConversationNotFoundError) {
      this.conversationId = null;
      this.activateCoreUpdates(null, undefined);
    }
    const classified = classifyVoiceFailure(error);
    if (classified.code === "INTERNAL_ERROR") {
      this.options.logger?.error(
        { err: error, turnId: turn.turnId },
        "Voice turn failed",
      );
    } else {
      this.options.logger?.warn(
        { err: error, turnId: turn.turnId, voiceErrorCode: classified.code },
        "Voice turn could not be completed",
      );
    }
    this.sendError(classified.code, classified.message, turn.turnId);
    turn.queue.cancel();
    turn.pendingChunks = 0;
    turn.textDone = true;
    this.completeTurn(turn, "error");
  }

  private recordPlayback(
    message: Extract<ClientVoiceMessage, { type: "playback" }>,
  ): void {
    if (!this.knownTurnIds.has(message.turnId)) {
      return;
    }
    if (message.event === "idle") {
      this.releasePlayback(message.turnId);
      return;
    }

    this.options.playbackCoordinator?.markActive(message.turnId);
    this.options.performance?.recordPlaybackEvent(
      message.turnId,
      message.chunkId ?? 0,
      message.event,
      message.timestampMs ?? Date.now(),
      {
        ...(message.decodeDurationMs !== undefined
          ? { decodeDurationMs: message.decodeDurationMs }
          : {}),
        ...(message.underrunMs !== undefined
          ? { underrunMs: message.underrunMs }
          : {}),
      },
    );
    if (message.event === "underrun") {
      this.options.logger?.warn(
        {
          turnId: message.turnId,
          chunkId: message.chunkId,
          underrunMs: message.underrunMs,
        },
        "Browser voice playback queue underran",
      );
    }
  }

  private releasePlayback(turnId: string): void {
    this.openPlaybackTurns.delete(turnId);
    this.options.playbackCoordinator?.markIdle(turnId);
    this.options.performance?.finishPlaybackTurn(turnId);
  }

  private rememberTurn(turnId: string): void {
    this.knownTurnIds.add(turnId);
    while (this.knownTurnIds.size > MAX_TRACKED_TURN_IDS) {
      const oldest = this.knownTurnIds.values().next().value as
        | string
        | undefined;
      if (oldest === undefined) {
        break;
      }
      this.knownTurnIds.delete(oldest);
    }
  }

  private track(work: Promise<void>): void {
    const tracked = work.catch((error: unknown) => {
      this.options.logger?.error({ err: error }, "Voice session task failed");
    });
    this.running.add(tracked);
    void tracked.finally(() => {
      this.running.delete(tracked);
    });
  }

  private sendError(
    code: VoiceErrorCode,
    message: string,
    turnId?: string,
  ): void {
    this.send({
      type: "error",
      code,
      message,
      ...(turnId !== undefined ? { turnId } : {}),
    });
  }

  private send(message: ServerVoiceMessage): boolean {
    if (!this.options.transport.isOpen) {
      return false;
    }
    try {
      this.options.transport.sendControl(message);
      return true;
    } catch (error: unknown) {
      this.options.logger?.warn(
        { err: error, voiceMessageType: message.type },
        "Voice control message could not be delivered",
      );
      return false;
    }
  }

  private activateCoreUpdates(
    conversationId: string | null,
    afterMessageId: string | undefined,
  ): void {
    const source = this.options.coreUpdates;
    this.detachCoreUpdates();
    if (this.coreUpdateConversationId !== conversationId) {
      this.deliveredCoreUpdateIds.clear();
    }
    this.coreUpdateConversationId = conversationId;
    if (!source || !conversationId || this.closed) return;

    const generation = this.coreUpdateGeneration;
    const replayState: VoiceCoreUpdateReplayState = {
      buffering: source.replay !== undefined,
      buffered: [],
    };
    try {
      this.coreUpdateUnsubscribe = source.subscribe((update) => {
        if (
          this.closed ||
          generation !== this.coreUpdateGeneration ||
          update.conversationId !== conversationId
        ) {
          return;
        }
        if (replayState.buffering) {
          replayState.buffered.push(update);
        } else {
          this.deliverCoreUpdate(update);
        }
      });
    } catch (error: unknown) {
      this.options.logger?.warn(
        { err: error, conversationId },
        "Voice Core update subscription failed",
      );
    }

    if (!source.replay) {
      replayState.buffering = false;
      return;
    }
    this.track(
      this.replayCoreUpdates(
        source.replay,
        conversationId,
        afterMessageId,
        generation,
        replayState,
      ),
    );
  }

  private detachCoreUpdates(): void {
    this.coreUpdateGeneration += 1;
    const unsubscribe = this.coreUpdateUnsubscribe;
    this.coreUpdateUnsubscribe = null;
    try {
      unsubscribe?.();
    } catch (error: unknown) {
      this.options.logger?.warn(
        { err: error },
        "Voice Core update subscription could not be detached",
      );
    }
  }

  private async replayCoreUpdates(
    replay: CoreUpdateReplaySource,
    conversationId: string,
    afterMessageId: string | undefined,
    generation: number,
    state: VoiceCoreUpdateReplayState,
  ): Promise<void> {
    let persisted: readonly CoreUpdate[] = [];
    try {
      persisted = await listCoreUpdateBacklog(
        replay,
        conversationId,
        afterMessageId,
      );
    } catch (error: unknown) {
      if (error instanceof CoreUpdateReplayCursorNotFoundError) {
        try {
          persisted = await listCoreUpdateBacklog(
            replay,
            conversationId,
            undefined,
          );
        } catch (fallbackError: unknown) {
          this.logCoreUpdateReplayFailure(fallbackError, conversationId);
        }
      } else {
        this.logCoreUpdateReplayFailure(error, conversationId);
      }
    }

    if (
      this.closed ||
      generation !== this.coreUpdateGeneration ||
      this.coreUpdateConversationId !== conversationId
    ) {
      state.buffered.length = 0;
      return;
    }
    const pending = deduplicatedChronologicalCoreUpdates([
      ...persisted,
      ...state.buffered,
    ]);
    state.buffered.length = 0;
    state.buffering = false;
    for (const update of pending) this.deliverCoreUpdate(update);
  }

  private deliverCoreUpdate(update: CoreUpdate): void {
    if (
      update.conversationId !== this.conversationId ||
      this.deliveredCoreUpdateIds.has(update.messageId)
    ) {
      return;
    }
    if (
      this.send({
        type: "core_update",
        messageId: update.messageId,
        conversationId: update.conversationId,
        message: update.message,
        timestamp: update.timestamp,
      })
    ) {
      this.deliveredCoreUpdateIds.add(update.messageId);
    }
  }

  private logCoreUpdateReplayFailure(
    error: unknown,
    conversationId: string,
  ): void {
    this.options.logger?.warn(
      { err: error, conversationId },
      "Voice Core update replay failed; live delivery remains active",
    );
  }
}

async function listCoreUpdateBacklog(
  replay: CoreUpdateReplaySource,
  conversationId: string,
  afterMessageId: string | undefined,
): Promise<readonly CoreUpdate[]> {
  const updates: CoreUpdate[] = [];
  let cursor = afterMessageId;
  while (true) {
    const page = await replay.listAfter(
      conversationId,
      cursor,
      CORE_UPDATE_REPLAY_LIMIT,
    );
    updates.push(...page);
    if (page.length < CORE_UPDATE_REPLAY_LIMIT) return updates;
    const nextCursor = page.at(-1)?.messageId;
    if (!nextCursor || nextCursor === cursor) return updates;
    cursor = nextCursor;
  }
}

function deduplicatedChronologicalCoreUpdates(
  updates: readonly CoreUpdate[],
): readonly CoreUpdate[] {
  const byId = new Map(updates.map((update) => [update.messageId, update]));
  return [...byId.values()].sort((left, right) => {
    const timestampDifference =
      Date.parse(left.timestamp) - Date.parse(right.timestamp);
    return timestampDifference || left.messageId.localeCompare(right.messageId);
  });
}

function toSynthesizedChunk(audio: Uint8Array): SynthesizedChunk {
  const pcm = parseWavPcm16(audio);
  if (pcm) {
    return {
      format: "pcm16",
      sampleRate: pcm.sampleRate,
      channels: pcm.channels,
      audio: pcm.samples,
      durationMs: pcm.durationMs,
    };
  }

  return {
    format: "wav",
    sampleRate: 0,
    channels: 0,
    audio,
    durationMs: wavDurationMs(audio),
  };
}

function concatenate(chunks: readonly Uint8Array[], bytes: number): Uint8Array {
  const combined = new Uint8Array(bytes);
  let offset = 0;
  for (const chunk of chunks) {
    combined.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return combined;
}

function isAbortError(error: unknown): boolean {
  if (error instanceof VoiceProviderError) {
    return error.failure === "CANCELLED";
  }
  if (error instanceof AIProviderError) {
    return error.failure === "CANCELLED";
  }
  return (
    error instanceof Error &&
    (error.name === "AbortError" || error.name === "TimeoutError")
  );
}

function classifyVoiceFailure(error: unknown): {
  readonly code: VoiceErrorCode;
  readonly message: string;
} {
  if (error instanceof VoiceProviderError) {
    if (error.service === "asr" && error.failure === "INVALID_AUDIO") {
      return {
        code: "INVALID_AUDIO",
        message: "That recording could not be transcribed.",
      };
    }
    return error.service === "asr"
      ? {
          code: "ASR_UNAVAILABLE",
          message: "Shiva's transcription service is currently unavailable.",
        }
      : {
          code: "TTS_UNAVAILABLE",
          message: "Shiva's speech service is currently unavailable.",
        };
  }

  if (error instanceof ConversationNotFoundError) {
    return {
      code: "CONVERSATION_NOT_FOUND",
      message: "That conversation no longer exists.",
    };
  }

  if (error instanceof AIProviderError) {
    return {
      code: "MODEL_UNAVAILABLE",
      message: "Shiva's local model is currently unavailable.",
    };
  }

  return {
    code: "INTERNAL_ERROR",
    message: "Shiva could not complete that voice turn.",
  };
}
