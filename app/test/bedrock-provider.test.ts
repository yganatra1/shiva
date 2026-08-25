import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { test } from "node:test";

import {
  AIProviderError,
  type AIProviderFailure,
} from "../src/brain/ai-provider.js";
import { BedrockProvider } from "../src/brain/bedrock-provider.js";

function encodeEventStreamMessage(
  headers: Record<string, string>,
  payload: unknown,
): Buffer {
  const headerBuffers = Object.entries(headers).map(([name, value]) => {
    const nameBuf = Buffer.from(name, "utf8");
    const valueBuf = Buffer.from(value, "utf8");
    const buf = Buffer.alloc(1 + nameBuf.length + 1 + 2 + valueBuf.length);
    let offset = 0;
    buf.writeUInt8(nameBuf.length, offset);
    offset += 1;
    nameBuf.copy(buf, offset);
    offset += nameBuf.length;
    buf.writeUInt8(7, offset); // string type
    offset += 1;
    buf.writeUInt16BE(valueBuf.length, offset);
    offset += 2;
    valueBuf.copy(buf, offset);
    return buf;
  });
  const headersBuf = Buffer.concat(headerBuffers);
  const payloadBuf = Buffer.from(JSON.stringify(payload), "utf8");
  const totalLength = 12 + headersBuf.length + payloadBuf.length + 4;

  const prelude = Buffer.alloc(12);
  prelude.writeUInt32BE(totalLength, 0);
  prelude.writeUInt32BE(headersBuf.length, 4);
  // Prelude CRC (bytes 8-11) is left as zero; the provider doesn't verify it.

  return Buffer.concat([prelude, headersBuf, payloadBuf, Buffer.alloc(4)]);
}

function contentBlockDeltaFrame(delta: Record<string, unknown>): Buffer {
  return encodeEventStreamMessage(
    { ":message-type": "event", ":event-type": "contentBlockDelta" },
    { contentBlockIndex: 0, delta },
  );
}

function messageStopFrame(): Buffer {
  return encodeEventStreamMessage(
    { ":message-type": "event", ":event-type": "messageStop" },
    { stopReason: "end_turn" },
  );
}

function exceptionFrame(exceptionType: string, message: string): Buffer {
  return encodeEventStreamMessage(
    { ":message-type": "exception", ":exception-type": exceptionType },
    { message },
  );
}

