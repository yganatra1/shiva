import assert from "node:assert/strict";
import { test } from "node:test";

import { createApp } from "../src/app.js";
import type { AIProvider } from "../src/brain/ai-provider.js";
import { createTestOverrides, testConfig } from "./test-support.js";

test("incoming chat message is logged immediately after it is received", async (context) => {
  const provider: AIProvider = {
    async chat() {
      return { content: '{"memories":[]}' };
    },
    async *streamChat() {
      yield { content: "Noted." };
    },
  };
  const app = createApp(testConfig, createTestOverrides(provider));
  context.after(() => app.close());

  const loggedMessages: unknown[] = [];
  app.addHook("onRequest", async (request) => {
    const originalInfo = request.log.info.bind(request.log);
    request.log.info = ((...args: Parameters<typeof originalInfo>) => {
      const [payload] = args;
      if (payload && typeof payload === "object" && "message" in payload) {
        loggedMessages.push((payload as { message: unknown }).message);
      }
      return originalInfo(...args);
    }) as typeof request.log.info;
  });

  const response = await app.inject({
    method: "POST",
    url: "/chat",
    headers: { "content-type": "application/json" },
    payload: { message: "I love Yash" },
  });

  assert.equal(response.statusCode, 200);
  assert.ok(
    loggedMessages.includes("I love Yash"),
    `Expected the incoming message text to be logged, got: ${JSON.stringify(loggedMessages)}`,
  );
});

test("sensitive content in the message is redacted before it is logged", async (context) => {
  const provider: AIProvider = {
    async chat() {
      return { content: '{"memories":[]}' };
    },
    async *streamChat() {
      yield { content: "Noted." };
    },
  };
  const app = createApp(testConfig, createTestOverrides(provider));
  context.after(() => app.close());

  const loggedMessages: unknown[] = [];
  app.addHook("onRequest", async (request) => {
    const originalInfo = request.log.info.bind(request.log);
    request.log.info = ((...args: Parameters<typeof originalInfo>) => {
      const [payload] = args;
      if (payload && typeof payload === "object" && "message" in payload) {
        loggedMessages.push((payload as { message: unknown }).message);
      }
      return originalInfo(...args);
    }) as typeof request.log.info;
  });

  const secret = "hunter2supersecret";
  const response = await app.inject({
    method: "POST",
    url: "/chat",
    headers: { "content-type": "application/json" },
    payload: { message: `remember my password is ${secret}` },
  });

  assert.equal(response.statusCode, 200);
  const logged = loggedMessages.find(
    (entry) => typeof entry === "string",
  ) as string | undefined;
  assert.ok(logged, `Expected a logged message string, got: ${JSON.stringify(loggedMessages)}`);
  assert.ok(
    !logged.includes(secret),
    `Expected the password value to be redacted from the log, got: ${logged}`,
  );
  assert.ok(
    logged.includes("[REDACTED]"),
    `Expected the log entry to contain a redaction marker, got: ${logged}`,
  );
});
