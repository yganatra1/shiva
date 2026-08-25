import assert from "node:assert/strict";
import { test } from "node:test";

import { BedrockProvider } from "../src/brain/bedrock-provider.js";
import { createChatProvider } from "../src/brain/chat-provider-factory.js";
import { GeminiProvider } from "../src/brain/gemini-provider.js";
import { OllamaProvider } from "../src/brain/ollama-provider.js";
import { OpenAiProvider } from "../src/brain/openai-provider.js";

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

test("brainProvider selects the OpenAI provider", () => {
  const provider = createChatProvider({
    ...baseConfig,
    brainProvider: "openai",
    openaiApiKey: "test-key",
  });
  assert.ok(provider instanceof OpenAiProvider);
});

test("openai without an API key fails fast instead of constructing a broken provider", () => {
  assert.throws(
    () => createChatProvider({ ...baseConfig, brainProvider: "openai" }),
    /OPENAI_API_KEY/,
  );
});

test("brainProvider selects the Bedrock provider", () => {
  const provider = createChatProvider({
    ...baseConfig,
    brainProvider: "bedrock",
    awsAccessKeyId: "test-access-key",
    awsSecretAccessKey: "test-secret-key",
  });
  assert.ok(provider instanceof BedrockProvider);
});

test("bedrock without AWS credentials fails fast instead of constructing a broken provider", () => {
  assert.throws(
    () => createChatProvider({ ...baseConfig, brainProvider: "bedrock" }),
    /AWS_BEARER_TOKEN_BEDROCK/,
  );
  assert.throws(
    () =>
      createChatProvider({
        ...baseConfig,
        brainProvider: "bedrock",
        awsAccessKeyId: "test-access-key",
      }),
    /AWS_BEARER_TOKEN_BEDROCK/,
  );
});

test("brainProvider selects Bedrock with only a bearer token, preferring it over IAM keys when both are set", () => {
  const bearerOnly = createChatProvider({
    ...baseConfig,
    brainProvider: "bedrock",
    awsBearerTokenBedrock: "test-bearer-token",
  });
  assert.ok(bearerOnly instanceof BedrockProvider);

  const bothSet = createChatProvider({
    ...baseConfig,
    brainProvider: "bedrock",
    awsBearerTokenBedrock: "test-bearer-token",
    awsAccessKeyId: "test-access-key",
    awsSecretAccessKey: "test-secret-key",
  });
  assert.ok(bothSet instanceof BedrockProvider);
});
