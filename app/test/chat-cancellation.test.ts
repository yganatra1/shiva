import assert from "node:assert/strict";
import { request as httpRequest } from "node:http";
import type { AddressInfo } from "node:net";
import { test } from "node:test";

import { createApp } from "../src/app.js";
import {
  AIProviderError,
  type AIProvider,
  type ChatInput,
} from "../src/brain/ai-provider.js";
import { createTestOverrides, testConfig } from "./test-support.js";

test("a normal POST streams chunks without cancelling inference", async (context) => {
  let releaseRemainingChunk = (): void => undefined;
  const remainingChunkReady = new Promise<void>((resolve) => {
    releaseRemainingChunk = resolve;
  });
  let cancellationCount = 0;

  const provider: AIProvider = {
    async chat() {
      throw new Error("The streaming route must not call chat().");
    },
    streamChat: (input) =>
      controlledStream(input, remainingChunkReady, () => {
        cancellationCount += 1;
      }),
  };
  const app = createApp(testConfig, createTestOverrides(provider));
  context.after(() => app.close());

  const baseUrl = await listenOnRandomPort(app);
  const response = await fetch(`${baseUrl}/chat`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ message: "Who are you?" }),
  });

  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type") ?? "", /^text\/plain/);
  assert.ok(response.body);

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  const firstRead = await withTimeout(
    reader.read(),
    1_000,
    "The first streamed chunk did not arrive.",
  );
  assert.equal(firstRead.done, false);
  assert.equal(decoder.decode(firstRead.value, { stream: true }), "Mock ");

  releaseRemainingChunk();
  let remainingText = "";
  while (true) {
    const read = await reader.read();
    if (read.done) {
      remainingText += decoder.decode();
      break;
    }
    remainingText += decoder.decode(read.value, { stream: true });
  }

  assert.equal(remainingText, "Shiva response");
  assert.equal(cancellationCount, 0);
});

test("a genuine client disconnect aborts streaming inference", async (context) => {
  let markStarted: (() => void) | undefined;
  let markCancelled: (() => void) | undefined;
  const started = new Promise<void>((resolve) => {
    markStarted = resolve;
  });
  const cancelled = new Promise<void>((resolve) => {
    markCancelled = resolve;
  });

  const provider: AIProvider = {
    async chat() {
      throw new Error("The streaming route must not call chat().");
    },
    async *streamChat(input) {
      markStarted?.();

      await new Promise<void>((_resolve, reject) => {
        const cancel = (): void => {
          markCancelled?.();
          reject(
            new AIProviderError("CANCELLED", "Test client disconnected."),
          );
        };

        if (input.signal?.aborted) {
          cancel();
          return;
        }

        input.signal?.addEventListener("abort", cancel, { once: true });
      });
    },
  };
  const app = createApp(testConfig, createTestOverrides(provider));
  context.after(() => app.close());

  const baseUrl = new URL(await listenOnRandomPort(app));
  const clientRequest = httpRequest({
    host: baseUrl.hostname,
    port: baseUrl.port,
    path: "/chat",
    method: "POST",
    headers: { "content-type": "application/json" },
  });
  clientRequest.on("error", () => undefined);
  clientRequest.end(JSON.stringify({ message: "Who are you?" }));

  await withTimeout(started, 1_000, "The provider did not start.");
  clientRequest.destroy();
  await withTimeout(cancelled, 1_000, "The provider was not cancelled.");
});

test("a provider failure before the first chunk keeps the JSON error envelope", async (context) => {
  const provider: AIProvider = {
    async chat() {
      throw new Error("The streaming route must not call chat().");
    },
    async *streamChat() {
      throw new AIProviderError("UNAVAILABLE", "Test provider unavailable.");
    },
  };
  const app = createApp(testConfig, createTestOverrides(provider));
  context.after(() => app.close());

  const response = await fetch(`${await listenOnRandomPort(app)}/chat`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ message: "Who are you?" }),
  });

  assert.equal(response.status, 503);
  assert.match(response.headers.get("content-type") ?? "", /^application\/json/);
  assert.deepEqual(await response.json(), {
    error: {
      code: "MODEL_UNAVAILABLE",
      message: "Shiva's local model is currently unavailable.",
    },
  });
});

async function* controlledStream(
  input: ChatInput,
  remainingChunkReady: Promise<void>,
  onCancel: () => void,
): AsyncIterable<{ readonly content: string }> {
  if (input.signal?.aborted) {
    onCancel();
    throw new AIProviderError("CANCELLED", "Test request cancelled.");
  }

  let rejectCancellation: ((error: AIProviderError) => void) | undefined;
  const cancellation = new Promise<never>((_resolve, reject) => {
    rejectCancellation = reject;
  });
  const abort = (): void => {
    onCancel();
    rejectCancellation?.(
      new AIProviderError("CANCELLED", "Test request cancelled."),
    );
  };
  input.signal?.addEventListener("abort", abort, { once: true });

  try {
    yield { content: "Mock " };
    await Promise.race([remainingChunkReady, cancellation]);
    yield { content: "Shiva response" };
  } finally {
    input.signal?.removeEventListener("abort", abort);
  }
}

async function listenOnRandomPort(
  app: ReturnType<typeof createApp>,
): Promise<string> {
  await app.listen({ host: "127.0.0.1", port: 0 });
  const address = app.server.address() as AddressInfo;
  return `http://127.0.0.1:${address.port}`;
}

async function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  message: string,
): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error(message)), timeoutMs);
  });

  try {
    return await Promise.race([promise, timeout]);
  } finally {
    if (timer) {
      clearTimeout(timer);
    }
  }
}
