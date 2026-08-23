import assert from "node:assert/strict";
import { createServer } from "node:http";
import { test } from "node:test";

import {
  DeviceDispatchError,
  type DeviceDispatchFailure,
} from "../src/device/device-dispatcher.js";
import { DeviceServiceClient } from "../src/device/device-service-client.js";

type FakeResponse = { readonly status: number; readonly body: unknown } | "hang";

/** Stands in for shiva-device-service's HTTP surface (/v1/dispatch, /v1/status). */
async function startFakeDeviceService(
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
    throw new Error("Expected the fake device-service to bind a TCP port.");
  }
  return {
    url: `http://127.0.0.1:${address.port}`,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

test("dispatch resolves with the phone's result on 200", async (context) => {
  const fake = await startFakeDeviceService(() => ({
    status: 200,
    body: { commandId: "cmd-1", status: "COMPLETED", result: { name: "Charmi" } },
  }));
  context.after(() => fake.close());
  const client = new DeviceServiceClient({ baseUrl: fake.url });

  const result = await client.dispatch("device.contacts.search", { query: "Charmi" });
  assert.deepEqual(result, {
    commandId: "cmd-1",
    status: "COMPLETED",
    result: { name: "Charmi" },
  });
});

test("dispatch omits result/error fields device-service didn't send", async (context) => {
  const fake = await startFakeDeviceService(() => ({
    status: 200,
    body: { commandId: "cmd-1", status: "COMPLETED" },
  }));
  context.after(() => fake.close());
  const client = new DeviceServiceClient({ baseUrl: fake.url });

  const result = await client.dispatch("device.phone.call", { number: "123" });
  assert.deepEqual(result, { commandId: "cmd-1", status: "COMPLETED" });
  assert.equal("result" in result, false);
});

test("dispatch maps each HTTP failure status to the matching DeviceDispatchError failure", async () => {
  const cases: readonly [number, DeviceDispatchFailure][] = [
    [503, "DEVICE_NOT_CONNECTED"],
    [504, "DEVICE_TIMEOUT"],
    [409, "DEVICE_DISCONNECTED"],
    [502, "DEVICE_SEND_FAILED"],
  ];
  for (const [status, failure] of cases) {
    const fake = await startFakeDeviceService(() => ({
      status,
      body: { error: { code: failure, message: `failed with ${status}` } },
    }));
    const client = new DeviceServiceClient({ baseUrl: fake.url });
    await assert.rejects(
      () => client.dispatch("device.phone.call", { number: "123" }),
      (error: unknown) =>
        error instanceof DeviceDispatchError &&
        error.failure === failure &&
        error.message === `failed with ${status}`,
    );
    await fake.close();
  }
});

test("dispatch throws DEVICE_SEND_FAILED when device-service returns a malformed body", async (context) => {
  const fake = await startFakeDeviceService(() => ({
    status: 200,
    body: { oops: "not a DeviceCommandResult" },
  }));
  context.after(() => fake.close());
  const client = new DeviceServiceClient({ baseUrl: fake.url });

  await assert.rejects(
    () => client.dispatch("device.phone.call", { number: "123" }),
    (error: unknown) =>
      error instanceof DeviceDispatchError && error.failure === "DEVICE_SEND_FAILED",
  );
});

test("dispatch throws DEVICE_SEND_FAILED when device-service is unreachable", async () => {
  const client = new DeviceServiceClient({ baseUrl: "http://127.0.0.1:1" });

  await assert.rejects(
    () => client.dispatch("device.phone.call", { number: "123" }),
    (error: unknown) =>
      error instanceof DeviceDispatchError && error.failure === "DEVICE_SEND_FAILED",
  );
});

test("dispatch throws CANCELLED when the caller's own signal aborts mid-request", async (context) => {
  const fake = await startFakeDeviceService(() => "hang");
  context.after(() => fake.close());
  const client = new DeviceServiceClient({ baseUrl: fake.url });
  const controller = new AbortController();

  const pending = client.dispatch(
    "device.phone.call",
    { number: "123" },
    { signal: controller.signal },
  );
  controller.abort();

  await assert.rejects(
    () => pending,
    (error: unknown) => error instanceof DeviceDispatchError && error.failure === "CANCELLED",
  );
});

test("dispatch rejects immediately for an already-aborted signal", async () => {
  const client = new DeviceServiceClient({ baseUrl: "http://127.0.0.1:1" });
  const controller = new AbortController();
  controller.abort();

  await assert.rejects(() =>
    client.dispatch("device.phone.call", { number: "123" }, { signal: controller.signal }),
  );
});

test("isConnected reflects device-service's reported status", async (context) => {
  const fake = await startFakeDeviceService(() => ({
    status: 200,
    body: { connected: true },
  }));
  context.after(() => fake.close());
  const client = new DeviceServiceClient({ baseUrl: fake.url });

  assert.equal(await client.isConnected(), true);
});

test("isConnected reports false when device-service is unreachable", async () => {
  const client = new DeviceServiceClient({ baseUrl: "http://127.0.0.1:1" });
  assert.equal(await client.isConnected(), false);
});
