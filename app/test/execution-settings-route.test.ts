import assert from "node:assert/strict";
import { test } from "node:test";

import { createApp } from "../src/app.js";
import type { AIProvider } from "../src/brain/ai-provider.js";
import type { ExecutionStatusPort } from "../src/security/execution-status.js";
import { createTestOverrides, testConfig } from "./test-support.js";

const provider: AIProvider = {
  async chat() {
    return { content: '{"memories":[]}' };
  },
  async *streamChat() {
    yield { content: "unused" };
  },
};

test("execution settings endpoint exposes safe current state and pending summary", async (context) => {
  const seenConversationIds: (string | undefined)[] = [];
  const executionStatus: ExecutionStatusPort = {
    async getStatus(conversationId) {
      seenConversationIds.push(conversationId);
      return {
        executionMode: "FULL_ACCESS",
        maxExecutionMode: "FULL_ACCESS",
        effectiveExecutionMode: "FULL_ACCESS",
        lockdown: false,
        updatedAt: "2026-08-22T10:00:00.000Z",
        updatedBy: testConfig.userId,
        pendingConfirmation: {
          id: "10000000-0000-4000-8000-000000000001",
          conversationId: "20000000-0000-4000-8000-000000000002",
          skill: "dangerous_example",
          sanitizedArguments: { token: "[REDACTED]" },
          reason: "This permanently removes the example.",
          expiresAt: "2026-08-22T10:05:00.000Z",
        },
      };
    },
  };
  const app = createApp(testConfig, {
    ...createTestOverrides(provider),
    executionStatus,
  });
  context.after(() => app.close());

  const response = await app.inject({
    method: "GET",
    url: "/settings/execution?conversationId=20000000-0000-4000-8000-000000000002",
  });

  assert.equal(response.statusCode, 200);
  assert.equal(response.headers["cache-control"], "no-store");
  assert.deepEqual(response.json(), await executionStatus.getStatus(
    "20000000-0000-4000-8000-000000000002",
  ));
  assert.deepEqual(seenConversationIds, [
    "20000000-0000-4000-8000-000000000002",
    "20000000-0000-4000-8000-000000000002",
  ]);
  assert.equal(response.body.includes("private-key-value"), false);
});

test("execution settings endpoint rejects an invalid conversation id", async (context) => {
  const app = createApp(testConfig, {
    ...createTestOverrides(provider),
    executionStatus: {
      async getStatus() {
        throw new Error("Invalid queries must not reach the status service.");
      },
    },
  });
  context.after(() => app.close());

  const response = await app.inject({
    method: "GET",
    url: "/settings/execution?conversationId=invalid",
  });

  assert.equal(response.statusCode, 400);
  assert.equal(response.json().error.code, "INVALID_REQUEST");
});
