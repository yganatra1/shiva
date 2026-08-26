import assert from "node:assert/strict";
import { test } from "node:test";

import {
  DeviceCommandDispatcher,
  DeviceDispatchError,
  deviceErrorToFailure,
  type DeviceTransport,
} from "../../../src/agents/device/device-command-dispatcher.js";
import { deviceCommandResultMessageSchema } from "../../../src/agents/device/device-protocol.js";

class RecordingTransport implements DeviceTransport {
  readonly sent: string[] = [];

  send(message: string): void {
    this.sent.push(message);
  }
}

function resultMessage(commandId: string, overrides: Record<string, unknown> = {}) {
  return JSON.stringify({
    type: "device_command_result",
    result: { commandId, status: "COMPLETED", ...overrides },
  });
}

test("dispatch sends a device_command message and resolves on the matching result", async () => {
  const dispatcher = new DeviceCommandDispatcher({
    createCommandId: () => "cmd-1",
    now: () => new Date("2026-08-22T00:00:00Z"),
  });
  const transport = new RecordingTransport();
  dispatcher.connect(transport);

  const pending = dispatcher.dispatch("device.contacts.search", { query: "Charmi" });
  dispatcher.handleMessage(
    resultMessage("cmd-1", { result: { name: "Charmi", phone: "+911234567890" } }),
  );
  const result = await pending;

  assert.equal(transport.sent.length, 1);
  const sent = JSON.parse(transport.sent[0] ?? "{}") as {
    type: string;
    command: { id: string; type: string; arguments: Record<string, string> };
  };
  assert.equal(sent.type, "device_command");
  assert.equal(sent.command.id, "cmd-1");
  assert.equal(sent.command.type, "device.contacts.search");
  assert.deepEqual(sent.command.arguments, { query: "Charmi" });
  assert.deepEqual(result, {
    commandId: "cmd-1",
    status: "COMPLETED",
    result: { name: "Charmi", phone: "+911234567890" },
  });
});

test("dispatch rejects immediately when no device is connected", async () => {
  const dispatcher = new DeviceCommandDispatcher();
  await assert.rejects(
    () => dispatcher.dispatch("device.phone.call", { number: "123" }),
    (error: unknown) =>
      error instanceof DeviceDispatchError && error.failure === "DEVICE_NOT_CONNECTED",
  );
});

test("dispatch times out when the device never replies", async () => {
  const dispatcher = new DeviceCommandDispatcher();
  dispatcher.connect(new RecordingTransport());

  await assert.rejects(
    () => dispatcher.dispatch("device.phone.call", { number: "123" }, { timeoutMs: 1_000 }),
    (error: unknown) =>
      error instanceof DeviceDispatchError && error.failure === "DEVICE_TIMEOUT",
  );
});

test("disconnecting fails every pending command for that connection", async () => {
  const dispatcher = new DeviceCommandDispatcher({ createCommandId: () => "cmd-1" });
  const transport = new RecordingTransport();
  dispatcher.connect(transport);

  const pending = dispatcher.dispatch("device.phone.call", { number: "123" }, {
    timeoutMs: 5_000,
  });
  dispatcher.disconnect(transport);

  await assert.rejects(
    () => pending,
    (error: unknown) =>
      error instanceof DeviceDispatchError && error.failure === "DEVICE_DISCONNECTED",
  );
  assert.equal(dispatcher.isConnected(), false);
});

test("a new connection replaces the old one and fails its pending commands", async () => {
  const dispatcher = new DeviceCommandDispatcher({ createCommandId: () => "cmd-1" });
  const first = new RecordingTransport();
  dispatcher.connect(first);
  const pending = dispatcher.dispatch("device.phone.call", { number: "123" }, {
    timeoutMs: 5_000,
  });

  const second = new RecordingTransport();
  dispatcher.connect(second);

  await assert.rejects(
    () => pending,
    (error: unknown) =>
      error instanceof DeviceDispatchError && error.failure === "DEVICE_DISCONNECTED",
  );
  assert.equal(dispatcher.isConnected(), true);

  // disconnecting the stale transport must not clear the new connection.
  dispatcher.disconnect(first);
  assert.equal(dispatcher.isConnected(), true);
});

