import assert from "node:assert/strict";
import { test } from "node:test";

import { createChatProvider } from "../src/brain/chat-provider-factory.js";
import { GeminiProvider } from "../src/brain/gemini-provider.js";
import { OllamaProvider } from "../src/brain/ollama-provider.js";

const baseConfig = {
  model: "test-model",
  ollamaUrl: "http://127.0.0.1:11434",
  contextLength: 16_384,
  keepAlive: "30m" as const,
  ollamaRequestTimeoutMs: 1_000,
};

test("brainProvider selects the Ollama provider", () => {
  const provider = createChatProvider({ ...baseConfig, brainProvider: "ollama" });
  assert.ok(provider instanceof OllamaProvider);
});

test("brainProvider selects the Gemini provider", () => {
  const provider = createChatProvider({
    ...baseConfig,
    brainProvider: "gemini",
    geminiApiKey: "test-key",
  });
  assert.ok(provider instanceof GeminiProvider);
});

test("gemini without an API key fails fast instead of constructing a broken provider", () => {
  assert.throws(
    () => createChatProvider({ ...baseConfig, brainProvider: "gemini" }),
    /GEMINI_API_KEY/,
  );
});
