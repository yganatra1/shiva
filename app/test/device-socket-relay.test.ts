import assert from "node:assert/strict";
import { test } from "node:test";
import { WebSocketServer, type WebSocket as UpstreamWebSocket } from "ws";

import { createApp } from "../src/app.js";
import { createTestOverrides, testConfig } from "./test-support.js";

const chatProvider = {
  async chat() {
    return { content: '{"type":"direct_chat"}' };
  },
  async *streamChat() {
    yield { content: "ok" };
  },
};

/** Stands in for shiva-device-service: a bare WebSocket server on /device/ws. */
async function startFakeDeviceService(): Promise<{
  readonly url: string;
  readonly nextConnection: Promise<UpstreamWebSocket & { readonly requestUrl: string }>;
  close(): Promise<void>;
}> {
  const server = new WebSocketServer({ port: 0, path: "/device/ws" });
  await new Promise<void>((resolve) => server.once("listening", resolve));
  const nextConnection = new Promise<UpstreamWebSocket & { readonly requestUrl: string }>(
    (resolve) => {
      server.on("connection", (socket, request) => {
        resolve(Object.assign(socket, { requestUrl: request.url ?? "" }));
      });
    },
  );
  const address = server.address();
  if (typeof address === "string" || address === null) {
    throw new Error("Expected the fake device-service to bind a TCP port.");
  }
  return {
    url: `http://127.0.0.1:${address.port}`,
    nextConnection,
    close: () =>
      new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      ),
  };
}

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
      if (Date.now() > deadline) throw new Error(`Timed out waiting for ${label}.`);
      await new Promise<void>((resolve) => {
        this.waiters.push(resolve);
        setTimeout(resolve, 10);
      });
    }
  }
}

test("the phone's messages are relayed to device-service and its replies come back unmodified", async (context) => {
  const fakeDeviceService = await startFakeDeviceService();
  context.after(() => fakeDeviceService.close());

  const app = createApp(
    { ...testConfig, deviceAgentUrl: fakeDeviceService.url },
    createTestOverrides(chatProvider),
  );
  context.after(() => app.close());
  await app.ready();

  const phoneSocket = await app.injectWS("/device/ws?token=abc");
  const phone = new DeviceSocketRecorder(phoneSocket as unknown as WebSocket);

  const upstream = await fakeDeviceService.nextConnection;
  assert.equal(upstream.requestUrl, "/device/ws?token=abc");

  upstream.send(JSON.stringify({ type: "device_command", command: { id: "cmd-1" } }));
  await phone.waitFor(() => phone.messages.length === 1, "relayed device_command");
  assert.deepEqual(phone.messages[0], { type: "device_command", command: { id: "cmd-1" } });

  const upstreamMessages: unknown[] = [];
  upstream.on("message", (data) => upstreamMessages.push(JSON.parse(data.toString("utf8"))));
  phone.send({ type: "device_command_result", result: { commandId: "cmd-1", status: "COMPLETED" } });
  const deadline = Date.now() + 2_000;
  while (upstreamMessages.length === 0 && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.deepEqual(upstreamMessages[0], {
    type: "device_command_result",
    result: { commandId: "cmd-1", status: "COMPLETED" },
  });

  // Terminate rather than close(): a graceful close handshake here can take
  // ws's full 30s close-timeout to settle, which would otherwise make
  // app.close()/fakeDeviceService.close() hang the test for that long.
  (phoneSocket as unknown as { terminate(): void }).terminate();
  upstream.terminate();
});

test("a plain GET on the device endpoint asks for an upgrade", async (context) => {
  const app = createApp(testConfig, createTestOverrides(chatProvider));
  context.after(() => app.close());

  const response = await app.inject({ method: "GET", url: "/device/ws" });
  assert.equal(response.statusCode, 426);
  assert.equal(response.json().error.code, "UPGRADE_REQUIRED");
});

test("the phone's connection closes when device-service is unreachable", async (context) => {
  const app = createApp(
    { ...testConfig, deviceAgentUrl: "http://127.0.0.1:1" },
    createTestOverrides(chatProvider),
  );
  context.after(() => app.close());
  await app.ready();

  const phoneSocket = (await app.injectWS("/device/ws")) as unknown as WebSocket;
  await new Promise<void>((resolve) => {
    phoneSocket.addEventListener("close", () => resolve());
    setTimeout(resolve, 2_000);
  });
  assert.notEqual(phoneSocket.readyState, phoneSocket.OPEN);
  // Terminate rather than leave a half-closed handshake: ws's 30s
  // close-timeout would otherwise make app.close() hang the test that long.
  (phoneSocket as unknown as { terminate(): void }).terminate();
});