test("the provider decodes event-stream frames and chat() collects them", async (context) => {
  const requestBodies: unknown[] = [];
  const authHeaders: Array<string | undefined> = [];
  const requestPaths: string[] = [];
  const upstream = createServer((request, response) => {
    const bodyParts: Buffer[] = [];
    request.on("data", (part: Buffer) => bodyParts.push(part));
    request.on("end", () => {
      authHeaders.push(request.headers.authorization);
      requestPaths.push(request.url ?? "");
      requestBodies.push(
        JSON.parse(Buffer.concat(bodyParts).toString("utf8")) as unknown,
      );
      response.end(
        Buffer.concat([
          contentBlockDeltaFrame({ text: "Hello" }),
          contentBlockDeltaFrame({ text: " Shiva" }),
          messageStopFrame(),
        ]),
      );
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
  assert.ok(requestPaths[0]?.includes("/model/test.model-id%3A0/converse-stream"));
  for (const authHeader of authHeaders) {
    assert.ok(authHeader?.startsWith("AWS4-HMAC-SHA256 Credential=test-access-key/"));
  }
  for (const requestBody of requestBodies) {
    assert.ok(isRecord(requestBody));
    assert.deepEqual(requestBody.messages, [
      { role: "user", content: [{ text: "Hello" }] },
    ]);
  }
});

test("the provider folds system messages, forwards images, and surfaces reasoning deltas", async (context) => {
  let requestBody: unknown;
  const upstream = createServer((request, response) => {
    const bodyParts: Buffer[] = [];
    request.on("data", (part: Buffer) => bodyParts.push(part));
    request.on("end", () => {
      requestBody = JSON.parse(Buffer.concat(bodyParts).toString("utf8")) as unknown;
      response.end(
        Buffer.concat([
          contentBlockDeltaFrame({ reasoningContent: { text: "Thinking..." } }),
          contentBlockDeltaFrame({ text: "A cat." }),
          messageStopFrame(),
        ]),
      );
    });
  });
  context.after(() => closeServer(upstream));

  const result = await createProvider(await listenOnRandomPort(upstream), 1_000).chat({
    messages: [
      { role: "system", content: "Be concise." },
      { role: "user", content: "Describe this.", images: ["ZmFrZS1qcGVn"] },
      { role: "assistant", content: "OK." },
    ],
  });

  assert.deepEqual(result, { content: "A cat.", thinking: "Thinking..." });
  assert.ok(isRecord(requestBody));
  assert.deepEqual(requestBody.system, [{ text: "Be concise." }]);
  assert.deepEqual(requestBody.messages, [
    {
      role: "user",
      content: [
        { text: "Describe this." },
        { image: { format: "jpeg", source: { bytes: "ZmFrZS1qcGVn" } } },
      ],
    },
    { role: "assistant", content: [{ text: "OK." }] },
  ]);
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
      response.end(
        Buffer.concat([contentBlockDeltaFrame({ text: "Ready" }), messageStopFrame()]),
      );
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
  assert.ok(isRecord(withTemperature) && isRecord(withTemperature.inferenceConfig));
  assert.equal(withTemperature.inferenceConfig.temperature, 0);
  assert.ok(isRecord(withoutTemperature));
  assert.equal("inferenceConfig" in withoutTemperature, false);
});

test("a JSON Schema responseFormat is asked for through a system instruction", async (context) => {
  let requestBody: unknown;
  const upstream = createServer((request, response) => {
    const bodyParts: Buffer[] = [];
    request.on("data", (part: Buffer) => bodyParts.push(part));
    request.on("end", () => {
      requestBody = JSON.parse(Buffer.concat(bodyParts).toString("utf8")) as unknown;
      response.end(
        Buffer.concat([
          contentBlockDeltaFrame({ text: '{"memories":[]}' }),
          messageStopFrame(),
        ]),
      );
    });
  });
  context.after(() => closeServer(upstream));
  const format = {
    type: "object",
    properties: { memories: { type: "array", items: { type: "object" } } },
    required: ["memories"],
  } as const;

  await createProvider(await listenOnRandomPort(upstream), 1_000).chat({
    messages: [{ role: "user", content: "Extract memory." }],
    responseFormat: format,
  });

  assert.ok(isRecord(requestBody));
  assert.deepEqual(requestBody.system, [
    {
      text: `Respond with a single valid JSON object matching this exact JSON Schema, and no other text or markdown: ${JSON.stringify(format)}`,
    },
  ]);
});

test("a bearer-token credential sends a plain Authorization header instead of a SigV4 signature", async (context) => {
  const authHeaders: Array<string | undefined> = [];
  const upstream = createServer((request, response) => {
    request.resume();
    authHeaders.push(request.headers.authorization);
    response.end(
      Buffer.concat([contentBlockDeltaFrame({ text: "Hi" }), messageStopFrame()]),
    );
  });
  context.after(() => closeServer(upstream));

  await createBearerTokenProvider(await listenOnRandomPort(upstream), 1_000).chat({
    messages: [{ role: "user", content: "Hello" }],
  });

  assert.deepEqual(authHeaders, ["Bearer test-bearer-token"]);
});

test("the provider distinguishes caller cancellation from its deadline", async (context) => {
  const upstream = createServer((request, response) => {
    request.resume();
    setTimeout(() => {
      if (!response.destroyed) {
        response.end(
          Buffer.concat([
            contentBlockDeltaFrame({ text: "Delayed" }),
            messageStopFrame(),
          ]),
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

test("an in-stream exception frame surfaces its own detail text", async (context) => {
  const upstream = createServer((request, response) => {
    request.resume();
    response.end(
      Buffer.concat([
        contentBlockDeltaFrame({ text: "Partial" }),
        exceptionFrame("throttlingException", "Too many requests"),
      ]),
    );
  });
  context.after(() => closeServer(upstream));

  const provider = createProvider(await listenOnRandomPort(upstream), 1_000);

  await assert.rejects(
    provider.chat({ messages: [{ role: "user", content: "Hello" }] }),
    (error: unknown) =>
      error instanceof AIProviderError &&
      error.failure === "UPSTREAM_ERROR" &&
      error.message.includes("Too many requests") &&
      error.message.includes("throttlingException"),
  );
});

test("a non-2xx HTTP status surfaces Bedrock's own error body", async (context) => {
  const upstream = createServer((request, response) => {
    request.resume();
    response.statusCode = 403;
    response.end('{"message":"The security token included in the request is invalid."}');
  });
  context.after(() => closeServer(upstream));

  const provider = createProvider(await listenOnRandomPort(upstream), 1_000);

  await assert.rejects(
    provider.chat({ messages: [{ role: "user", content: "Hello" }] }),
    (error: unknown) =>
      error instanceof AIProviderError &&
      error.failure === "UPSTREAM_ERROR" &&
      error.message.includes("security token"),
  );
});

test("the provider rejects a stream that ends before a messageStop event", async (context) => {
  const upstream = createServer((request, response) => {
    request.resume();
    response.end(contentBlockDeltaFrame({ text: "Partial" }));
  });
  context.after(() => closeServer(upstream));

  const provider = createProvider(await listenOnRandomPort(upstream), 1_000);
  await expectProviderFailure(
    provider.chat({ messages: [{ role: "user", content: "Hello" }] }),
    "INVALID_RESPONSE",
  );
});

function createProvider(baseUrl: string, requestTimeoutMs: number): BedrockProvider {
  return new BedrockProvider({
    credentials: {
      type: "sigv4",
      accessKeyId: "test-access-key",
      secretAccessKey: "test-secret-key",
    },
    region: "us-east-1",
    model: "test.model-id:0",
    requestTimeoutMs,
    baseUrl,
  });
}

function createBearerTokenProvider(
  baseUrl: string,
  requestTimeoutMs: number,
): BedrockProvider {
  return new BedrockProvider({
    credentials: { type: "bearer", token: "test-bearer-token" },
    region: "us-east-1",
    model: "test.model-id:0",
    requestTimeoutMs,
    baseUrl,
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
