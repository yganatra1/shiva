export interface SpeechSynthesisQueueItem {
  readonly sequence: number;
  readonly text: string;
  readonly textReadyAt: number;
}

export type SpeechSynthesisQueuePhase = "synthesis" | "delivery";

export interface SpeechSynthesisQueueOptions<
  TItem extends SpeechSynthesisQueueItem,
  TResult,
> {
  readonly worker: (item: TItem, signal: AbortSignal) => Promise<TResult>;
  readonly onReady: (
    item: TItem,
    result: TResult,
    signal: AbortSignal,
  ) => void | Promise<void>;
  readonly onError?: (
    error: unknown,
    item: TItem,
    phase: SpeechSynthesisQueuePhase,
  ) => void;
  readonly onIdle?: () => void;
}

interface QueueEntry<TItem> {
  readonly item: TItem;
  readonly generation: number;
  readonly controller: AbortController;
  readonly externalSignal: AbortSignal | null;
  externalAbortListener: (() => void) | null;
  cleanedUp: boolean;
}

/**
 * Runs speech synthesis jobs one at a time while delivering completed audio on
 * a separate ordered chain. The class intentionally has no imported runtime
 * dependencies so its constructor can be embedded in the browser with
 * `SpeechSynthesisQueue.toString()`.
 */
export const SpeechSynthesisQueue = (() =>
  class<
    TItem extends SpeechSynthesisQueueItem,
    TResult,
  > {
  private readonly pending: Array<QueueEntry<TItem>> = [];
  private readonly liveEntries = new Set<QueueEntry<TItem>>();
  private active: QueueEntry<TItem> | null = null;
  private generation = 0;
  private deliveryTail: Promise<void> = Promise.resolve();
  private idleWaiters: Array<() => void> = [];
  private idleNotified = true;

  constructor(
    private readonly options: SpeechSynthesisQueueOptions<TItem, TResult>,
  ) {}

  /**
   * Enqueues a job in FIFO order. Returns false when its caller signal was
   * already aborted, otherwise true.
   */
  enqueue(item: TItem, signal?: AbortSignal): boolean {
    if (signal?.aborted) return false;

    const controller = new AbortController();
    const entry: QueueEntry<TItem> = {
      item,
      generation: this.generation,
      controller,
      externalSignal: signal ?? null,
      externalAbortListener: null,
      cleanedUp: false,
    };
    if (signal) {
      entry.externalAbortListener = this.forwardAbort.bind(this, entry);
      signal.addEventListener("abort", entry.externalAbortListener, {
        once: true,
      });
    }
    this.pending.push(entry);
    this.liveEntries.add(entry);
    this.idleNotified = false;
    this.pump();
    return true;
  }

  /**
   * Aborts the active job, drops pending jobs, and prevents already-completed
   * jobs from being delivered. A worker that ignores abort must still settle
   * before a job from the next generation is allowed to start.
   */
  cancel(reason?: unknown): void {
    this.generation += 1;

    for (const entry of this.liveEntries) {
      entry.controller.abort(reason);
    }
    for (const entry of this.pending) {
      this.cleanup(entry);
    }
    this.pending.length = 0;

    // A running delivery belongs to the cancelled generation. New results
    // must not wait behind it, while its own generation check/abort signal
    // still prevents stale work from being delivered later.
    this.deliveryTail = Promise.resolve();
    this.notifyIdleIfNeeded();
  }

  /** Returns true when no synthesis worker is active or waiting. */
  isIdle(): boolean {
    return this.active === null && this.pending.length === 0;
  }

  /**
   * Resolves when synthesis becomes idle. Playback/delivery is deliberately
   * excluded so synthesis can stay ahead of playback.
   */
  whenIdle(): Promise<void> {
    if (this.isIdle()) return Promise.resolve();
    return new Promise((resolve) => {
      this.idleWaiters.push(resolve);
    });
  }

  private pump(): void {
    if (this.active) return;

    while (this.pending.length > 0) {
      const entry = this.pending.shift();
      if (!entry) break;
      if (
        entry.generation !== this.generation ||
        entry.controller.signal.aborted
      ) {
        this.cleanup(entry);
        continue;
      }

      this.active = entry;
      void this.run(entry);
      return;
    }

    this.notifyIdleIfNeeded();
  }

  private async run(entry: QueueEntry<TItem>): Promise<void> {
    let handedToDelivery = false;
    try {
      const result = await this.options.worker(
        entry.item,
        entry.controller.signal,
      );
      if (
        entry.generation === this.generation &&
        !entry.controller.signal.aborted
      ) {
        handedToDelivery = true;
        this.queueDelivery(entry, result);
      }
    } catch (error) {
      if (
        entry.generation === this.generation &&
        !entry.controller.signal.aborted
      ) {
        this.reportError(error, entry.item, "synthesis");
      }
    } finally {
      if (!handedToDelivery) this.cleanup(entry);
      if (this.active === entry) this.active = null;
      this.pump();
    }
  }

  private queueDelivery(entry: QueueEntry<TItem>, result: TResult): void {
    const previousDelivery = this.deliveryTail;
    this.deliveryTail = previousDelivery.then(async () => {
      try {
        if (
          entry.generation !== this.generation ||
          entry.controller.signal.aborted
        ) {
          return;
        }
        await this.options.onReady(
          entry.item,
          result,
          entry.controller.signal,
        );
      } catch (error) {
        if (
          entry.generation === this.generation &&
          !entry.controller.signal.aborted
        ) {
          this.reportError(error, entry.item, "delivery");
        }
      } finally {
        this.cleanup(entry);
      }
    });
  }

  private cleanup(entry: QueueEntry<TItem>): void {
    if (entry.cleanedUp) return;
    entry.cleanedUp = true;
    if (entry.externalSignal && entry.externalAbortListener) {
      entry.externalSignal.removeEventListener(
        "abort",
        entry.externalAbortListener,
      );
    }
    this.liveEntries.delete(entry);
  }

  private forwardAbort(entry: QueueEntry<TItem>): void {
    entry.controller.abort(entry.externalSignal?.reason);
  }

  private reportError(
    error: unknown,
    item: TItem,
    phase: SpeechSynthesisQueuePhase,
  ): void {
    try {
      this.options.onError?.(error, item, phase);
    } catch {
      // Observer failures must never stall the synthesis queue.
    }
  }

  private notifyIdleIfNeeded(): void {
    if (!this.isIdle() || this.idleNotified) return;
    this.idleNotified = true;

    const waiters = this.idleWaiters;
    this.idleWaiters = [];
    for (const resolve of waiters) resolve();

    try {
      this.options.onIdle?.();
    } catch {
      // Observer failures must never change queue state.
    }
  }
  })();
