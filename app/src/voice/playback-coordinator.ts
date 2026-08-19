export const DEFAULT_VOICE_PLAYBACK_IDLE_TIMEOUT_MS = 120_000;

export type VoicePlaybackWaitOutcome = "idle" | "timeout" | "closed";

interface VoicePlaybackWaiter {
  readonly resolve: (outcome: VoicePlaybackWaitOutcome) => void;
  readonly timeout: NodeJS.Timeout;
}

interface VoicePlaybackTurn {
  active: boolean;
  lastActivityAt: number;
  readonly waiters: Set<VoicePlaybackWaiter>;
}

const TURN_RETENTION_MS = 10 * 60 * 1_000;
const MAX_TRACKED_TURNS = 1_000;

/**
 * Coordinates browser playback with deferred background work.
 *
 * This intentionally does not try to infer idleness from individual chunk-end
 * events: a later chunk may still be synthesizing. The browser owns the audio
 * queue and is therefore the only component that can accurately declare the
 * whole turn idle.
 */
export class VoicePlaybackCoordinator {
  private readonly turns = new Map<string, VoicePlaybackTurn>();
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
  }

  markActive(turnId: string): void {
    if (this.closed) {
      return;
    }
    const now = this.now();
    const existing = this.turns.get(turnId);
    if (existing) {
      // An idle event is terminal for a turn. Ignore telemetry that arrives
      // out of order after it instead of re-blocking background work.
      if (!existing.active) {
        return;
      }
      existing.lastActivityAt = now;
      return;
    }

    const turn = this.ensureTurn(turnId, now);
    turn.active = true;
    turn.lastActivityAt = now;
  }

  markIdle(turnId: string): void {
    if (this.closed) {
      return;
    }
    const now = this.now();
    const turn = this.ensureTurn(turnId, now);
    turn.active = false;
    turn.lastActivityAt = now;
    this.resolveWaiters(turn, "idle");
  }

  async waitUntilIdle(turnId: string): Promise<VoicePlaybackWaitOutcome> {
    if (this.closed) {
      return "closed";
    }

    const turn = this.turns.get(turnId);
    if (!turn || !turn.active) {
      return "idle";
    }

    return new Promise<VoicePlaybackWaitOutcome>((resolve) => {
      let waiter: VoicePlaybackWaiter;
      const timeout = setTimeout(() => {
        turn.waiters.delete(waiter);
        resolve("timeout");
      }, this.idleTimeoutMs);
      waiter = {
        resolve,
        timeout,
      };
      turn.waiters.add(waiter);
    });
  }

  close(): void {
    if (this.closed) {
      return;
    }
    this.closed = true;
    for (const turn of this.turns.values()) {
      this.resolveWaiters(turn, "closed");
    }
    this.turns.clear();
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
      waiters: new Set(),
    };
    this.turns.set(turnId, created);
    return created;
  }

  private resolveWaiters(
    turn: VoicePlaybackTurn,
    outcome: VoicePlaybackWaitOutcome,
  ): void {
    for (const waiter of turn.waiters) {
      clearTimeout(waiter.timeout);
      waiter.resolve(outcome);
    }
    turn.waiters.clear();
  }

  private prune(now: number): void {
    for (const [turnId, turn] of this.turns) {
      if (now - turn.lastActivityAt > TURN_RETENTION_MS) {
        this.resolveWaiters(turn, "timeout");
        this.turns.delete(turnId);
      }
    }

    while (this.turns.size >= MAX_TRACKED_TURNS) {
      const oldestTurnId = this.turns.keys().next().value as string | undefined;
      if (!oldestTurnId) {
        return;
      }
      const oldest = this.turns.get(oldestTurnId);
      if (oldest) {
        this.resolveWaiters(oldest, "timeout");
      }
      this.turns.delete(oldestTurnId);
    }
  }
}
