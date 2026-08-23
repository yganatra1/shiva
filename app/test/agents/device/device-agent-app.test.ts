import assert from "node:assert/strict";
import { test } from "node:test";

import { createDeviceAgentApp } from "../../../src/agents/device/device-agent-app.js";
import { DeviceCommandDispatcher } from "../../../src/agents/device/device-command-dispatcher.js";
import type {
  DeviceAgentDecision,
  DeviceAgentPlanner,
  DeviceAgentPlanningContext,
} from "../../../src/agents/device/device-agent-types.js";
import { testConfig } from "../../test-support.js";

class ScriptedPlanner implements DeviceAgentPlanner {
  readonly contexts: DeviceAgentPlanningContext[] = [];
  private index = 0;

  constructor(private readonly decisions: readonly DeviceAgentDecision[]) {}

  async decide(context: DeviceAgentPlanningContext): Promise<DeviceAgentDecision> {
    this.contexts.push(context);
    const decision = this.decisions[this.index];
    this.index += 1;
    if (!decision) throw new Error("ScriptedPlanner ran out of decisions.");
    return decision;
  }
}

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
      if (Date.now() > deadline) throw new Error(`Timed out waiting for ${label}.`);
      await new Promise<void>((resolve) => {
        this.waiters.push(resolve);
        setTimeout(resolve, 10);
      });
    }
  }
}

async function openDeviceSocket(
  app: ReturnType<typeof createDeviceAgentApp>,
  query = "",
): Promise<DeviceSocketRecorder> {
  const socket = await app.injectWS(`/device/ws${query}`);
  return new DeviceSocketRecorder(socket as unknown as WebSocket);
}

async function listen(
  app: ReturnType<typeof createDeviceAgentApp>,
): Promise<string> {
  return app.listen({ host: "127.0.0.1", port: 0 });
}

test("a connected device receives dispatched commands and its result resolves the dispatch", async (context) => {
  const dispatcher = new DeviceCommandDispatcher({ createCommandId: () => "cmd-1" });
  const app = createDeviceAgentApp(testConfig, { dispatcher });
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

  socket.send({
    type: "device_command_result",
    result: { commandId: received.command.id, status: "COMPLETED", result: { name: "Charmi" } },
  });

  const result = await pending;
  assert.deepEqual(result, { commandId: "cmd-1", status: "COMPLETED", result: { name: "Charmi" } });
});

test("a plain GET on the device endpoint asks for an upgrade", async (context) => {
  const app = createDeviceAgentApp(testConfig);
  context.after(() => app.close());

  const response = await app.inject({ method: "GET", url: "/device/ws" });
  assert.equal(response.statusCode, 426);
  assert.equal(response.json().error.code, "UPGRADE_REQUIRED");
});

test("a configured auth token rejects a connection without a matching token", async (context) => {
  const dispatcher = new DeviceCommandDispatcher();
  const app = createDeviceAgentApp({ ...testConfig, deviceWsToken: "correct-token" }, { dispatcher });
  context.after(() => app.close());
  await app.ready();

  await openDeviceSocket(app, "?token=wrong-token");
  assert.equal(dispatcher.isConnected(), false);
});

test("a configured auth token accepts a connection with the matching token", async (context) => {
  const dispatcher = new DeviceCommandDispatcher();
  const app = createDeviceAgentApp({ ...testConfig, deviceWsToken: "correct-token" }, { dispatcher });
  context.after(() => app.close());
  await app.ready();

  await openDeviceSocket(app, "?token=correct-token");
  assert.equal(dispatcher.isConnected(), true);
});

test("POST /v1/dispatch returns the phone's result once a connected device replies", async (context) => {
  const dispatcher = new DeviceCommandDispatcher({ createCommandId: () => "cmd-1" });
  dispatcher.connect({
    send: (message: string) => {
      const sent = JSON.parse(message) as { command: { id: string } };
      queueMicrotask(() =>
        dispatcher.handleMessage(
          JSON.stringify({
            type: "device_command_result",
            result: { commandId: sent.command.id, status: "COMPLETED", result: { name: "Charmi" } },
          }),
        ),
      );
    },
  });
  const app = createDeviceAgentApp(testConfig, { dispatcher });
  context.after(() => app.close());

  const response = await app.inject({
    method: "POST",
    url: "/v1/dispatch",
    payload: { type: "device.contacts.search", arguments: { query: "Charmi" } },
  });

  assert.equal(response.statusCode, 200);
  assert.deepEqual(response.json(), {
    commandId: "cmd-1",
    status: "COMPLETED",
    result: { name: "Charmi" },
  });
});

