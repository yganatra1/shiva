export const DEFAULT_VOICE_PLAYBACK_IDLE_TIMEOUT_MS = 120_000;

export type VoicePlaybackWaitOutcome = "idle" | "timeout" | "closed";

interface VoicePlaybackWaiter {
  readonly resolve: (outcome: VoicePlaybackWaitOutcome) => void;
  timedOut: boolean;
}

interface VoicePlaybackTurn {
  active: boolean;
  lastActivityAt: number;
  timeout?: NodeJS.Timeout;
}

const TURN_RETENTION_MS = 10 * 60 * 1_000;
const MAX_TRACKED_TURNS = 1_000;

/**
 * Tracks the browser-owned playback lifecycle and exposes one global idle
 * barrier. Automatic memory jobs use the barrier so no extraction model can
 * contend with any active voice turn.
 */
export class VoicePlaybackCoordinator {
  private readonly turns = new Map<string, VoicePlaybackTurn>();
  private readonly waiters = new Set<VoicePlaybackWaiter>();
  private closed = false;

  constructor(
    private readonly idleTimeoutMs = DEFAULT_VOICE_PLAYBACK_IDLE_TIMEOUT_MS,
    private readonly now: () => number = () => performance.now(),
  ) {
    if (!Number.isFinite(idleTimeoutMs) || idleTimeoutMs <= 0) {
      throw new RangeError("Voice playback idle timeout must be positive.");
    }
  }

  beginTurn(turnId: string): void {
    if (this.closed) {
      return;
    }
    const now = this.now();
    const turn = this.ensureTurn(turnId, now);
    turn.active = true;
    turn.lastActivityAt = now;
    this.refreshTimeout(turnId, turn);
  }

  markActive(turnId: string): void {
    if (this.closed) {
      return;
    }
    const now = this.now();
    const existing = this.turns.get(turnId);
    if (existing) {
      // Idle and timeout are terminal for a turn. Late keepalive telemetry
      // must not re-block the global gate.
      if (!existing.active) {
        return;
      }
      existing.lastActivityAt = now;
      this.refreshTimeout(turnId, existing);
      return;
    }

    const turn = this.ensureTurn(turnId, now);
    turn.active = true;
    turn.lastActivityAt = now;
    this.refreshTimeout(turnId, turn);
  }

  markIdle(turnId: string): void {
    if (this.closed) {
      return;
    }
    const now = this.now();
    const turn = this.ensureTurn(turnId, now);
    this.retireTurn(turn, now);
    this.resolveWaitersIfIdle("idle");
  }

  waitUntilAllIdle(): Promise<VoicePlaybackWaitOutcome> {
    if (this.closed) {
      return Promise.resolve("closed");
    }
    if (!this.hasActiveTurns()) {
      return Promise.resolve("idle");
    }

    return new Promise<VoicePlaybackWaitOutcome>((resolve) => {
      this.waiters.add({ resolve, timedOut: false });
    });
  }

  isClosed(): boolean {
    return this.closed;
  }

  close(): void {
    if (this.closed) {
      return;
    }
    this.closed = true;
    for (const turn of this.turns.values()) {
      this.clearTurnTimeout(turn);
    }
    this.turns.clear();
    for (const waiter of this.waiters) {
      waiter.resolve("closed");
    }
    this.waiters.clear();
  }

  private ensureTurn(turnId: string, now: number): VoicePlaybackTurn {
    const existing = this.turns.get(turnId);
    if (existing) {
      return existing;
    }

    this.prune(now);
    const created: VoicePlaybackTurn = {
      active: false,
      lastActivityAt: now,
    };
    this.turns.set(turnId, created);
    return created;
  }

  private refreshTimeout(turnId: string, turn: VoicePlaybackTurn): void {
    this.clearTurnTimeout(turn);
    const timeout = setTimeout(() => {
      if (this.closed || this.turns.get(turnId) !== turn || !turn.active) {
        return;
      }
      const now = this.now();
      this.retireTurn(turn, now);
      for (const waiter of this.waiters) {
        waiter.timedOut = true;
      }
      this.resolveWaitersIfIdle("timeout");
    }, this.idleTimeoutMs);
    timeout.unref();
    turn.timeout = timeout;
  }

  private retireTurn(turn: VoicePlaybackTurn, now: number): void {
    this.clearTurnTimeout(turn);
    turn.active = false;
    turn.lastActivityAt = now;
  }

  private clearTurnTimeout(turn: VoicePlaybackTurn): void {
    if (!turn.timeout) {
      return;
    }
    clearTimeout(turn.timeout);
    delete turn.timeout;
  }

  private resolveWaitersIfIdle(
    defaultOutcome: Exclude<VoicePlaybackWaitOutcome, "closed">,
  ): void {
    if (this.hasActiveTurns()) {
      return;
    }
    for (const waiter of this.waiters) {
      waiter.resolve(waiter.timedOut ? "timeout" : defaultOutcome);
    }
    this.waiters.clear();
  }

  private hasActiveTurns(): boolean {
    for (const turn of this.turns.values()) {
      if (turn.active) {
        return true;
      }
    }
    return false;
  }

  private prune(now: number): void {
    let timedOutActiveTurn = false;
    for (const [turnId, turn] of this.turns) {
      if (now - turn.lastActivityAt <= TURN_RETENTION_MS) {
        continue;
      }
      timedOutActiveTurn ||= turn.active;
      this.clearTurnTimeout(turn);
      this.turns.delete(turnId);
    }

    while (this.turns.size >= MAX_TRACKED_TURNS) {
      const oldestTurnId = this.turns.keys().next().value as string | undefined;
      if (!oldestTurnId) {
        break;
      }
      const oldest = this.turns.get(oldestTurnId);
      if (oldest) {
        timedOutActiveTurn ||= oldest.active;
        this.clearTurnTimeout(oldest);
      }
      this.turns.delete(oldestTurnId);
    }

    if (timedOutActiveTurn) {
      for (const waiter of this.waiters) {
        waiter.timedOut = true;
      }
    }
  }
}
