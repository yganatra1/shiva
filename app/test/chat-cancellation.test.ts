import assert from "node:assert/strict";
import { request as httpRequest } from "node:http";
import type { AddressInfo } from "node:net";
import { test } from "node:test";

import { createApp } from "../src/app.js";
import {
  AIProviderError,
  type AIProvider,
  type ChatInput,
  type ChatResult,
} from "../src/brain/ai-provider.js";
import type { AppConfig } from "../src/config/environment.js";

const testConfig: AppConfig = {
  port: 3000,
  host: "127.0.0.1",
  ollamaUrl: "http://127.0.0.1:11434",
  model: "test-model",
  contextLength: 16_384,
  keepAlive: "30m",
  ollamaRequestTimeoutMs: 1_000,
  nodeEnv: "test",
};

test("a completed POST body does not cancel model inference", async (context) => {
  let cancellationCount = 0;
  const provider: AIProvider = {
    chat: (input) =>
      delayedResult(input, 100, () => {
        cancellationCount += 1;
      }),
  };
  const app = createApp(testConfig, provider);
  context.after(() => app.close());

  const baseUrl = await listenOnRandomPort(app);
  const response = await fetch(`${baseUrl}/chat`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ message: "Who are you?" }),
  });

  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { response: "Mock Shiva response" });
  assert.equal(cancellationCount, 0);
});

test("a genuine client disconnect aborts model inference", async (context) => {
  let markStarted: (() => void) | undefined;
  let markCancelled: (() => void) | undefined;
  const started = new Promise<void>((resolve) => {
    markStarted = resolve;
  });
  const cancelled = new Promise<void>((resolve) => {
    markCancelled = resolve;
  });

  const provider: AIProvider = {
    chat: (input) => {
      markStarted?.();

      return new Promise<ChatResult>((_resolve, reject) => {
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
  const app = createApp(testConfig, provider);
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

function delayedResult(
  input: ChatInput,
  delayMs: number,
  onCancel: () => void,
): Promise<ChatResult> {
  return new Promise((resolve, reject) => {
    const complete = (): void => {
      input.signal?.removeEventListener("abort", cancel);
      resolve({ content: "Mock Shiva response" });
    };
    const cancel = (): void => {
      clearTimeout(timer);
      onCancel();
      reject(new AIProviderError("CANCELLED", "Test request cancelled."));
    };
    const timer = setTimeout(complete, delayMs);

    if (input.signal?.aborted) {
      cancel();
      return;
    }

    input.signal?.addEventListener("abort", cancel, { once: true });
  });
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
