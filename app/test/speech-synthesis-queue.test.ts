import assert from "node:assert/strict";
import { test } from "node:test";

import {
  SpeechSynthesisQueue,
  type SpeechSynthesisQueueItem,
  type SpeechSynthesisQueuePhase,
} from "../src/voice/speech-synthesis-queue.js";

interface TestItem extends SpeechSynthesisQueueItem {
  readonly turnId: string;
}

test("synthesizes one item at a time without waiting for playback delivery", async () => {
  const synthesis = [deferred<string>(), deferred<string>()];
  const firstDelivery = deferred<void>();
  const started: number[] = [];
  const delivered: number[] = [];
  let concurrentWorkers = 0;
  let maximumConcurrency = 0;

  const queue = new SpeechSynthesisQueue<TestItem, string>({
    worker: async (item) => {
      started.push(item.sequence);
      concurrentWorkers += 1;
      maximumConcurrency = Math.max(maximumConcurrency, concurrentWorkers);
      try {
        return await synthesis[item.sequence]!.promise;
      } finally {
        concurrentWorkers -= 1;
      }
    },
    onReady: async (item) => {
      delivered.push(item.sequence);
      if (item.sequence === 0) await firstDelivery.promise;
    },
  });

  queue.enqueue(item(0, "First."));
  queue.enqueue(item(1, "Second."));
  assert.deepEqual(started, [0]);

  synthesis[0]!.resolve("first.wav");
  await waitFor(() => started.length === 2 && delivered.length === 1);

  assert.deepEqual(started, [0, 1]);
  assert.deepEqual(delivered, [0]);
  assert.equal(maximumConcurrency, 1);

  synthesis[1]!.resolve("second.wav");
  await queue.whenIdle();

  // Synthesis is idle even though the first audio result is still being
  // delivered. This is what allows generation to remain ahead of playback.
  assert.deepEqual(delivered, [0]);
  firstDelivery.resolve();
  await waitFor(() => delivered.length === 2);
  assert.deepEqual(delivered, [0, 1]);
});

test("cancel aborts active work, drops queued work, and suppresses stale results", async () => {
  const staleWork = deferred<string>();
  const currentWork = deferred<string>();
  const started: number[] = [];
  const delivered: number[] = [];
  const workerSignals = new Map<number, AbortSignal>();
  let concurrentWorkers = 0;
  let maximumConcurrency = 0;

  const queue = new SpeechSynthesisQueue<TestItem, string>({
    worker: async (queuedItem, signal) => {
      started.push(queuedItem.sequence);
      workerSignals.set(queuedItem.sequence, signal);
      concurrentWorkers += 1;
      maximumConcurrency = Math.max(maximumConcurrency, concurrentWorkers);
      try {
        return await (queuedItem.sequence === 0
          ? staleWork.promise
          : currentWork.promise);
      } finally {
        concurrentWorkers -= 1;
      }
    },
    onReady: (queuedItem) => {
      delivered.push(queuedItem.sequence);
    },
  });

  queue.enqueue(item(0, "Stale active speech."));
  queue.enqueue(item(1, "Stale queued speech."));
  queue.cancel("new turn");

  assert.equal(workerSignals.get(0)?.aborted, true);
  queue.enqueue(item(2, "Current speech."));

  // A worker that ignores AbortSignal cannot cause a second GPU synthesis to
  // overlap it. The current turn waits until that stale worker settles.
  assert.deepEqual(started, [0]);
  staleWork.resolve("stale.wav");
  await waitFor(() => started.includes(2));
  assert.deepEqual(started, [0, 2]);
  assert.equal(started.includes(1), false);
  assert.deepEqual(delivered, []);

  currentWork.resolve("current.wav");
  await queue.whenIdle();
  await waitFor(() => delivered.length === 1);
  assert.deepEqual(delivered, [2]);
  assert.equal(maximumConcurrency, 1);
});

