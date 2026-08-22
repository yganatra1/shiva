import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { test } from "node:test";

import {
  AIProviderError,
  type AIProviderFailure,
} from "../src/brain/ai-provider.js";
import { OllamaProvider } from "../src/brain/ollama-provider.js";

test("the provider streams NDJSON chunks and chat() collects them", async (context) => {
  const requestBodies: unknown[] = [];
  const acceptHeaders: Array<string | undefined> = [];
  const upstream = createServer((request, response) => {
    const bodyParts: Buffer[] = [];
    request.on("data", (part: Buffer) => bodyParts.push(part));
    request.on("end", () => {
      acceptHeaders.push(request.headers.accept);
      requestBodies.push(
        JSON.parse(Buffer.concat(bodyParts).toString("utf8")) as unknown,
      );
      response.setHeader("content-type", "application/x-ndjson");
      response.write(
        `${JSON.stringify({ done: false, message: { content: "Hello" } })}\n`,
      );
      setTimeout(() => {
        response.write(
          `${JSON.stringify({ done: false, message: { content: " Shiva" } })}\n`,
        );
        response.end(`${JSON.stringify({ done: true })}\n`);
      }, 25);
    });
  });
  context.after(() => closeServer(upstream));

  const baseUrl = await listenOnRandomPort(upstream);
  const provider = createProvider(baseUrl, 1_000);
  const messages = [{ role: "user" as const, content: "Hello" }];

  const streamedChunks: string[] = [];
  for await (const chunk of provider.streamChat({ messages })) {
    streamedChunks.push(chunk.content);
  }
  assert.deepEqual(streamedChunks, ["Hello", " Shiva"]);

  const collected = await provider.chat({ messages });
  assert.deepEqual(collected, { content: "Hello Shiva" });
  assert.equal(requestBodies.length, 2);
  assert.deepEqual(acceptHeaders, [
    "application/x-ndjson",
    "application/x-ndjson",
  ]);
  for (const requestBody of requestBodies) {
    assert.equal(isRecord(requestBody) && requestBody.stream, true);
    assert.equal(isRecord(requestBody) && requestBody.think, false);
  }
});

test("the provider sends the infinite keep-alive sentinel as a number", async (context) => {
  let requestBody: unknown;
  const upstream = createServer((request, response) => {
    const bodyParts: Buffer[] = [];
    request.on("data", (part: Buffer) => bodyParts.push(part));
    request.on("end", () => {
      requestBody = JSON.parse(
        Buffer.concat(bodyParts).toString("utf8"),
      ) as unknown;
      response.setHeader("content-type", "application/x-ndjson");
      response.write(
        `${JSON.stringify({ done: false, message: { content: "Ready" } })}\n`,
      );
      response.end(`${JSON.stringify({ done: true })}\n`);
    });
  });
  context.after(() => closeServer(upstream));

  await createProvider(await listenOnRandomPort(upstream), 1_000, -1).chat({
    messages: [{ role: "user", content: "Hello" }],
  });

  assert.ok(isRecord(requestBody));
  assert.equal(requestBody.keep_alive, -1);
  assert.equal(typeof requestBody.keep_alive, "number");
});

test("the provider forwards a message's images to Ollama untouched", async (context) => {
  let requestBody: unknown;
  const upstream = createServer((request, response) => {
    const bodyParts: Buffer[] = [];
    request.on("data", (part: Buffer) => bodyParts.push(part));
    request.on("end", () => {
      requestBody = JSON.parse(Buffer.concat(bodyParts).toString("utf8")) as unknown;
      response.setHeader("content-type", "application/x-ndjson");
      response.write(
        `${JSON.stringify({ done: false, message: { content: "A cat." } })}\n`,
      );
      response.end(`${JSON.stringify({ done: true })}\n`);
    });
  });
  context.after(() => closeServer(upstream));

  await createProvider(await listenOnRandomPort(upstream), 1_000).chat({
    messages: [
      { role: "user", content: "Describe this.", images: ["ZmFrZS1qcGVn"] },
    ],
  });

  assert.ok(isRecord(requestBody));
  const messages = requestBody.messages;
  assert.ok(Array.isArray(messages));
  assert.deepEqual((messages[0] as { images?: string[] }).images, ["ZmFrZS1qcGVn"]);
});

test("the provider forwards an explicit temperature and omits it by default", async (context) => {
  const requestBodies: unknown[] = [];
  const upstream = createServer((request, response) => {
    const bodyParts: Buffer[] = [];
    request.on("data", (part: Buffer) => bodyParts.push(part));
    request.on("end", () => {
      requestBodies.push(
        JSON.parse(Buffer.concat(bodyParts).toString("utf8")) as unknown,
      );
      response.setHeader("content-type", "application/x-ndjson");
      response.write(
        `${JSON.stringify({ done: false, message: { content: "Ready" } })}\n`,
      );
      response.end(`${JSON.stringify({ done: true })}\n`);
    });
  });
  context.after(() => closeServer(upstream));
  const provider = createProvider(await listenOnRandomPort(upstream), 1_000);

  await provider.chat({
    messages: [{ role: "user", content: "Decide." }],
    temperature: 0,
  });
  await provider.chat({ messages: [{ role: "user", content: "Chat." }] });

  const [withTemperature, withoutTemperature] = requestBodies;
  assert.ok(isRecord(withTemperature) && isRecord(withTemperature.options));
  assert.equal(withTemperature.options.temperature, 0);
  assert.ok(isRecord(withoutTemperature) && isRecord(withoutTemperature.options));
  assert.equal("temperature" in withoutTemperature.options, false);
});

