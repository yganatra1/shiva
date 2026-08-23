import assert from "node:assert/strict";
import { test } from "node:test";

import { ExecutionPolicyEngine } from "../src/security/policy-engine.js";
import type { AIProvider, ChatInput, ChatResult } from "../src/brain/ai-provider.js";
import {
  DeviceDispatchError,
  type DeviceCommandResult,
  type DeviceDispatcher,
  type DispatchOptions,
} from "../src/device/device-dispatcher.js";
import { SkillExecutor } from "../src/skills/executor.js";
import { createDeviceCallSkill } from "../src/skills/device-call/skill.js";
import { createDeviceCameraCaptureSkill } from "../src/skills/device-camera-capture/skill.js";
import { createDeviceContactsSearchSkill } from "../src/skills/device-contacts-search/skill.js";
import { createDeviceNotificationsListSkill } from "../src/skills/device-notifications-list/skill.js";
import { createDeviceNotificationsReadSkill } from "../src/skills/device-notifications-read/skill.js";
import { PackRegistry } from "../src/skills/pack-registry.js";
import { SkillRegistry } from "../src/skills/registry.js";
import type { SkillContext } from "../src/skills/types.js";

const DEVICE_SKILL_NAMES = [
  "device_contacts_search",
  "device_call",
  "device_notifications_list",
  "device_notifications_read",
  "device_camera_capture",
] as const;

const context: SkillContext = {
  agentRunId: "10000000-0000-4000-8000-000000000001",
  conversationId: "20000000-0000-4000-8000-000000000002",
  userId: "30000000-0000-4000-8000-000000000003",
  userName: "Yash",
  timeZone: "Asia/Kolkata",
  now: () => new Date("2026-08-22T00:00:00Z"),
};

/** Resolves dispatch() directly with a canned result/error — no wire simulation needed. */
class FakeDeviceDispatcher implements DeviceDispatcher {
  readonly calls: { type: string; arguments: Record<string, string> }[] = [];
  private next:
    | { readonly kind: "result"; readonly value: DeviceCommandResult }
    | { readonly kind: "error"; readonly value: unknown } = {
    kind: "error",
    value: new DeviceDispatchError(
      "DEVICE_NOT_CONNECTED",
      "No device is currently connected.",
    ),
  };

  respondWith(result: DeviceCommandResult): void {
    this.next = { kind: "result", value: result };
  }

  failWith(error: unknown): void {
    this.next = { kind: "error", value: error };
  }

  async dispatch(
    type: string,
    commandArguments: Readonly<Record<string, string>>,
    _options?: DispatchOptions,
  ): Promise<DeviceCommandResult> {
    this.calls.push({ type, arguments: { ...commandArguments } });
    if (this.next.kind === "error") throw this.next.value;
    return this.next.value;
  }
}

function registryWithDevicePack(
  dispatcher?: DeviceDispatcher,
  provider?: AIProvider,
): SkillRegistry {
  const packs = new PackRegistry();
  packs.register({ name: "device", description: "Android device." });
  const registry = new SkillRegistry(packs);
  registry.register(createDeviceContactsSearchSkill(dispatcher));
  registry.register(createDeviceCallSkill(dispatcher));
  registry.register(createDeviceNotificationsListSkill(dispatcher));
  registry.register(createDeviceNotificationsReadSkill(dispatcher));
  registry.register(createDeviceCameraCaptureSkill(dispatcher, provider));
  return registry;
}

class FakeVisionProvider implements AIProvider {
  readonly calls: ChatInput[] = [];
  response: ChatResult = { content: "A cat sitting on a windowsill." };
  failure: Error | undefined;

  async chat(input: ChatInput): Promise<ChatResult> {
    this.calls.push(input);
    if (this.failure) throw this.failure;
    return this.response;
  }

  async *streamChat(): AsyncIterable<{ content: string }> {
    throw new Error("Not used by the camera-capture skill.");
  }
}

test("device_contacts_search dispatches and returns whatever the phone reports", async () => {
  const dispatcher = new FakeDeviceDispatcher();
  dispatcher.respondWith({
    commandId: "cmd-1",
    status: "COMPLETED",
    result: { name: "Charmi", phone: "+911234567890" },
  });
  const registry = registryWithDevicePack(dispatcher);
  const executor = new SkillExecutor(registry, new ExecutionPolicyEngine());

  const result = await executor.execute(
    "device_contacts_search",
    { query: "Charmi" },
    context,
    { userAuthorized: true },
  );

  assert.deepEqual(result, {
    success: true,
    data: { status: "COMPLETED", result: { name: "Charmi", phone: "+911234567890" } },
  });
  assert.deepEqual(dispatcher.calls, [
    { type: "device.contacts.search", arguments: { query: "Charmi" } },
  ]);
  const summary = registry.list().find((skill) => skill.name === "device_contacts_search");
  assert.equal(summary?.pack, "device");
  assert.equal(summary?.configured, true);
  assert.deepEqual(summary?.execution, { mutability: "read", impact: "normal" });
});

test("device_call sends direct as a string and maps a non-COMPLETED status to failure", async () => {
  const dispatcher = new FakeDeviceDispatcher();
  dispatcher.respondWith({
    commandId: "cmd-1",
    status: "DENIED",
    error: "User declined the call permission.",
  });
  const registry = registryWithDevicePack(dispatcher);
  const executor = new SkillExecutor(registry, new ExecutionPolicyEngine());

  const result = await executor.execute(
    "device_call",
    { number: "+911234567890", direct: true },
    context,
    { userAuthorized: true },
  );

  assert.deepEqual(dispatcher.calls, [
    {
      type: "device.phone.call",
      arguments: { number: "+911234567890", direct: "true" },
    },
  ]);
  assert.equal(result.success, false);
  if (!result.success) {
    assert.equal(result.error.code, "DEVICE_COMMAND_DENIED");
    assert.equal(result.error.message, "User declined the call permission.");
  }
  const summary = registry.list().find((skill) => skill.name === "device_call");
  assert.deepEqual(summary?.execution, { mutability: "write", impact: "normal" });
});