test("handleMessage silently ignores malformed JSON and unknown command IDs", async () => {
  const dispatcher = new DeviceCommandDispatcher({ createCommandId: () => "cmd-1" });
  dispatcher.connect(new RecordingTransport());

  const pending = dispatcher.dispatch("device.phone.call", { number: "123" }, {
    timeoutMs: 5_000,
  });

  dispatcher.handleMessage("not json");
  dispatcher.handleMessage(resultMessage("cmd-unrelated"));
  dispatcher.handleMessage(JSON.stringify({ type: "something_else" }));
  dispatcher.handleMessage(resultMessage("cmd-1"));

  const result = await pending;
  assert.equal(result.status, "COMPLETED");
});

test("an AbortSignal cancels a pending dispatch", async () => {
  const dispatcher = new DeviceCommandDispatcher();
  dispatcher.connect(new RecordingTransport());
  const controller = new AbortController();

  const pending = dispatcher.dispatch(
    "device.phone.call",
    { number: "123" },
    { timeoutMs: 5_000, signal: controller.signal },
  );
  controller.abort();

  await assert.rejects(
    () => pending,
    (error: unknown) => error instanceof DeviceDispatchError && error.failure === "CANCELLED",
  );
});

test("deviceErrorToFailure maps every failure kind and rethrows anything else", () => {
  assert.equal(
    deviceErrorToFailure(new DeviceDispatchError("DEVICE_NOT_CONNECTED", "x")).code,
    "DEVICE_NOT_CONNECTED",
  );
  assert.equal(
    deviceErrorToFailure(new DeviceDispatchError("DEVICE_TIMEOUT", "x")).code,
    "DEVICE_TIMEOUT",
  );
  assert.equal(
    deviceErrorToFailure(new DeviceDispatchError("DEVICE_DISCONNECTED", "x")).code,
    "DEVICE_DISCONNECTED",
  );
  assert.equal(
    deviceErrorToFailure(new DeviceDispatchError("DEVICE_SEND_FAILED", "x")).code,
    "DEVICE_COMMAND_SEND_FAILED",
  );
  assert.throws(() => deviceErrorToFailure(new Error("not a device error")));
});

test("handleMessage accepts lowercase status from the Android wire format", async () => {
  const dispatcher = new DeviceCommandDispatcher({ createCommandId: () => "cmd-1" });
  dispatcher.connect(new RecordingTransport());

  const pending = dispatcher.dispatch("device.contacts.search", { query: "Meow" });
  dispatcher.handleMessage(
    JSON.stringify({
      type: "device_command_result",
      result: {
        commandId: "cmd-1",
        status: "completed",
        result: { name: "Meow", phone: "+918866730801" },
      },
    }),
  );

  const result = await pending;
  assert.equal(result.status, "COMPLETED");
  assert.deepEqual(result.result, { name: "Meow", phone: "+918866730801" });
});

test("the result message schema accepts large image payload fields", () => {
  const largeBase64 = "A".repeat(500_000);
  assert.equal(
    deviceCommandResultMessageSchema.safeParse({
      type: "device_command_result",
      result: {
        commandId: "x",
        status: "COMPLETED",
        result: { mime: "image/jpeg", data: largeBase64 },
      },
    }).success,
    true,
  );
});

test("the result message schema accepts every status and rejects unknown fields", () => {
  for (const status of ["COMPLETED", "FAILED", "UNSUPPORTED", "DENIED"] as const) {
    assert.equal(
      deviceCommandResultMessageSchema.safeParse({
        type: "device_command_result",
        result: { commandId: "x", status },
      }).success,
      true,
    );
  }
  assert.equal(
    deviceCommandResultMessageSchema.safeParse({
      type: "device_command_result",
      result: { commandId: "x", status: "COMPLETED", extra: "nope" },
    }).success,
    false,
  );
});

test("IMPLEMENTED_DEVICE_COMMAND_TYPES includes the full UI-automation surface", async () => {
  const { IMPLEMENTED_DEVICE_COMMAND_TYPES } = await import(
    "../../../src/agents/device/device-protocol.js"
  );
  for (const type of [
    "device.app.open",
    "device.app.list",
    "device.notification.send",
    "device.sms.send",
    "device.location.get",
    "device.status.get",
    "device.ui.inspect",
    "device.ui.find",
    "device.ui.click",
    "device.ui.type",
    "device.ui.scroll",
    "device.ui.wait",
    "device.ui.screenshot",
    "device.ui.gesture",
    "device.ui.back",
    "device.ui.global",
  ] as const) {
    assert.ok(
      (IMPLEMENTED_DEVICE_COMMAND_TYPES as readonly string[]).includes(type),
      `expected ${type} to be implemented`,
    );
  }
  assert.equal(IMPLEMENTED_DEVICE_COMMAND_TYPES.length, 21);
});
