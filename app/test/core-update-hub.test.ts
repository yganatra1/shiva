import assert from "node:assert/strict";
import { test } from "node:test";

import fastifyWebsocket from "@fastify/websocket";
import Fastify from "fastify";
import type { WebSocket as WsWebSocket } from "ws";

import {
  CoreUpdateHub,
  registerCoreUpdateSocketRoute,
  type CoreUpdate,
} from "../src/core/core-update-hub.js";
import {
  CoreUpdateReplayCursorNotFoundError,
  type CoreUpdateReplaySource,
} from "../src/core/core-update-replay.js";

const CONVERSATION_ID = "00000000-0000-4000-8000-000000000010";
const OLD_MESSAGE_ID = "00000000-0000-4000-8000-000000000011";
const LIVE_MESSAGE_ID = "00000000-0000-4000-8000-000000000012";

test("a faulty update listener or socket cannot break Core publication", () => {
  const errors: unknown[] = [];
  const delivered: CoreUpdate[] = [];
  const hub = new CoreUpdateHub((error) => {
    errors.push(error);
    throw new Error("error reporter failed");
  });
  hub.subscribe(() => {
    throw new Error("listener failed");
  });
  hub.subscribe((update) => delivered.push(update));
  hub.attach(
    CONVERSATION_ID,
    {
      OPEN: 1,
      readyState: 1,
      send() {
        throw new Error("socket send failed");
      },
    } as unknown as WsWebSocket,
  );
  const update = coreUpdate(LIVE_MESSAGE_ID, "Live result", 2);

  assert.doesNotThrow(() => hub.publish(update));
  assert.deepEqual(delivered, [update]);
  assert.equal(errors.length, 2);
});

test("the update socket replays persisted messages and buffers live publication without duplicates", async (context) => {
  let resolveReplay!: (updates: readonly CoreUpdate[]) => void;
  const calls: unknown[][] = [];
  const replaySource: CoreUpdateReplaySource = {
    listAfter(conversationId, afterMessageId, limit) {
      calls.push([conversationId, afterMessageId, limit]);
      return new Promise((resolve) => {
        resolveReplay = resolve;
      });
    },
  };
  const hub = new CoreUpdateHub();
  const app = Fastify({ logger: false });
  context.after(() => app.close());
  await app.register(fastifyWebsocket);
  registerCoreUpdateSocketRoute(app, hub, replaySource);
  await app.ready();

  const socket = await app.injectWS(
    `/chat/updates?conversationId=${CONVERSATION_ID}&afterMessageId=${OLD_MESSAGE_ID}&limit=25`,
  );
  const received: CoreUpdate[] = [];
  socket.addEventListener("message", (event) => {
    received.push(JSON.parse(String(event.data)) as CoreUpdate);
  });

  const live = coreUpdate(LIVE_MESSAGE_ID, "Live result", 2);
  hub.publish(live);
  resolveReplay([
    coreUpdate(OLD_MESSAGE_ID, "Persisted result", 1),
    // This simulates the DB read observing the same commit that was buffered
    // from process-local publication while the replay query was in flight.
    live,
  ]);
  await waitFor(() => received.length === 2, "replayed updates");

  assert.deepEqual(calls, [[CONVERSATION_ID, OLD_MESSAGE_ID, 25]]);
  assert.deepEqual(
    received.map(({ messageId, message }) => ({ messageId, message })),
    [
      { messageId: OLD_MESSAGE_ID, message: "Persisted result" },
      { messageId: LIVE_MESSAGE_ID, message: "Live result" },
    ],
  );
  socket.terminate();
});

test("a reconnect can resume after its last stable message id", async (context) => {
  const replayed = coreUpdate(LIVE_MESSAGE_ID, "Recovered after restart", 2);
  const calls: unknown[][] = [];
  const replaySource: CoreUpdateReplaySource = {
    async listAfter(conversationId, afterMessageId, limit) {
      calls.push([conversationId, afterMessageId, limit]);
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
      return [replayed];
    },
  };
  // A fresh hub models a Core process restart: no process-local update state
  // exists, so the message can only arrive through the durable replay source.
  const app = Fastify({ logger: false });
  context.after(() => app.close());
  await app.register(fastifyWebsocket);
  registerCoreUpdateSocketRoute(app, new CoreUpdateHub(), replaySource);
  await app.ready();

  const socket = await app.injectWS(
    `/chat/updates?conversationId=${CONVERSATION_ID}&afterMessageId=${OLD_MESSAGE_ID}`,
  );
  const received = await nextUpdate(socket as unknown as WsWebSocket);

  assert.deepEqual(calls, [[CONVERSATION_ID, OLD_MESSAGE_ID, 50]]);
  assert.deepEqual(received, replayed);
  socket.terminate();
});

test("an invalid durable cursor closes the update socket in a controlled way", async (context) => {
  const replaySource: CoreUpdateReplaySource = {
    async listAfter() {
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
      throw new CoreUpdateReplayCursorNotFoundError();
    },
  };
  const app = Fastify({ logger: false });
  context.after(() => app.close());
  await app.register(fastifyWebsocket);
  registerCoreUpdateSocketRoute(app, new CoreUpdateHub(), replaySource);
  await app.ready();
  const socket = await app.injectWS(
    `/chat/updates?conversationId=${CONVERSATION_ID}&afterMessageId=${OLD_MESSAGE_ID}`,
  );

  const close = await new Promise<{ code: number; reason: string }>((resolve) => {
    socket.addEventListener("close", (event) => {
      resolve({ code: event.code, reason: event.reason });
    });
  });
  assert.deepEqual(close, { code: 4404, reason: "update cursor not found" });
  socket.terminate();
});

function coreUpdate(
  messageId: string,
  message: string,
  second: number,
): CoreUpdate {
  return {
    messageId,
    conversationId: CONVERSATION_ID,
    message,
    timestamp: `2026-08-24T10:00:0${second}.000Z`,
  };
}

async function nextUpdate(socket: WsWebSocket): Promise<CoreUpdate> {
  return new Promise((resolve) => {
    socket.addEventListener("message", (event) => {
      resolve(JSON.parse(String(event.data)) as CoreUpdate);
    });
  });
}

async function waitFor(condition: () => boolean, label: string): Promise<void> {
  const deadline = Date.now() + 2_000;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${label}.`);
    await new Promise<void>((resolve) => setTimeout(resolve, 10));
  }
}
