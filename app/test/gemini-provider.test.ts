import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { test } from "node:test";

import {
  AIProviderError,
  type AIProviderFailure,
} from "../src/brain/ai-provider.js";
import { GeminiProvider } from "../src/brain/gemini-provider.js";

function sseEvent(payload: unknown): string {
  return `data: ${JSON.stringify(payload)}\n\n`;
}

test("the provider streams SSE chunks and chat() collects them", async (context) => {
  const requestBodies: unknown[] = [];
  const apiKeyHeaders: Array<string | undefined> = [];
  const upstream = createServer((request, response) => {
    const bodyParts: Buffer[] = [];
    request.on("data", (part: Buffer) => bodyParts.push(part));
    request.on("end", () => {
      apiKeyHeaders.push(request.headers["x-goog-api-key"] as string | undefined);
      requestBodies.push(
        JSON.parse(Buffer.concat(bodyParts).toString("utf8")) as unknown,
      );
      response.setHeader("content-type", "text/event-stream");
      response.write(
        sseEvent({ candidates: [{ content: { parts: [{ text: "Hello" }] } }] }),
      );
      setTimeout(() => {
        response.write(
          sseEvent({
            candidates: [
              { content: { parts: [{ text: " Shiva" }] }, finishReason: "STOP" },
            ],
          }),
        );
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
  assert.deepEqual(apiKeyHeaders, ["test-api-key", "test-api-key"]);
  for (const requestBody of requestBodies) {
    assert.ok(isRecord(requestBody));
    assert.deepEqual(requestBody.contents, [
      { role: "user", parts: [{ text: "Hello" }] },
    ]);
  }
});

test("the provider disables thinking by default so it can't consume the whole output budget", async (context) => {
  let requestBody: unknown;
  const upstream = createServer((request, response) => {
    const bodyParts: Buffer[] = [];
    request.on("data", (part: Buffer) => bodyParts.push(part));
    request.on("end", () => {
      requestBody = JSON.parse(Buffer.concat(bodyParts).toString("utf8")) as unknown;
      response.setHeader("content-type", "text/event-stream");
      response.end(
        sseEvent({
          candidates: [
            { content: { parts: [{ text: "Ready" }] }, finishReason: "STOP" },
          ],
        }),
      );
    });
  });
  context.after(() => closeServer(upstream));

  await createProvider(await listenOnRandomPort(upstream), 1_000).chat({
    messages: [{ role: "user", content: "Hello" }],
  });

  assert.ok(isRecord(requestBody) && isRecord(requestBody.generationConfig));
  assert.deepEqual(requestBody.generationConfig.thinkingConfig, {
    thinkingLevel: "minimal",
  });
});

test("the provider surfaces thinking deltas separately from content", async (context) => {
  const upstream = createServer((request, response) => {
    request.resume();
    response.setHeader("content-type", "text/event-stream");
    response.write(
      sseEvent({
        candidates: [
          { content: { parts: [{ text: "Let me ", thought: true }] } },
        ],
      }),
    );
    response.write(
      sseEvent({
        candidates: [
          {
            content: { parts: [{ text: "think.", thought: true }] },
          },
        ],
      }),
    );
    response.end(
      sseEvent({
        candidates: [
          { content: { parts: [{ text: "Answer" }] }, finishReason: "STOP" },
        ],
      }),
    );
  });
  context.after(() => closeServer(upstream));

  const provider = createProvider(await listenOnRandomPort(upstream), 1_000);
  const messages = [{ role: "user" as const, content: "Hello" }];

  const chunks: Array<{ content: string; thinking?: string }> = [];
  for await (const chunk of provider.streamChat({ messages })) {
    chunks.push(chunk);
  }
  assert.deepEqual(chunks, [
    { content: "", thinking: "Let me " },
    { content: "", thinking: "think." },
    { content: "Answer" },
  ]);

  const result = await provider.chat({ messages });
  assert.deepEqual(result, { content: "Answer", thinking: "Let me think." });
});

test("a thinking-only stream is not misreported as empty by streamChat, even though chat() still requires real content", async (context) => {
  const upstream = createServer((request, response) => {
    request.resume();
    response.setHeader("content-type", "text/event-stream");
    response.end(
      sseEvent({
        candidates: [
          {
            content: { parts: [{ text: "Hmm.", thought: true }] },
            finishReason: "STOP",
          },
        ],
      }),
    );
  });
  context.after(() => closeServer(upstream));

  const provider = createProvider(await listenOnRandomPort(upstream), 1_000);
  const messages = [{ role: "user" as const, content: "Hello" }];

  const chunks: Array<{ content: string; thinking?: string }> = [];
  for await (const chunk of provider.streamChat({ messages })) {
    chunks.push(chunk);
  }
  assert.deepEqual(chunks, [{ content: "", thinking: "Hmm." }]);

  await expectProviderFailure(provider.chat({ messages }), "INVALID_RESPONSE");
});

test("the provider maps roles, folds system messages into systemInstruction, and forwards images", async (context) => {
  let requestBody: unknown;
  const upstream = createServer((request, response) => {
    const bodyParts: Buffer[] = [];
    request.on("data", (part: Buffer) => bodyParts.push(part));
    request.on("end", () => {
      requestBody = JSON.parse(Buffer.concat(bodyParts).toString("utf8")) as unknown;
      response.setHeader("content-type", "text/event-stream");
      response.end(
        sseEvent({
          candidates: [
            { content: { parts: [{ text: "A cat." }] }, finishReason: "STOP" },
          ],
        }),
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
  assert.deepEqual(requestBody.systemInstruction, {
    parts: [{ text: "Be concise." }],
  });
  assert.deepEqual(requestBody.contents, [
    {
      role: "user",
      parts: [
        { text: "Describe this." },
        { inlineData: { mimeType: "image/jpeg", data: "ZmFrZS1qcGVn" } },
      ],
    },
    { role: "model", parts: [{ text: "OK." }] },
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
          candidates: [
            { content: { parts: [{ text: "Ready" }] }, finishReason: "STOP" },
          ],
        }),
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
  assert.ok(isRecord(withTemperature) && isRecord(withTemperature.generationConfig));
  assert.equal(withTemperature.generationConfig.temperature, 0);
  assert.ok(isRecord(withoutTemperature) && isRecord(withoutTemperature.generationConfig));
  assert.equal("temperature" in withoutTemperature.generationConfig, false);
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
      response.setHeader("content-type", "text/event-stream");
      response.end(
        sseEvent({
          candidates: [
            {
              content: { parts: [{ text: '{"memories":[]}' }] },
              finishReason: "STOP",
            },
          ],
        }),
      );
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

  assert.ok(isRecord(requestBody) && isRecord(requestBody.generationConfig));
  assert.equal(requestBody.generationConfig.responseMimeType, "application/json");
  assert.deepEqual(requestBody.generationConfig.responseSchema, format);
});

test("the provider translates const/additionalProperties into what Gemini's schema dialect accepts", async (context) => {
  let requestBody: unknown;
  const upstream = createServer((request, response) => {
    const bodyParts: Buffer[] = [];
    request.on("data", (part: Buffer) => bodyParts.push(part));
    request.on("end", () => {
      requestBody = JSON.parse(
        Buffer.concat(bodyParts).toString("utf8"),
      ) as unknown;
      response.setHeader("content-type", "text/event-stream");
      response.end(
        sseEvent({
          candidates: [
            {
              content: { parts: [{ text: '{"type":"direct_chat"}' }] },
              finishReason: "STOP",
            },
          ],
        }),
      );
    });
  });
  context.after(() => closeServer(upstream));

  // Mirrors ShivaAgentPlanner's decisionResponseFormat: a discriminated union
  // expressed as plain JSON Schema, which is what triggered the real 400
  // ("Unknown name const"/"Unknown name additionalProperties") against Gemini.
  const format = {
    type: "object",
    oneOf: [
      {
        type: "object",
        properties: { type: { type: "string", const: "direct_chat" } },
        required: ["type"],
        additionalProperties: false,
      },
    ],
  } as const;

  await createProvider(await listenOnRandomPort(upstream), 1_000).chat({
    messages: [{ role: "user", content: "Decide." }],
    responseFormat: format,
  });

  assert.ok(isRecord(requestBody) && isRecord(requestBody.generationConfig));
  assert.deepEqual(requestBody.generationConfig.responseSchema, {
    type: "object",
    oneOf: [
      {
        type: "object",
        properties: { type: { type: "string", enum: ["direct_chat"] } },
        required: ["type"],
      },
    ],
  });
});

test("the provider distinguishes caller cancellation from its deadline", async (context) => {
  const upstream = createServer((request, response) => {
    request.resume();
    setTimeout(() => {
      if (!response.destroyed) {
        response.setHeader("content-type", "text/event-stream");
        response.end(
          sseEvent({
            candidates: [
              {
                content: { parts: [{ text: "Delayed response" }] },
                finishReason: "STOP",
              },
            ],
          }),
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

test("an in-stream Gemini error surfaces its own detail text, not just a generic message", async (context) => {
  const upstream = createServer((request, response) => {
    request.resume();
    response.setHeader("content-type", "text/event-stream");
    response.write(
      sseEvent({ candidates: [{ content: { parts: [{ text: "Partial" }] } }] }),
    );
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

test("a blocked prompt is reported as an upstream error", async (context) => {
  const upstream = createServer((request, response) => {
    request.resume();
    response.setHeader("content-type", "text/event-stream");
    response.end(sseEvent({ promptFeedback: { blockReason: "SAFETY" } }));
  });
  context.after(() => closeServer(upstream));

  const provider = createProvider(await listenOnRandomPort(upstream), 1_000);

  await assert.rejects(
    provider.chat({ messages: [{ role: "user", content: "Hello" }] }),
    (error: unknown) =>
      error instanceof AIProviderError &&
      error.failure === "UPSTREAM_ERROR" &&
      error.message.includes("SAFETY"),
  );
});

test("a non-2xx HTTP status surfaces Gemini's own error body", async (context) => {
  const upstream = createServer((request, response) => {
    request.resume();
    response.statusCode = 400;
    response.end('{"error":{"message":"API key not valid"}}');
  });
  context.after(() => closeServer(upstream));

  const provider = createProvider(await listenOnRandomPort(upstream), 1_000);

  await assert.rejects(
    provider.chat({ messages: [{ role: "user", content: "Hello" }] }),
    (error: unknown) =>
      error instanceof AIProviderError &&
      error.failure === "UPSTREAM_ERROR" &&
      error.message.includes("API key not valid"),
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

    response.end(
      sseEvent({ candidates: [{ content: { parts: [{ text: "Partial" }] } }] }),
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

function createProvider(baseUrl: string, requestTimeoutMs: number): GeminiProvider {
  return new GeminiProvider({
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