test("both device skills fail closed with DEVICE_NOT_CONNECTED when nothing is connected", async () => {
  const dispatcher = new FakeDeviceDispatcher();
  const registry = registryWithDevicePack(dispatcher);
  const executor = new SkillExecutor(registry, new ExecutionPolicyEngine());

  const result = await executor.execute(
    "device_contacts_search",
    { query: "Charmi" },
    context,
    { userAuthorized: true },
  );

  assert.equal(result.success, false);
  if (!result.success) {
    assert.equal(result.error.code, "DEVICE_NOT_CONNECTED");
  }
});

test("every device skill reports configured=true even with no dispatcher (registered, unavailable)", () => {
  const registry = registryWithDevicePack(undefined);
  for (const name of DEVICE_SKILL_NAMES) {
    const summary = registry.list().find((skill) => skill.name === name);
    assert.equal(summary?.configured, true, name);
  }
});

test("the device pack groups all five skills", () => {
  const registry = registryWithDevicePack(new FakeDeviceDispatcher());
  const pack = registry.listPacks().find((entry) => entry.name === "device");
  assert.equal(pack?.skillCount, 5);
});

test("device_notifications_list and device_notifications_read pass through whatever the phone reports", async () => {
  const dispatcher = new FakeDeviceDispatcher();
  const registry = registryWithDevicePack(dispatcher);
  const executor = new SkillExecutor(registry, new ExecutionPolicyEngine());

  dispatcher.respondWith({
    commandId: "cmd-1",
    status: "COMPLETED",
    result: { "notif-1_title": "Message from Charmi", "notif-1_key": "abc123" },
  });
  const listResult = await executor.execute(
    "device_notifications_list",
    {},
    context,
    { userAuthorized: true },
  );
  assert.equal(listResult.success, true);
  assert.equal(dispatcher.calls[0]?.type, "device.notifications.list");

  dispatcher.respondWith({
    commandId: "cmd-2",
    status: "COMPLETED",
    result: { title: "Message from Charmi", body: "Are we still on for lunch?" },
  });
  const readResult = await executor.execute(
    "device_notifications_read",
    { key: "abc123" },
    context,
    { userAuthorized: true },
  );

  assert.equal(dispatcher.calls[1]?.type, "device.notifications.read");
  assert.deepEqual(dispatcher.calls[1]?.arguments, { key: "abc123" });
  assert.deepEqual(readResult, {
    success: true,
    data: {
      status: "COMPLETED",
      result: { title: "Message from Charmi", body: "Are we still on for lunch?" },
    },
  });
});

test("device_camera_capture finds the image field, calls the model to describe it, and never returns raw image bytes", async () => {
  const dispatcher = new FakeDeviceDispatcher();
  dispatcher.respondWith({
    commandId: "cmd-1",
    status: "COMPLETED",
    result: { imageBase64: "ZmFrZS1qcGVnLWJ5dGVz", mimeType: "image/jpeg" },
  });
  const provider = new FakeVisionProvider();
  const registry = registryWithDevicePack(dispatcher, provider);
  const executor = new SkillExecutor(registry, new ExecutionPolicyEngine());

  const result = await executor.execute("device_camera_capture", {}, context, {
    userAuthorized: true,
  });

  assert.equal(dispatcher.calls[0]?.type, "device.camera.capture");
  assert.deepEqual(result, {
    success: true,
    data: { status: "COMPLETED", description: "A cat sitting on a windowsill." },
  });
  assert.equal(provider.calls.length, 1);
  assert.deepEqual(provider.calls[0]?.messages[0]?.images, ["ZmFrZS1qcGVnLWJ5dGVz"]);
  // The description is prose text; the raw base64 payload must never appear
  // in what's returned to the caller/audit log.
  assert.doesNotMatch(JSON.stringify(result), /ZmFrZS1qcGVnLWJ5dGVz/);
});

test("device_camera_capture reports the seen field names when it can't recognize the image field", async () => {
  const dispatcher = new FakeDeviceDispatcher();
  dispatcher.respondWith({
    commandId: "cmd-1",
    status: "COMPLETED",
    result: { someUnexpectedField: "x" },
  });
  const provider = new FakeVisionProvider();
  const registry = registryWithDevicePack(dispatcher, provider);
  const executor = new SkillExecutor(registry, new ExecutionPolicyEngine());

  const result = await executor.execute("device_camera_capture", {}, context, {
    userAuthorized: true,
  });

  assert.equal(result.success, true);
  if (!result.success) return;
  const data = result.data as { note?: string };
  assert.match(data.note ?? "", /someUnexpectedField/);
  assert.equal(provider.calls.length, 0);
});

test("device_camera_capture still reports success with a note when the model can't describe the photo", async () => {
  const dispatcher = new FakeDeviceDispatcher();
  dispatcher.respondWith({
    commandId: "cmd-1",
    status: "COMPLETED",
    result: { imageBase64: "abc" },
  });
  const provider = new FakeVisionProvider();
  provider.failure = new Error("model does not support vision");
  const registry = registryWithDevicePack(dispatcher, provider);
  const executor = new SkillExecutor(registry, new ExecutionPolicyEngine());

  const result = await executor.execute("device_camera_capture", {}, context, {
    userAuthorized: true,
  });

  assert.equal(result.success, true);
  if (!result.success) return;
  const data = result.data as { description?: string; note?: string };
  assert.equal(data.description, undefined);
  assert.match(data.note ?? "", /could not be described/);
});
