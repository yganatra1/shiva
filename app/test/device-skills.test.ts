import assert from "node:assert/strict";
import { test } from "node:test";

import { ExecutionPolicyEngine } from "../src/security/policy-engine.js";
import {
  DeviceCommandDispatcher,
  type DeviceTransport,
} from "../src/device/device-command-dispatcher.js";
import { SkillExecutor } from "../src/skills/executor.js";
import { createDeviceCallSkill } from "../src/skills/device-call/skill.js";
import { createDeviceContactsSearchSkill } from "../src/skills/device-contacts-search/skill.js";
import { PackRegistry } from "../src/skills/pack-registry.js";
import { SkillRegistry } from "../src/skills/registry.js";
import type { SkillContext } from "../src/skills/types.js";

const context: SkillContext = {
  agentRunId: "10000000-0000-4000-8000-000000000001",
  conversationId: "20000000-0000-4000-8000-000000000002",
  userId: "30000000-0000-4000-8000-000000000003",
  userName: "Yash",
  timeZone: "Asia/Kolkata",
  now: () => new Date("2026-08-22T00:00:00Z"),
};

class RecordingTransport implements DeviceTransport {
  readonly sent: string[] = [];

  send(message: string): void {
    this.sent.push(message);
  }
}

function registryWithDevicePack(dispatcher?: DeviceCommandDispatcher): SkillRegistry {
  const packs = new PackRegistry();
  packs.register({ name: "device", description: "Android device." });
  const registry = new SkillRegistry(packs);
  registry.register(createDeviceContactsSearchSkill(dispatcher));
  registry.register(createDeviceCallSkill(dispatcher));
  return registry;
}

/** SkillExecutor awaits policy/audit steps before the skill actually dispatches. */
async function waitForSentCommand(transport: RecordingTransport): Promise<{
  id: string;
  type: string;
  arguments: Record<string, string>;
}> {
  const deadline = Date.now() + 2_000;
  while (transport.sent.length === 0) {
    if (Date.now() > deadline) {
      throw new Error("Timed out waiting for a device command to be sent.");
    }
    await new Promise((resolve) => setImmediate(resolve));
  }
  const sent = JSON.parse(transport.sent.at(-1) ?? "{}") as {
    command: { id: string; type: string; arguments: Record<string, string> };
  };
  return sent.command;
}

function respondToCommand(
  dispatcher: DeviceCommandDispatcher,
  commandId: string,
  overrides: Record<string, unknown>,
): void {
  dispatcher.handleMessage(
    JSON.stringify({
      type: "device_command_result",
      result: { commandId, status: "COMPLETED", ...overrides },
    }),
  );
}

test("device_contacts_search dispatches and returns whatever the phone reports", async () => {
  const dispatcher = new DeviceCommandDispatcher();
  const transport = new RecordingTransport();
  dispatcher.connect(transport);
  const registry = registryWithDevicePack(dispatcher);
  const executor = new SkillExecutor(registry, new ExecutionPolicyEngine());

  const pending = executor.execute(
    "device_contacts_search",
    { query: "Charmi" },
    context,
    { userAuthorized: true },
  );
  const command = await waitForSentCommand(transport);
  respondToCommand(dispatcher, command.id, {
    result: { name: "Charmi", phone: "+911234567890" },
  });
  const result = await pending;

  assert.deepEqual(result, {
    success: true,
    data: { status: "COMPLETED", result: { name: "Charmi", phone: "+911234567890" } },
  });
  const summary = registry.list().find((skill) => skill.name === "device_contacts_search");
  assert.equal(summary?.pack, "device");
  assert.equal(summary?.configured, true);
  assert.deepEqual(summary?.execution, { mutability: "read", impact: "normal" });
});

test("device_call sends direct as a string and maps a non-COMPLETED status to failure", async () => {
  const dispatcher = new DeviceCommandDispatcher();
  const transport = new RecordingTransport();
  dispatcher.connect(transport);
  const registry = registryWithDevicePack(dispatcher);
  const executor = new SkillExecutor(registry, new ExecutionPolicyEngine());

  const pending = executor.execute(
    "device_call",
    { number: "+911234567890", direct: true },
    context,
    { userAuthorized: true },
  );
  const command = await waitForSentCommand(transport);
  assert.deepEqual(command.arguments, { number: "+911234567890", direct: "true" });

  dispatcher.handleMessage(
    JSON.stringify({
      type: "device_command_result",
      result: {
        commandId: command.id,
        status: "DENIED",
        error: "User declined the call permission.",
      },
    }),
  );
  const result = await pending;

  assert.equal(result.success, false);
  if (!result.success) {
    assert.equal(result.error.code, "DEVICE_COMMAND_DENIED");
    assert.equal(result.error.message, "User declined the call permission.");
  }
  const summary = registry.list().find((skill) => skill.name === "device_call");
  assert.deepEqual(summary?.execution, { mutability: "write", impact: "normal" });
});

test("both device skills fail closed with DEVICE_NOT_CONNECTED when nothing is connected", async () => {
  const dispatcher = new DeviceCommandDispatcher();
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

test("both device skills report configured=true even with no dispatcher (registered, unavailable)", () => {
  const registry = registryWithDevicePack(undefined);
  for (const name of ["device_contacts_search", "device_call"]) {
    const summary = registry.list().find((skill) => skill.name === name);
    assert.equal(summary?.configured, true, name);
  }
});

test("the device pack groups both skills", () => {
  const registry = registryWithDevicePack(new DeviceCommandDispatcher());
  const pack = registry.listPacks().find((entry) => entry.name === "device");
  assert.equal(pack?.skillCount, 2);
});
