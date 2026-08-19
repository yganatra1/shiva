import assert from "node:assert/strict";
import { test } from "node:test";

import { createApp } from "../src/app.js";
import type { AIProvider } from "../src/brain/ai-provider.js";
import type {
  AsyncMemoryPerformanceLog,
  ChatPerformanceLog,
  ForegroundPerformanceLog,
} from "../src/observability/chat-performance.js";
import {
  createTestOverrides,
  FakeExtractionEngine,
  InMemoryRepository,
  testConfig,
} from "./test-support.js";

test("performance logs separate foreground timing from deferred memory extraction", async (context) => {
  let markExtractionStarted: (() => void) | undefined;
  let releaseExtraction: (() => void) | undefined;
  let markAsyncLogged: ((entry: AsyncMemoryPerformanceLog) => void) | undefined;
  const extractionStarted = new Promise<void>((resolve) => {
    markExtractionStarted = resolve;
  });
  const extractionRelease = new Promise<void>((resolve) => {
    releaseExtraction = resolve;
  });
  const asyncLogged = new Promise<AsyncMemoryPerformanceLog>((resolve) => {
    markAsyncLogged = resolve;
  });
  const performanceLogs: ChatPerformanceLog[] = [];

  class BlockingExtractionEngine extends FakeExtractionEngine {
    override async extract() {
      markExtractionStarted?.();
      await extractionRelease;
      return [];
    }
  }

  const provider: AIProvider = {
    async chat() {
      throw new Error("The fake extraction engine handles memory extraction.");
    },
    async *streamChat() {
      yield { content: "Earth is a planet." };
    },
  };
  const overrides = {
    ...createTestOverrides(
      provider,
      new InMemoryRepository(),
      undefined,
      new BlockingExtractionEngine(),
    ),
    performanceLogSink: (entry: ChatPerformanceLog) => {
      performanceLogs.push(entry);
      if (entry.kind === "async-memory") {
        markAsyncLogged?.(entry);
      }
    },
  };
  const app = createApp(
    { ...testConfig, performanceLogging: true },
    overrides,
  );
  context.after(async () => {
    releaseExtraction?.();
    await app.close();
  });

  const response = await withTimeout(
    app.inject({
      method: "POST",
      url: "/chat",
      headers: { "content-type": "application/json" },
      payload: { message: "What is Earth?" },
    }),
    1_000,
    "The foreground response waited for deferred memory extraction.",
  );

  assert.equal(response.statusCode, 200);
  assert.equal(response.body, "Earth is a planet.");
  await withTimeout(
    extractionStarted,
    1_000,
    "Deferred memory extraction was not scheduled.",
  );

  const foreground = performanceLogs.find(
    (entry): entry is ForegroundPerformanceLog => entry.kind === "foreground",
  );
  assert.ok(foreground);
  assert.equal(foreground.outcome, "success");
  for (const stage of [
    "resolve-user",
    "conversation",
    "save-message",
    "working-memory",
    "embedding",
    "memory-search",
    "ranking",
    "prompt-build",
    "pre-ollama",
    "ollama-ttft",
    "generation",
    "ollama-total",
    "save-assistant",
    "memory-schedule",
    "total-ttft",
    "total-request",
  ] as const) {
    assert.equal(typeof foreground.timingsMs[stage], "number", stage);
  }
  assert.equal(
    performanceLogs.some((entry) => entry.kind === "async-memory"),
    false,
  );

  releaseExtraction?.();
  const background = await withTimeout(
    asyncLogged,
    1_000,
    "The separate asynchronous memory timing was not logged.",
  );
  assert.equal(background.outcome, "success");
  assert.equal(background.conversationId, foreground.conversationId);
  assert.equal(typeof background.queueDelayMs, "number");
  assert.equal(typeof background.durationMs, "number");
  assert.equal(typeof background.totalSinceScheduledMs, "number");
});

test("performance logging is disabled by default", async (context) => {
  const performanceLogs: ChatPerformanceLog[] = [];
  const provider: AIProvider = {
    async chat() {
      return { content: '{"memories":[]}' };
    },
    async *streamChat() {
      yield { content: "Earth is a planet." };
    },
  };
  const app = createApp(testConfig, {
    ...createTestOverrides(provider),
    performanceLogSink: (entry) => performanceLogs.push(entry),
  });
  context.after(() => app.close());

  const response = await app.inject({
    method: "POST",
    url: "/chat",
    headers: { "content-type": "application/json" },
    payload: { message: "What is Earth?" },
  });
  assert.equal(response.statusCode, 200);
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.deepEqual(performanceLogs, []);
});

async function withTimeout<T>(
  operation: Promise<T>,
  timeoutMs: number,
  message: string,
): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error(message)), timeoutMs);
  });

  try {
    return await Promise.race([operation, timeout]);
  } finally {
    if (timer) {
      clearTimeout(timer);
    }
  }
}