test("the provider distinguishes caller cancellation from its deadline", async (context) => {
  const upstream = createServer((request, response) => {
    request.resume();
    setTimeout(() => {
      if (!response.destroyed) {
        response.setHeader("content-type", "application/x-ndjson");
        response.end(
          `${JSON.stringify({ done: true, message: { content: "Delayed response" } })}\n`,
        );
      }
    }, 150);
  });
  context.after(() => closeServer(upstream));

  const baseUrl = await listenOnRandomPort(upstream);
  const messages = [{ role: "user" as const, content: "Hello" }];

  const callerController = new AbortController();
  const callerCancelledRequest = createProvider(baseUrl, 1_000).chat({
    messages,
    signal: callerController.signal,
  });
  callerController.abort();
  await expectProviderFailure(callerCancelledRequest, "CANCELLED");

  await expectProviderFailure(
    createProvider(baseUrl, 25).chat({ messages }),
    "TIMEOUT",
  );
});

test("the provider forwards a JSON Schema for structured output", async (context) => {
  let requestBody: unknown;
  const upstream = createServer((request, response) => {
    const bodyParts: Buffer[] = [];
    request.on("data", (part: Buffer) => bodyParts.push(part));
    request.on("end", () => {
      requestBody = JSON.parse(
        Buffer.concat(bodyParts).toString("utf8"),
      ) as unknown;
      response.setHeader("content-type", "application/x-ndjson");
      response.write(
        `${JSON.stringify({ done: false, message: { content: '{"memories":[]}' } })}\n`,
      );
      response.end(`${JSON.stringify({ done: true })}\n`);
    });
  });
  context.after(() => closeServer(upstream));
  const format = {
    type: "object",
    properties: {
      memories: { type: "array", items: { type: "object" } },
    },
    required: ["memories"],
  } as const;

  await createProvider(await listenOnRandomPort(upstream), 1_000).chat({
    messages: [{ role: "user", content: "Extract memory." }],
    responseFormat: format,
  });

  assert.ok(isRecord(requestBody));
  assert.deepEqual(requestBody.format, format);
  assert.ok(isRecord(requestBody.options));
  assert.equal(requestBody.options.temperature, undefined);
});

test("the provider falls back to JSON mode when Ollama rejects a schema", async (context) => {
  const formats: unknown[] = [];
  const upstream = createServer((request, response) => {
    const bodyParts: Buffer[] = [];
    request.on("data", (part: Buffer) => bodyParts.push(part));
    request.on("end", () => {
      const body = JSON.parse(
        Buffer.concat(bodyParts).toString("utf8"),
      ) as unknown;
      formats.push(isRecord(body) ? body.format : undefined);

      if (formats.length === 1) {
        response.statusCode = 400;
        response.end('{"error":"schema unsupported"}');
        return;
      }

      response.setHeader("content-type", "application/x-ndjson");
      response.write(
        `${JSON.stringify({ done: false, message: { content: '{"memories":[]}' } })}\n`,
      );
      response.end(`${JSON.stringify({ done: true })}\n`);
    });
  });
  context.after(() => closeServer(upstream));
  const format = {
    type: "object",
    properties: { memories: { type: "array" } },
    required: ["memories"],
  } as const;

  const result = await createProvider(
    await listenOnRandomPort(upstream),
    1_000,
  ).chat({
    messages: [{ role: "user", content: "Extract memory." }],
    responseFormat: format,
  });

  assert.equal(result.content, '{"memories":[]}');
  assert.deepEqual(formats, [format, "json"]);
});

test("the provider rejects malformed or incomplete streams", async (context) => {
  let responseMode: "malformed" | "incomplete" = "malformed";
  const upstream = createServer((request, response) => {
    request.resume();
    response.setHeader("content-type", "application/x-ndjson");

    if (responseMode === "malformed") {
      response.end("not-json\n");
      return;
    }

    response.end(
      `${JSON.stringify({ done: false, message: { content: "Partial" } })}\n`,
    );
  });
  context.after(() => closeServer(upstream));

  const provider = createProvider(await listenOnRandomPort(upstream), 1_000);
  const messages = [{ role: "user" as const, content: "Hello" }];

  await expectProviderFailure(
    provider.chat({ messages }),
    "INVALID_RESPONSE",
  );
  responseMode = "incomplete";
  await expectProviderFailure(
    provider.chat({ messages }),
    "INVALID_RESPONSE",
  );
});

function createProvider(
  baseUrl: string,
  requestTimeoutMs: number,
  keepAlive: string | number = "30m",
): OllamaProvider {
  return new OllamaProvider({
    baseUrl,
    model: "test-model",
    contextLength: 16_384,
    keepAlive,
    requestTimeoutMs,
  });
}

async function listenOnRandomPort(
  server: ReturnType<typeof createServer>,
): Promise<string> {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address() as AddressInfo;
  return `http://127.0.0.1:${address.port}`;
}

async function closeServer(
  server: ReturnType<typeof createServer>,
): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}

async function expectProviderFailure(
  request: Promise<unknown>,
  expectedFailure: AIProviderFailure,
): Promise<void> {
  await assert.rejects(
    request,
    (error: unknown) =>
      error instanceof AIProviderError && error.failure === expectedFailure,
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
