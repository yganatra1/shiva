import assert from "node:assert/strict";
import { test } from "node:test";

import type { ShivaDatabase } from "../src/database/pool.js";
import {
  CoreUpdateReplayCursorNotFoundError,
  DrizzleCoreUpdateReplaySource,
} from "../src/core/core-update-replay.js";

const CONVERSATION_ID = "00000000-0000-4000-8000-000000000010";
const FIRST_ID = "00000000-0000-4000-8000-000000000011";
const SECOND_ID = "00000000-0000-4000-8000-000000000012";

test("a fresh Core replay source reloads finalized assistant messages from PostgreSQL", async () => {
  const first = assistantMessage(FIRST_ID, "First persisted update", 1);
  const second = assistantMessage(SECOND_ID, "Second persisted update", 2);
  const fake = scriptedSelectDatabase([[{ message: second }, { message: first }]]);
  // Constructing a fresh source models process restart: it has no in-memory
  // dependency on the processor that originally persisted these messages.
  const replay = new DrizzleCoreUpdateReplaySource(fake.database);

  const updates = await replay.listAfter(CONVERSATION_ID, undefined, 50);

  assert.deepEqual(updates, [
    {
      messageId: FIRST_ID,
      conversationId: CONVERSATION_ID,
      message: "First persisted update",
      timestamp: "2026-08-24T10:00:01.000Z",
    },
    {
      messageId: SECOND_ID,
      conversationId: CONVERSATION_ID,
      message: "Second persisted update",
      timestamp: "2026-08-24T10:00:02.000Z",
    },
  ]);
  assert.deepEqual(fake.limits, [50]);
});

test("durable replay resumes strictly after the correlated message cursor", async () => {
  const first = assistantMessage(FIRST_ID, "Already delivered", 1);
  const second = assistantMessage(SECOND_ID, "Not delivered yet", 1);
  const fake = scriptedSelectDatabase([
    [{ createdAt: first.createdAt }],
    [{ message: second }],
  ]);
  const replay = new DrizzleCoreUpdateReplaySource(fake.database);

  const updates = await replay.listAfter(CONVERSATION_ID, FIRST_ID, 250);

  assert.deepEqual(updates.map((update) => update.messageId), [SECOND_ID]);
  // The source enforces its own cap even when called outside the HTTP schema.
  assert.deepEqual(fake.limits, [1, 100]);
});

test("a cursor outside the conversation fails closed", async () => {
  const fake = scriptedSelectDatabase([[]]);
  const replay = new DrizzleCoreUpdateReplaySource(fake.database);

  await assert.rejects(
    replay.listAfter(CONVERSATION_ID, FIRST_ID, 10),
    CoreUpdateReplayCursorNotFoundError,
  );
});

function assistantMessage(id: string, content: string, second: number) {
  return {
    id,
    conversationId: CONVERSATION_ID,
    role: "assistant" as const,
    content,
    createdAt: new Date(`2026-08-24T10:00:0${second}.000Z`),
  };
}

function scriptedSelectDatabase(results: readonly (readonly unknown[])[]): {
  readonly database: ShivaDatabase;
  readonly limits: number[];
} {
  const queued = results.map((result) => [...result]);
  const limits: number[] = [];
  const database = {
    select: () => {
      const chain = {
        from: () => chain,
        innerJoin: () => chain,
        where: () => chain,
        orderBy: () => chain,
        limit: async (limit: number) => {
          limits.push(limit);
          return queued.shift() ?? [];
        },
      };
      return chain;
    },
  } as unknown as ShivaDatabase;
  return { database, limits };
}
