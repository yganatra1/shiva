import assert from "node:assert/strict";
import { test } from "node:test";

import {
  DocsClientError,
  GoogleDocsClient,
  docsErrorToFailure,
  type GoogleAccessTokenProvider,
} from "../src/tools/docs/client.js";

class FakeTokenProvider implements GoogleAccessTokenProvider {
  calls = 0;

  async getAccessToken(signal?: AbortSignal): Promise<string> {
    this.calls += 1;
    signal?.throwIfAborted();
    return "private-access-token";
  }
}

function client(fetchFunction: typeof fetch, tokenProvider = new FakeTokenProvider()) {
  return new GoogleDocsClient({
    accessTokenProvider: tokenProvider,
    requestTimeoutMs: 1_000,
    fetchFunction,
  });
}

function jsonResponse(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "content-type": "application/json" },
  });
}

test("createDocument with no initialText sends only the create request", async () => {
  const requests: Array<{ url: string; init: RequestInit | undefined }> = [];
  const docs = client(async (input, init) => {
    requests.push({ url: String(input), init });
    return jsonResponse({ documentId: "doc-1" });
  });

  const result = await docs.createDocument({ title: "Meeting Notes" });

  assert.deepEqual(result, {
    documentId: "doc-1",
    title: "Meeting Notes",
    url: "https://docs.google.com/document/d/doc-1/edit",
  });
  assert.equal(requests.length, 1);
  const createRequest = requests[0];
  assert.ok(createRequest);
  assert.match(createRequest.url, /\/v1\/documents$/);
  assert.equal(
    new Headers(createRequest.init?.headers).get("authorization"),
    "Bearer private-access-token",
  );
  assert.deepEqual(JSON.parse(String(createRequest.init?.body)), {
    title: "Meeting Notes",
  });
});

test("createDocument with initialText follows up with one batchUpdate insertText at the end of the segment", async () => {
  const requests: Array<{ url: string; init: RequestInit | undefined }> = [];
  const docs = client(async (input, init) => {
    requests.push({ url: String(input), init });
    return jsonResponse({ documentId: "doc-2" });
  });

  await docs.createDocument({ title: "Notes", initialText: "Hello world" });

  assert.equal(requests.length, 2);
  const batchRequest = requests[1];
  assert.ok(batchRequest);
  assert.match(batchRequest.url, /\/v1\/documents\/doc-2:batchUpdate$/);
  assert.deepEqual(JSON.parse(String(batchRequest.init?.body)), {
    requests: [{ insertText: { endOfSegmentLocation: {}, text: "Hello world" } }],
  });
});

test("createDocument rejects an empty or oversized title before any request", async () => {
  let called = false;
  const docs = client(async () => {
    called = true;
    return jsonResponse({ documentId: "unused" });
  });

  await assert.rejects(
    () => docs.createDocument({ title: "  " }),
    (error: unknown) => error instanceof DocsClientError && error.failure === "INVALID_INPUT",
  );
  await assert.rejects(
    () => docs.createDocument({ title: "x".repeat(201) }),
    (error: unknown) => error instanceof DocsClientError && error.failure === "INVALID_INPUT",
  );
  assert.equal(called, false);
});

test("updateDocument append sends one batchUpdate insertText at the end of the segment, no read first", async () => {
  const requests: Array<{ url: string; init: RequestInit | undefined }> = [];
  const docs = client(async (input, init) => {
    requests.push({ url: String(input), init });
    return jsonResponse({});
  });

  const result = await docs.updateDocument({
    documentId: "doc-3",
    text: "more text",
    mode: "append",
  });

  assert.deepEqual(result, { documentId: "doc-3", mode: "append" });
  assert.equal(requests.length, 1);
  assert.match(String(requests[0]?.url), /:batchUpdate$/);
  assert.deepEqual(JSON.parse(String(requests[0]?.init?.body)), {
    requests: [{ insertText: { endOfSegmentLocation: {}, text: "more text" } }],
  });
});

test("updateDocument replace reads the current end index, then deletes and reinserts in one batchUpdate", async () => {
  const requests: Array<{ url: string; init: RequestInit | undefined }> = [];
  const docs = client(async (input, init) => {
    const url = String(input);
    requests.push({ url, init });
    if (url.includes(":batchUpdate")) return jsonResponse({});
    return jsonResponse({ body: { content: [{ endIndex: 42 }] } });
  });

  const result = await docs.updateDocument({
    documentId: "doc-4",
    text: "brand new body",
    mode: "replace",
  });

  assert.deepEqual(result, { documentId: "doc-4", mode: "replace" });
  assert.equal(requests.length, 2);
  assert.match(String(requests[0]?.url), /\/v1\/documents\/doc-4\?/);
  const batchBody = JSON.parse(String(requests[1]?.init?.body)) as {
    requests: unknown[];
  };
  assert.deepEqual(batchBody.requests, [
    { deleteContentRange: { range: { startIndex: 1, endIndex: 41 } } },
    { insertText: { location: { index: 1 }, text: "brand new body" } },
  ]);
});

test("updateDocument replace on an empty document skips deleteContentRange", async () => {
  const requests: Array<{ url: string; init: RequestInit | undefined }> = [];
  const docs = client(async (input, init) => {
    const url = String(input);
    requests.push({ url, init });
    if (url.includes(":batchUpdate")) return jsonResponse({});
    return jsonResponse({ body: { content: [{ endIndex: 1 }] } });
  });

  await docs.updateDocument({ documentId: "doc-5", text: "first content", mode: "replace" });

  const batchBody = JSON.parse(String(requests[1]?.init?.body)) as {
    requests: unknown[];
  };
  assert.deepEqual(batchBody.requests, [
    { insertText: { location: { index: 1 }, text: "first content" } },
  ]);
});

test("a 403 response maps to an AUTH failure with Google's own error detail", async () => {
  const docs = client(async () =>
    new Response(JSON.stringify({ error: { message: "insufficient scope" } }), {
      status: 403,
      headers: { "content-type": "application/json" },
    }),
  );

  const error = await docs.createDocument({ title: "Notes" }).catch((e: unknown) => e);
  assert.ok(error instanceof DocsClientError);
  assert.equal(error.failure, "AUTH");
  assert.match(error.message, /insufficient scope/);

  const failure = docsErrorToFailure(error);
  assert.equal(failure.code, "DOCS_AUTH_FAILED");
});