test("POST /v1/dispatch reports 503 when no phone is connected", async (context) => {
  const app = createDeviceAgentApp(testConfig, { dispatcher: new DeviceCommandDispatcher() });
  context.after(() => app.close());

  const response = await app.inject({
    method: "POST",
    url: "/v1/dispatch",
    payload: { type: "device.contacts.search", arguments: { query: "Charmi" } },
  });

  assert.equal(response.statusCode, 503);
  assert.equal(response.json().error.code, "DEVICE_NOT_CONNECTED");
});

test("GET /v1/status reports whether a phone is connected", async (context) => {
  const dispatcher = new DeviceCommandDispatcher();
  const app = createDeviceAgentApp(testConfig, { dispatcher });
  context.after(() => app.close());

  assert.deepEqual((await app.inject({ method: "GET", url: "/v1/status" })).json(), {
    connected: false,
  });
  dispatcher.connect({ send: () => {} });
  assert.deepEqual((await app.inject({ method: "GET", url: "/v1/status" })).json(), {
    connected: true,
  });
});

test("POST /v1/delegate reports 503 without attempting a plan when no phone is connected", async (context) => {
  const planner = new ScriptedPlanner([]);
  const app = createDeviceAgentApp(testConfig, {
    dispatcher: new DeviceCommandDispatcher(),
    planner,
  });
  context.after(() => app.close());

  const response = await app.inject({
    method: "POST",
    url: "/v1/delegate",
    payload: { goal: "order tomato from zepto" },
  });

  assert.equal(response.statusCode, 503);
  assert.equal(response.json().error.code, "DEVICE_NOT_CONNECTED");
  assert.equal(planner.contexts.length, 0);
});

test("POST /v1/delegate rejects a malformed body with 400", async (context) => {
  const app = createDeviceAgentApp(testConfig, { dispatcher: new DeviceCommandDispatcher() });
  context.after(() => app.close());

  const response = await app.inject({ method: "POST", url: "/v1/delegate", payload: { goal: "" } });
  assert.equal(response.statusCode, 400);
  assert.equal(response.json().error.code, "INVALID_DELEGATE_REQUEST");
});

test("POST /v1/delegate drives the planner against the phone and returns its result", async (context) => {
  const dispatcher = new DeviceCommandDispatcher({ createCommandId: () => "cmd-1" });
  dispatcher.connect({
    send: (message: string) => {
      const sent = JSON.parse(message) as { command: { id: string } };
      queueMicrotask(() =>
        dispatcher.handleMessage(
          JSON.stringify({
            type: "device_command_result",
            result: { commandId: sent.command.id, status: "COMPLETED", result: { opened: "true" } },
          }),
        ),
      );
    },
  });
  const planner = new ScriptedPlanner([
    { type: "call_tool", tool: "device.app.open", arguments: { name: "Zepto" } },
    { type: "done", success: true, summary: "Opened Zepto." },
  ]);
  const app = createDeviceAgentApp(testConfig, { dispatcher, planner });
  context.after(() => app.close());

  const response = await app.inject({
    method: "POST",
    url: "/v1/delegate",
    payload: { goal: "open zepto" },
  });

  assert.equal(response.statusCode, 200);
  assert.deepEqual(response.json(), { success: true, summary: "Opened Zepto.", steps: 1 });
  assert.equal(planner.contexts.length, 2);
  assert.equal(planner.contexts[1]?.steps.length, 1);
  assert.equal(planner.contexts[1]?.steps[0]?.result.status, "COMPLETED");
});

test("a real HTTP delegation is not cancelled when its request body finishes", async (context) => {
  const dispatcher = new DeviceCommandDispatcher({ createCommandId: () => "cmd-1" });
  dispatcher.connect({
    send: (message: string) => {
      const sent = JSON.parse(message) as { command: { id: string } };
      setTimeout(
        () =>
          dispatcher.handleMessage(
            JSON.stringify({
              type: "device_command_result",
              result: {
                commandId: sent.command.id,
                status: "COMPLETED",
                result: { name: "Miralididi", phone: "+911234567890" },
              },
            }),
          ),
        25,
      );
    },
  });
  const planner = new ScriptedPlanner([
    {
      type: "call_tool",
      tool: "device.contacts.search",
      arguments: { query: "miralididi" },
    },
    {
      type: "done",
      success: true,
      summary: "Miralididi's phone number is +911234567890.",
    },
  ]);
  const app = createDeviceAgentApp(testConfig, { dispatcher, planner });
  context.after(() => app.close());
  const origin = await listen(app);

  const response = await fetch(`${origin}/v1/delegate`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ goal: "Find miralididi's phone number." }),
  });

  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), {
    success: true,
    summary: "Miralididi's phone number is +911234567890.",
    steps: 1,
  });
  assert.equal(planner.contexts[1]?.steps[0]?.result.status, "COMPLETED");
});
