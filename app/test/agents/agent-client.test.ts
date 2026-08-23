import assert from "node:assert/strict";
import { createServer } from "node:http";
import { test } from "node:test";

import { AgentClient, AgentDelegationError } from "../../src/agents/agent-client.js";
import { AgentRegistry } from "../../src/agents/agent-registry.js";

type FakeResponse = { readonly status: number; readonly body: unknown } | "hang";

/** Stands in for an agent process's /v1/delegate endpoint. */
async function startFakeAgent(
  handler: (body: unknown) => FakeResponse,
): Promise<{ readonly url: string; close(): Promise<void> }> {
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8");
      const response = handler(raw ? JSON.parse(raw) : undefined);
      if (response === "hang") return;
      res.writeHead(response.status, { "content-type": "application/json" });
      res.end(JSON.stringify(response.body));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (typeof address === "string" || address === null) {
    throw new Error("Expected the fake agent to bind a TCP port.");
  }
  return {
    url: `http://127.0.0.1:${address.port}`,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

function registryWithDevice(baseUrl: string): AgentRegistry {
  const registry = new AgentRegistry();
  registry.register({ name: "device", description: "the device agent", baseUrl });
  return registry;
}

test("delegate resolves with the agent's result on 200", async (context) => {
  const fake = await startFakeAgent(() => ({
    status: 200,
    body: { success: true, summary: "Opened Zepto.", steps: 3 },
  }));
  context.after(() => fake.close());
  const client = new AgentClient(registryWithDevice(fake.url));

  const result = await client.delegate("device", "open zepto");
  assert.deepEqual(result, { success: true, summary: "Opened Zepto.", steps: 3 });
});

test("delegate throws AGENT_NOT_FOUND for an unregistered agent without any network call", async () => {
  const client = new AgentClient(new AgentRegistry());
  await assert.rejects(
    () => client.delegate("nonexistent", "do something"),
    (error: unknown) => error instanceof AgentDelegationError && error.failure === "AGENT_NOT_FOUND",
  );
});

test("delegate throws AGENT_FAILED when the agent returns a non-2xx response", async (context) => {
  const fake = await startFakeAgent(() => ({
    status: 503,
    body: { error: { code: "DEVICE_NOT_CONNECTED", message: "No phone is connected." } },
  }));
  context.after(() => fake.close());
  const client = new AgentClient(registryWithDevice(fake.url));

  await assert.rejects(
    () => client.delegate("device", "open zepto"),
    (error: unknown) =>
      error instanceof AgentDelegationError &&
      error.failure === "AGENT_FAILED" &&
      error.message === "No phone is connected.",
  );
});

test("delegate throws AGENT_FAILED for a malformed response body", async (context) => {
  const fake = await startFakeAgent(() => ({ status: 200, body: { oops: true } }));
  context.after(() => fake.close());
  const client = new AgentClient(registryWithDevice(fake.url));

  await assert.rejects(
    () => client.delegate("device", "open zepto"),
    (error: unknown) => error instanceof AgentDelegationError && error.failure === "AGENT_FAILED",
  );
});

test("delegate throws AGENT_UNREACHABLE when the agent process is down", async () => {
  const client = new AgentClient(registryWithDevice("http://127.0.0.1:1"));
  await assert.rejects(
    () => client.delegate("device", "open zepto"),
    (error: unknown) =>
      error instanceof AgentDelegationError && error.failure === "AGENT_UNREACHABLE",
  );
});

test("delegate throws CANCELLED when the caller's own signal aborts mid-request", async (context) => {
  const fake = await startFakeAgent(() => "hang");
  context.after(() => fake.close());
  const client = new AgentClient(registryWithDevice(fake.url));
  const controller = new AbortController();

  const pending = client.delegate("device", "open zepto", { signal: controller.signal });
  controller.abort();

  await assert.rejects(
    () => pending,
    (error: unknown) => error instanceof AgentDelegationError && error.failure === "CANCELLED",
  );
});
