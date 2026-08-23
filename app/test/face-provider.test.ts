import assert from "node:assert/strict";
import { test } from "node:test";

import { HttpFaceProvider } from "../src/face/http-face-provider";
import {
  FACE_EMBEDDING_DIMENSIONS,
  FaceProviderError,
} from "../src/face/provider";

const unitEmbedding = [
  1,
  ...Array.from({ length: FACE_EMBEDDING_DIMENSIONS - 1 }, () => 0),
];

test("HTTP face provider sends private image bytes and validates a normalized embedding", async () => {
  let requestSeen: Request | undefined;
  const provider = new HttpFaceProvider({
    baseUrl: "http://127.0.0.1:8103",
    requestTimeoutMs: 1_000,
    fetchImplementation: async (input, init) => {
      requestSeen = new Request(input, init);
      return Response.json({
        model: "buffalo_l",
        dimensions: 512,
        provider: "CUDAExecutionProvider",
        image: { width: 640, height: 480 },
        faces: [
          {
            embedding: unitEmbedding,
            boundingBox: { x1: 100, y1: 80, x2: 300, y2: 320 },
            detectionScore: 0.99,
            qualityScore: 0.91,
            enrollmentEligible: true,
            rejectionReasons: [],
          },
        ],
      });
    },
  });

  const result = await provider.analyze({
    image: Uint8Array.from([1, 2, 3]),
    contentType: "image/jpeg",
    mode: "enroll",
  });

  assert.equal(result.faces[0]?.embedding.length, 512);
  assert.equal(result.provider, "CUDAExecutionProvider");
  assert.equal(new URL(requestSeen?.url ?? "").searchParams.get("mode"), "enroll");
  assert.equal(requestSeen?.headers.get("content-type"), "image/jpeg");
  assert.deepEqual(
    new Uint8Array(await requestSeen?.arrayBuffer()),
    Uint8Array.from([1, 2, 3]),
  );
});

test("HTTP face provider exposes only safe machine failures", async () => {
  const provider = new HttpFaceProvider({
    baseUrl: "http://127.0.0.1:8103",
    requestTimeoutMs: 1_000,
    fetchImplementation: async () =>
      Response.json(
        { detail: { code: "NO_FACE", message: "private detector detail" } },
        { status: 422 },
      ),
  });

  await assert.rejects(
    provider.analyze({
      image: Uint8Array.from([1]),
      contentType: "image/jpeg",
      mode: "verify",
    }),
    (error: unknown) =>
      error instanceof FaceProviderError &&
      error.failure === "NO_FACE" &&
      !error.message.includes("private detector detail"),
  );
});

test("HTTP face provider maps the Python exact-one-face error codes", async () => {
  for (const [upstreamCode, failure] of [
    ["NO_FACE_DETECTED", "NO_FACE"],
    ["MULTIPLE_FACES_DETECTED", "MULTIPLE_FACES"],
  ] as const) {
    const provider = new HttpFaceProvider({
      baseUrl: "http://127.0.0.1:8103",
      requestTimeoutMs: 1_000,
      fetchImplementation: async () =>
        Response.json(
          { detail: { code: upstreamCode, message: "safe upstream detail" } },
          { status: 422 },
        ),
    });

    await assert.rejects(
      provider.analyze({
        image: Uint8Array.from([1]),
        contentType: "image/jpeg",
        mode: "enroll",
      }),
      (error: unknown) =>
        error instanceof FaceProviderError && error.failure === failure,
    );
  }
});

test("HTTP face provider preserves upstream size and media-type categories", async () => {
  for (const [status, failure] of [
    [413, "PAYLOAD_TOO_LARGE"],
    [415, "UNSUPPORTED_MEDIA_TYPE"],
  ] as const) {
    const provider = new HttpFaceProvider({
      baseUrl: "http://127.0.0.1:8103",
      requestTimeoutMs: 1_000,
      fetchImplementation: async () =>
        Response.json({ detail: { code: "SAFE_UPSTREAM_ERROR" } }, { status }),
    });
    await assert.rejects(
      provider.analyze({
        image: Uint8Array.from([1]),
        contentType: "image/jpeg",
        mode: "identify",
      }),
      (error: unknown) =>
        error instanceof FaceProviderError && error.failure === failure,
    );
  }
});

test("HTTP face provider rejects malformed vectors and geometry", async () => {
  const provider = new HttpFaceProvider({
    baseUrl: "http://127.0.0.1:8103",
    requestTimeoutMs: 1_000,
    fetchImplementation: async () =>
      Response.json({
        model: "buffalo_l",
        dimensions: 512,
        provider: "CPUExecutionProvider",
        image: { width: 10, height: 10 },
        faces: [
          {
            embedding: Array.from({ length: 512 }, () => 0),
            boundingBox: { x1: 1, y1: 1, x2: 20, y2: 20 },
            detectionScore: 0.9,
            qualityScore: 0.8,
            enrollmentEligible: true,
            rejectionReasons: [],
          },
        ],
      }),
  });

  await assert.rejects(
    provider.analyze({
      image: Uint8Array.from([1]),
      contentType: "image/png",
      mode: "identify",
    }),
    (error: unknown) =>
      error instanceof FaceProviderError && error.failure === "INVALID_RESPONSE",
  );
});

test("face health is a cheap liveness shape and may report an unloaded model", async () => {
  const provider = new HttpFaceProvider({
    baseUrl: "http://127.0.0.1:8103",
    requestTimeoutMs: 1_000,
    fetchImplementation: async () =>
      Response.json({
        status: "ok",
        service: "face",
        model: "buffalo_l",
        loaded: false,
        provider: null,
      }),
  });

  assert.deepEqual(await provider.health(), {
    status: "ok",
    service: "face",
    model: "buffalo_l",
    loaded: false,
    provider: null,
  });
});
