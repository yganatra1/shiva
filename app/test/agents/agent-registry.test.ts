import assert from "node:assert/strict";
import { test } from "node:test";

import {
  AgentRegistry,
  DuplicateAgentError,
  InvalidAgentDefinitionError,
  UnknownAgentError,
} from "../../src/agents/agent-registry.js";

function deviceAgent(capabilities: string[] = ["make phone calls"]) {
  return {
    id: "device-agent",
    name: "Device Agent",
    description: "Handles actions involving connected user devices.",
    capabilities,
  };
}

test("agents are registered and routed by stable id", () => {
  const registry = new AgentRegistry();
  registry.register(deviceAgent());

  assert.equal(registry.has("device-agent"), true);
  assert.equal(registry.has("Device Agent"), false);
  assert.deepEqual(registry.get("device-agent"), {
    id: "device-agent",
    name: "Device Agent",
    description: "Handles actions involving connected user devices.",
    capabilities: ["make phone calls"],
  });
});

test("capabilities remain human-readable free-form statements", () => {
  const registry = new AgentRegistry();
  registry.register(
    deviceAgent([
      "make phone calls",
      "read device status when the connected phone permits it",
      "open applications",
    ]),
  );

  assert.deepEqual(registry.get("device-agent").capabilities, [
    "make phone calls",
    "read device status when the connected phone permits it",
    "open applications",
  ]);
});

test("duplicate ids are rejected while display names need not be route keys", () => {
  const registry = new AgentRegistry();
  registry.register(deviceAgent());

  assert.throws(
    () =>
      registry.register({
        ...deviceAgent(),
        name: "Another Device Worker",
      }),
    DuplicateAgentError,
  );

  registry.register({
    id: "backup-device-agent",
    name: "Device Agent",
    description: "A separately routed backup device worker.",
    capabilities: ["read device status"],
  });
  assert.equal(registry.get("backup-device-agent").name, "Device Agent");
});

test("registered descriptors do not retain a mutable capabilities array", () => {
  const capabilities = ["make phone calls"];
  const registry = new AgentRegistry();
  registry.register(deviceAgent(capabilities));

  capabilities.push("unexpected later capability");

  assert.deepEqual(registry.get("device-agent").capabilities, [
    "make phone calls",
  ]);
});

test("invalid ids and capability entries fail registration", () => {
  const registry = new AgentRegistry();

  assert.throws(
    () => registry.register({ ...deviceAgent(), id: "Device Agent" }),
    InvalidAgentDefinitionError,
  );
  assert.throws(
    () => registry.register(deviceAgent(["make phone calls", "  "])),
    InvalidAgentDefinitionError,
  );
  assert.throws(
    () =>
      registry.register(
        deviceAgent(["make phone calls", " make phone calls "]),
      ),
    InvalidAgentDefinitionError,
  );
});

test("unknown ids fail with the registry's typed error", () => {
  const registry = new AgentRegistry();
  assert.throws(() => registry.get("missing-agent"), UnknownAgentError);
});

test("legacy HTTP descriptors are normalized during incremental migration", () => {
  const registry = new AgentRegistry();
  registry.register({
    name: "device",
    description: "Legacy device worker.",
    baseUrl: "http://127.0.0.1:3002",
  });

  assert.deepEqual(registry.get("device"), {
    id: "device",
    name: "device",
    description: "Legacy device worker.",
    capabilities: [],
    baseUrl: "http://127.0.0.1:3002",
  });
});