test("a caller AbortSignal cancels only its item and is forwarded to the worker", async () => {
  const cancelledWork = deferred<string>();
  const nextWork = deferred<string>();
  const caller = new AbortController();
  const alreadyCancelled = new AbortController();
  alreadyCancelled.abort();
  const started: number[] = [];
  const delivered: number[] = [];
  let activeSignal: AbortSignal | undefined;

  const queue = new SpeechSynthesisQueue<TestItem, string>({
    worker: async (queuedItem, signal) => {
      started.push(queuedItem.sequence);
      if (queuedItem.sequence === 0) activeSignal = signal;
      return await (queuedItem.sequence === 0
        ? cancelledWork.promise
        : nextWork.promise);
    },
    onReady: (queuedItem) => {
      delivered.push(queuedItem.sequence);
    },
  });

  assert.equal(queue.enqueue(item(0, "Cancel me."), caller.signal), true);
  assert.equal(
    queue.enqueue(item(99, "Never enqueue me."), alreadyCancelled.signal),
    false,
  );
  queue.enqueue(item(1, "Keep me."));
  caller.abort("caller stopped");

  assert.equal(activeSignal?.aborted, true);
  assert.equal(activeSignal?.reason, "caller stopped");
  cancelledWork.resolve("cancelled.wav");
  await waitFor(() => started.includes(1));
  nextWork.resolve("next.wav");
  await queue.whenIdle();
  await waitFor(() => delivered.length === 1);

  assert.deepEqual(started, [0, 1]);
  assert.deepEqual(delivered, [1]);
});

test("reports synthesis and delivery failures without stalling later jobs", async () => {
  const errors: Array<{ sequence: number; phase: SpeechSynthesisQueuePhase }> =
    [];
  const delivered: number[] = [];

  const queue = new SpeechSynthesisQueue<TestItem, string>({
    worker: async (queuedItem) => {
      if (queuedItem.sequence === 0) throw new Error("synthesis failed");
      return `${queuedItem.sequence}.wav`;
    },
    onReady: (queuedItem) => {
      delivered.push(queuedItem.sequence);
      if (queuedItem.sequence === 1) throw new Error("delivery failed");
    },
    onError: (_error, queuedItem, phase) => {
      errors.push({ sequence: queuedItem.sequence, phase });
    },
  });

  queue.enqueue(item(0, "Broken synthesis."));
  queue.enqueue(item(1, "Broken delivery."));
  queue.enqueue(item(2, "Healthy."));
  await queue.whenIdle();
  await waitFor(() => errors.length === 2 && delivered.length === 2);

  assert.deepEqual(errors, [
    { sequence: 0, phase: "synthesis" },
    { sequence: 1, phase: "delivery" },
  ]);
  assert.deepEqual(delivered, [1, 2]);
});

test("the class is self-contained when embedded through toString", async () => {
  const EmbeddedQueue = Function(
    `"use strict"; return (${SpeechSynthesisQueue.toString()});`,
  )() as typeof SpeechSynthesisQueue;
  const delivered: string[] = [];
  const queue = new EmbeddedQueue<TestItem, string>({
    worker: async (queuedItem) => `${queuedItem.text}.wav`,
    onReady: (_queuedItem, result) => {
      delivered.push(result);
    },
  });

  queue.enqueue(item(0, "Embedded"));
  await queue.whenIdle();
  await waitFor(() => delivered.length === 1);
  assert.deepEqual(delivered, ["Embedded.wav"]);
});

function item(sequence: number, text: string): TestItem {
  return {
    sequence,
    text,
    textReadyAt: 1_000 + sequence,
    turnId: "turn-1",
  };
}

function deferred<T>(): {
  readonly promise: Promise<T>;
  readonly resolve: (value?: T) => void;
} {
  let resolvePromise!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((resolve) => {
    resolvePromise = resolve;
  });
  return {
    promise,
    resolve: (value?: T) => {
      resolvePromise(value as T);
    },
  };
}

async function waitFor(condition: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    if (condition()) return;
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  assert.fail("Timed out waiting for asynchronous queue state.");
}
