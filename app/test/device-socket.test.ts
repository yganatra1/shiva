import assert from "node:assert/strict";
import { test } from "node:test";

import { createApp } from "../src/app.js";
import { DeviceCommandDispatcher } from "../src/device/device-command-dispatcher.js";
import { createTestOverrides, testConfig } from "./test-support.js";

const chatProvider = {
  async chat() {
    return { content: '{"type":"direct_chat"}' };
  },
  async *streamChat() {
    yield { content: "ok" };
  },
};

/** Buffers every text message a live device socket receives. */
class DeviceSocketRecorder {
  readonly messages: unknown[] = [];
  private readonly waiters: (() => void)[] = [];

  constructor(private readonly socket: WebSocket) {
    socket.addEventListener("message", (event: MessageEvent) => {
      this.messages.push(JSON.parse(event.data as string));
      for (const waiter of this.waiters.splice(0)) waiter();
    });
  }

  send(message: unknown): void {
    this.socket.send(JSON.stringify(message));
  }

  async waitFor(predicate: () => boolean, label: string): Promise<void> {
    const deadline = Date.now() + 2_000;
    while (!predicate()) {
      if (Date.now() > deadline) {
        throw new Error(`Timed out waiting for ${label}.`);
      }
      await new Promise<void>((resolve) => {
        this.waiters.push(resolve);
        setTimeout(resolve, 10);
      });
    }
  }
}

async function openDeviceSocket(
  app: ReturnType<typeof createApp>,
  query = "",
): Promise<DeviceSocketRecorder> {
  const socket = await app.injectWS(`/device/ws${query}`);
  return new DeviceSocketRecorder(socket as unknown as WebSocket);
}

test("a connected device receives dispatched commands and its result resolves the dispatch", async (context) => {
  const dispatcher = new DeviceCommandDispatcher({ createCommandId: () => "cmd-1" });
  const app = createApp(testConfig, {
    ...createTestOverrides(chatProvider),
    deviceDispatcher: dispatcher,
  });
  context.after(() => app.close());
  await app.ready();

  assert.equal(dispatcher.isConnected(), false);
  const socket = await openDeviceSocket(app);
  assert.equal(dispatcher.isConnected(), true);

  const pending = dispatcher.dispatch("device.contacts.search", { query: "Charmi" });
  await socket.waitFor(() => socket.messages.length === 1, "device_command");
  const received = socket.messages[0] as {
    type: string;
    command: { id: string; type: string; arguments: Record<string, string> };
  };
  assert.equal(received.type, "device_command");
  assert.equal(received.command.type, "device.contacts.search");
  assert.deepEqual(received.command.arguments, { query: "Charmi" });

  socket.send({
    type: "device_command_result",
    result: {
      commandId: received.command.id,
      status: "COMPLETED",
      result: { name: "Charmi", phone: "+911234567890" },
    },
  });

  const result = await pending;
  assert.deepEqual(result, {
    commandId: "cmd-1",
    status: "COMPLETED",
    result: { name: "Charmi", phone: "+911234567890" },
  });
});

test("a plain GET on the device endpoint asks for an upgrade", async (context) => {
  const app = createApp(testConfig, createTestOverrides(chatProvider));
  context.after(() => app.close());

  const response = await app.inject({ method: "GET", url: "/device/ws" });
  assert.equal(response.statusCode, 426);
  assert.equal(response.json().error.code, "UPGRADE_REQUIRED");
});

test("a configured auth token rejects a connection without a matching token", async (context) => {
  const dispatcher = new DeviceCommandDispatcher();
  const app = createApp(
    { ...testConfig, deviceWsToken: "correct-token" },
    { ...createTestOverrides(chatProvider), deviceDispatcher: dispatcher },
  );
  context.after(() => app.close());
  await app.ready();

  await openDeviceSocket(app, "?token=wrong-token");
  // The route closes the socket before ever calling dispatcher.connect().
  assert.equal(dispatcher.isConnected(), false);
});

test("a configured auth token accepts a connection with the matching token", async (context) => {
  const dispatcher = new DeviceCommandDispatcher();
  const app = createApp(
    { ...testConfig, deviceWsToken: "correct-token" },
    { ...createTestOverrides(chatProvider), deviceDispatcher: dispatcher },
  );
  context.after(() => app.close());
  await app.ready();

  await openDeviceSocket(app, "?token=correct-token");
  assert.equal(dispatcher.isConnected(), true);
});
