import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { test } from "node:test";

import {
  AIProviderError,
  type AIProviderFailure,
} from "../src/brain/ai-provider.js";
import { OllamaProvider } from "../src/brain/ollama-provider.js";

test("the provider distinguishes caller cancellation from its deadline", async (context) => {
  const upstream = createServer((request, response) => {
    request.resume();
    setTimeout(() => {
      if (!response.destroyed) {
        response.setHeader("content-type", "application/json");
        response.end(
          JSON.stringify({
            done: true,
            message: { content: "Delayed response" },
          }),
        );
      }
    }, 150);
  });
  context.after(
    () =>
      new Promise<void>((resolve, reject) => {
        upstream.close((error) => (error ? reject(error) : resolve()));
      }),
  );

  await new Promise<void>((resolve) =>
    upstream.listen(0, "127.0.0.1", resolve),
  );
  const address = upstream.address() as AddressInfo;
  const baseUrl = `http://127.0.0.1:${address.port}`;
  const messages = [{ role: "user" as const, content: "Hello" }];

  const callerController = new AbortController();
  const callerCancelledProvider = new OllamaProvider({
    baseUrl,
    model: "test-model",
    contextLength: 16_384,
    keepAlive: "30m",
    requestTimeoutMs: 1_000,
  });
  const callerCancelledRequest = callerCancelledProvider.chat({
    messages,
    signal: callerController.signal,
  });
  callerController.abort();
  await expectProviderFailure(callerCancelledRequest, "CANCELLED");

  const timedProvider = new OllamaProvider({
    baseUrl,
    model: "test-model",
    contextLength: 16_384,
    keepAlive: "30m",
    requestTimeoutMs: 25,
  });
  await expectProviderFailure(timedProvider.chat({ messages }), "TIMEOUT");
});

async function expectProviderFailure(
  request: Promise<unknown>,
  expectedFailure: AIProviderFailure,
): Promise<void> {
  await assert.rejects(
    request,
    (error: unknown) =>
      error instanceof AIProviderError && error.failure === expectedFailure,
  );
}
