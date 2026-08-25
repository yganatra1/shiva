import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { test } from "node:test";

import {
  AIProviderError,
  type AIProviderFailure,
} from "../src/brain/ai-provider.js";
import { OpenAiProvider } from "../src/brain/openai-provider.js";

function sseEvent(payload: unknown): string {
  return `data: ${JSON.stringify(payload)}\n\n`;
}

test("the provider streams SSE chunks and chat() collects them", async (context) => {
  const requestBodies: unknown[] = [];
  const authHeaders: Array<string | undefined> = [];
  const upstream = createServer((request, response) => {
    const bodyParts: Buffer[] = [];
    request.on("data", (part: Buffer) => bodyParts.push(part));
    request.on("end", () => {
      authHeaders.push(request.headers.authorization);
      requestBodies.push(
        JSON.parse(Buffer.concat(bodyParts).toString("utf8")) as unknown,
      );
      response.setHeader("content-type", "text/event-stream");
      response.write(
        sseEvent({ choices: [{ delta: { content: "Hello" } }] }),
      );
      setTimeout(() => {
        response.write(
          sseEvent({
            choices: [{ delta: { content: " Shiva" }, finish_reason: "stop" }],
          }),
        );
        response.write("data: [DONE]\n\n");
        response.end();
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
  assert.deepEqual(authHeaders, ["Bearer test-api-key", "Bearer test-api-key"]);
  for (const requestBody of requestBodies) {
    assert.ok(isRecord(requestBody));
    assert.deepEqual(requestBody.messages, [
      { role: "user", content: "Hello" },
    ]);
    assert.equal(requestBody.model, "test-model");
    assert.equal(requestBody.stream, true);
  }
});

test("the provider forwards roles as-is and attaches images as image_url parts", async (context) => {
  let requestBody: unknown;
  const upstream = createServer((request, response) => {
    const bodyParts: Buffer[] = [];
    request.on("data", (part: Buffer) => bodyParts.push(part));
    request.on("end", () => {
      requestBody = JSON.parse(Buffer.concat(bodyParts).toString("utf8")) as unknown;
      response.setHeader("content-type", "text/event-stream");
      response.end(
        sseEvent({
          choices: [{ delta: { content: "A cat." }, finish_reason: "stop" }],
        }) + "data: [DONE]\n\n",
      );
    });
  });
  context.after(() => closeServer(upstream));

  await createProvider(await listenOnRandomPort(upstream), 1_000).chat({
    messages: [
      { role: "system", content: "Be concise." },
      { role: "user", content: "Describe this.", images: ["ZmFrZS1qcGVn"] },
      { role: "assistant", content: "OK." },
    ],
  });

  assert.ok(isRecord(requestBody));
  assert.deepEqual(requestBody.messages, [
    { role: "system", content: "Be concise." },
    {
      role: "user",
      content: [
        { type: "text", text: "Describe this." },
        {
          type: "image_url",
          image_url: { url: "data:image/jpeg;base64,ZmFrZS1qcGVn" },
        },
      ],
    },
    { role: "assistant", content: "OK." },
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
      response.setHeader("content-type", "text/event-stream");
      response.end(
        sseEvent({
          choices: [{ delta: { content: "Ready" }, finish_reason: "stop" }],
        }) + "data: [DONE]\n\n",
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
  assert.ok(isRecord(withTemperature));
  assert.equal(withTemperature.temperature, 0);
  assert.ok(isRecord(withoutTemperature));
  assert.equal("temperature" in withoutTemperature, false);
});

test("the provider wraps a JSON Schema responseFormat as an OpenAI json_schema response_format", async (context) => {
  let requestBody: unknown;
  const upstream = createServer((request, response) => {
    const bodyParts: Buffer[] = [];
    request.on("data", (part: Buffer) => bodyParts.push(part));
    request.on("end", () => {
      requestBody = JSON.parse(Buffer.concat(bodyParts).toString("utf8")) as unknown;
      response.setHeader("content-type", "text/event-stream");
      response.end(
        sseEvent({
          choices: [
            { delta: { content: '{"memories":[]}' }, finish_reason: "stop" },
          ],
        }) + "data: [DONE]\n\n",
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
  assert.deepEqual(requestBody.response_format, {
    type: "json_schema",
    json_schema: { name: "response", schema: format },
  });
});

test("the provider retries once without temperature when the model rejects it, and still fails other 400s", async (context) => {
  const requestBodies: unknown[] = [];
  let requestCount = 0;
  const upstream = createServer((request, response) => {
    const bodyParts: Buffer[] = [];
    request.on("data", (part: Buffer) => bodyParts.push(part));
    request.on("end", () => {
      requestCount += 1;
      requestBodies.push(
        JSON.parse(Buffer.concat(bodyParts).toString("utf8")) as unknown,
      );
      if (requestCount === 1) {
        response.statusCode = 400;
        response.end(
          JSON.stringify({
            error: {
              message:
                "Unsupported value: 'temperature' does not support 0 with this model. Only the default (1) value is supported.",
              type: "invalid_request_error",
              param: "temperature",
              code: "unsupported_value",
            },
          }),
        );
        return;
      }
      response.setHeader("content-type", "text/event-stream");
      response.end(
        sseEvent({
          choices: [{ delta: { content: "Ready" }, finish_reason: "stop" }],
        }) + "data: [DONE]\n\n",
      );
    });
  });
  context.after(() => closeServer(upstream));

  const result = await createProvider(await listenOnRandomPort(upstream), 1_000).chat({
    messages: [{ role: "user", content: "Decide." }],
    temperature: 0,
  });

  assert.deepEqual(result, { content: "Ready" });
  assert.equal(requestBodies.length, 2);
  assert.ok(isRecord(requestBodies[0]));
  assert.equal(requestBodies[0].temperature, 0);
  assert.ok(isRecord(requestBodies[1]));
  assert.equal("temperature" in requestBodies[1], false);
});

test("a 400 unrelated to temperature is not retried", async (context) => {
  let requestCount = 0;
  const upstream = createServer((request, response) => {
    request.resume();
    request.on("end", () => {
      requestCount += 1;
      response.statusCode = 400;
      response.end(
        JSON.stringify({
          error: { message: "Invalid model.", type: "invalid_request_error" },
        }),
      );
    });
  });
  context.after(() => closeServer(upstream));

  await assert.rejects(
    createProvider(await listenOnRandomPort(upstream), 1_000).chat({
      messages: [{ role: "user", content: "Decide." }],
      temperature: 0,
    }),
    (error: unknown) =>
      error instanceof AIProviderError &&
      error.failure === "UPSTREAM_ERROR" &&
      error.message.includes("Invalid model."),
  );
  assert.equal(requestCount, 1);
});

test("a top-level oneOf schema is nested under a wrapper property, and the wrapped response is unwrapped back out", async (context) => {
  let requestBody: unknown;
  const upstream = createServer((request, response) => {
    const bodyParts: Buffer[] = [];
    request.on("data", (part: Buffer) => bodyParts.push(part));
    request.on("end", () => {
      requestBody = JSON.parse(Buffer.concat(bodyParts).toString("utf8")) as unknown;
      response.setHeader("content-type", "text/event-stream");
      response.end(
        sseEvent({
          choices: [
            {
              delta: { content: '{"value":{"type":"direct_chat"}}' },
              finish_reason: "stop",
            },
          ],
        }) + "data: [DONE]\n\n",
      );
    });
  });
  context.after(() => closeServer(upstream));

  // Mirrors ShivaAgentPlanner's decisionResponseFormat: a discriminated union
  // expressed as a top-level oneOf, which OpenAI rejects outright ("schema
  // must have type 'object' and not have 'oneOf'/... at the top level").
  const format = {
    type: "object",
    oneOf: [
      {
        type: "object",
        properties: { type: { type: "string", const: "direct_chat" } },
        required: ["type"],
      },
    ],
  } as const;

  const result = await createProvider(await listenOnRandomPort(upstream), 1_000).chat({
    messages: [{ role: "user", content: "Decide." }],
    responseFormat: format,
  });

  assert.deepEqual(result, { content: '{"type":"direct_chat"}' });
  assert.ok(isRecord(requestBody) && isRecord(requestBody.response_format));
  assert.deepEqual(requestBody.response_format, {
    type: "json_schema",
    json_schema: {
      name: "response",
      schema: { type: "object", properties: { value: format }, required: ["value"] },
    },
  });
});

test("an object-typed responseFormat without a rejected top-level keyword is sent unwrapped", async (context) => {
  let requestBody: unknown;
  const upstream = createServer((request, response) => {
    const bodyParts: Buffer[] = [];
    request.on("data", (part: Buffer) => bodyParts.push(part));
    request.on("end", () => {
      requestBody = JSON.parse(Buffer.concat(bodyParts).toString("utf8")) as unknown;
      response.setHeader("content-type", "text/event-stream");
      response.end(
        sseEvent({
          choices: [{ delta: { content: '{"memories":[]}' }, finish_reason: "stop" }],
        }) + "data: [DONE]\n\n",
      );
    });
  });
  context.after(() => closeServer(upstream));
  const format = {
    type: "object",
    properties: { memories: { type: "array", items: { type: "object" } } },
    required: ["memories"],
  } as const;

  const result = await createProvider(await listenOnRandomPort(upstream), 1_000).chat({
    messages: [{ role: "user", content: "Extract memory." }],
    responseFormat: format,
  });

  assert.deepEqual(result, { content: '{"memories":[]}' });
  assert.ok(isRecord(requestBody) && isRecord(requestBody.response_format));
  assert.deepEqual(requestBody.response_format, {
    type: "json_schema",
    json_schema: { name: "response", schema: format },
  });
});

test("a plain 'json' responseFormat becomes json_object mode", async (context) => {
  let requestBody: unknown;
  const upstream = createServer((request, response) => {
    request.resume();
    const bodyParts: Buffer[] = [];
    request.on("data", (part: Buffer) => bodyParts.push(part));
    request.on("end", () => {
      requestBody = JSON.parse(Buffer.concat(bodyParts).toString("utf8")) as unknown;
      response.setHeader("content-type", "text/event-stream");
      response.end(
        sseEvent({
          choices: [{ delta: { content: "{}" }, finish_reason: "stop" }],
        }) + "data: [DONE]\n\n",
      );
    });
  });
  context.after(() => closeServer(upstream));

  await createProvider(await listenOnRandomPort(upstream), 1_000).chat({
    messages: [{ role: "user", content: "Go." }],
    responseFormat: "json",
  });

  assert.ok(isRecord(requestBody));
  assert.deepEqual(requestBody.response_format, { type: "json_object" });
});

test("the provider distinguishes caller cancellation from its deadline", async (context) => {
  const upstream = createServer((request, response) => {
    request.resume();
    setTimeout(() => {
      if (!response.destroyed) {
        response.setHeader("content-type", "text/event-stream");
        response.end(
          sseEvent({
            choices: [
              { delta: { content: "Delayed" }, finish_reason: "stop" },
            ],
          }) + "data: [DONE]\n\n",
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

test("an in-stream OpenAI error surfaces its own detail text, not just a generic message", async (context) => {
  const upstream = createServer((request, response) => {
    request.resume();
    response.setHeader("content-type", "text/event-stream");
    response.write(sseEvent({ choices: [{ delta: { content: "Partial" } }] }));
    response.end(sseEvent({ error: { message: "model overloaded" } }));
  });
  context.after(() => closeServer(upstream));

  const provider = createProvider(await listenOnRandomPort(upstream), 1_000);

  await assert.rejects(
    provider.chat({ messages: [{ role: "user", content: "Hello" }] }),
    (error: unknown) =>
      error instanceof AIProviderError &&
      error.failure === "UPSTREAM_ERROR" &&
      error.message.includes("model overloaded"),
  );
});

test("a non-2xx HTTP status surfaces OpenAI's own error body", async (context) => {
  const upstream = createServer((request, response) => {
    request.resume();
    response.statusCode = 401;
    response.end('{"error":{"message":"Incorrect API key provided"}}');
  });
  context.after(() => closeServer(upstream));

  const provider = createProvider(await listenOnRandomPort(upstream), 1_000);

  await assert.rejects(
    provider.chat({ messages: [{ role: "user", content: "Hello" }] }),
    (error: unknown) =>
      error instanceof AIProviderError &&
      error.failure === "UPSTREAM_ERROR" &&
      error.message.includes("Incorrect API key provided"),
  );
});

test("the provider rejects malformed or incomplete streams", async (context) => {
  let responseMode: "malformed" | "incomplete" = "malformed";
  const upstream = createServer((request, response) => {
    request.resume();
    response.setHeader("content-type", "text/event-stream");

    if (responseMode === "malformed") {
      response.end("data: not-json\n\n");
      return;
    }

    response.end(sseEvent({ choices: [{ delta: { content: "Partial" } }] }));
  });
  context.after(() => closeServer(upstream));

  const provider = createProvider(await listenOnRandomPort(upstream), 1_000);
  const messages = [{ role: "user" as const, content: "Hello" }];

  await expectProviderFailure(provider.chat({ messages }), "INVALID_RESPONSE");
  responseMode = "incomplete";
  await expectProviderFailure(provider.chat({ messages }), "INVALID_RESPONSE");
});

function createProvider(baseUrl: string, requestTimeoutMs: number): OpenAiProvider {
  return new OpenAiProvider({
    apiKey: "test-api-key",
    model: "test-model",
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
