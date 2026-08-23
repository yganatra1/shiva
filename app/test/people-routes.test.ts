import assert from "node:assert/strict";
import { test } from "node:test";

import { createApp } from "../src/app";
import type { AIProvider } from "../src/brain/ai-provider";
import {
  FaceRecognitionService,
} from "../src/face/face-recognition-service";
import {
  baseEmbedding,
  faceAnalysis,
  FakeFaceProvider,
  InMemoryPeopleRepository,
} from "./people-test-support";
import { createTestOverrides, testConfig } from "./test-support";

const chatProvider: AIProvider = {
  async chat() {
    return { content: '{"memories":[]}' };
  },
  async *streamChat() {
    yield { content: "ok" };
  },
};

function setupApp() {
  const repository = new InMemoryPeopleRepository();
  const faceProvider = new FakeFaceProvider();
  const faceRecognition = new FaceRecognitionService({
    repository,
    provider: faceProvider,
    matchThreshold: testConfig.faceMatchThreshold,
    enrollmentThreshold: testConfig.faceEnrollmentThreshold,
    ambiguityMargin: testConfig.faceAmbiguityMargin,
  });
  const app = createApp(testConfig, {
    ...createTestOverrides(chatProvider),
    peopleRepository: repository,
    faceProvider,
    faceRecognition,
  });
  return { app, repository, faceProvider };
}

test("People page exposes a private bulk-photo enrollment workflow", async (context) => {
  const { app } = setupApp();
  context.after(() => app.close());

  const response = await app.inject({ method: "GET", url: "/people" });

  assert.equal(response.statusCode, 200);
  assert.match(response.headers["content-type"] ?? "", /^text\/html/);
  assert.match(response.headers["cache-control"] ?? "", /no-store/);
  assert.match(response.headers["content-security-policy"] ?? "", /img-src 'self' blob: data:/);
  assert.match(response.body, /type="file"[^>]*accept="image\/\*"[^>]*multiple/);
  assert.match(response.body, /10–15 or more varied photos/i);
  assert.match(response.body, /Add more photos/i);
  assert.match(response.body, /Identify people/i);
});

test("people routes create details, enroll 10+ photos, identify, and verify without exposing templates", async (context) => {
  const { app } = setupApp();
  context.after(() => app.close());

  const created = await app.inject({
    method: "POST",
    url: "/api/people",
    headers: { "content-type": "application/json" },
    payload: {
      displayName: "Yash",
      isOwner: true,
      relationship: "self",
      aliases: ["Y"],
      details: { city: "Ahmedabad", favoriteDrink: "coffee" },
      notes: "Prefers quiet mornings.",
    },
  });
  assert.equal(created.statusCode, 201);
  const personId = created.json().person.id as string;

  for (let index = 0; index < 12; index += 1) {
    const enrolled = await app.inject({
      method: "POST",
      url: `/api/people/${personId}/faces`,
      headers: {
        "content-type": "image/jpeg",
        "x-shiva-file-name": `portrait-${index + 1}.jpg`,
      },
      payload:
        index === 0
          ? Buffer.alloc(2_500_000, 7)
          : Buffer.from([index + 1, 42]),
    });
    assert.equal(enrolled.statusCode, 201, enrolled.body);
  }

  const profile = await app.inject({
    method: "GET",
    url: `/api/people/${personId}`,
  });
  assert.equal(profile.statusCode, 200);
  assert.equal(profile.json().person.faceSampleCount, 12);
  assert.equal(profile.json().person.faceReady, true);
  assert.deepEqual(profile.json().person.details, {
    city: "Ahmedabad",
    favoriteDrink: "coffee",
  });
  assert.equal(profile.json().faceSamples.length, 12);
  assert.equal("embedding" in profile.json().faceSamples[0], false);
  assert.equal("imageSha256" in profile.json().faceSamples[0], false);
  assert.equal("source" in profile.json().faceSamples[0], false);

  const edited = await app.inject({
    method: "PATCH",
    url: `/api/people/${personId}`,
    headers: { "content-type": "application/json" },
    payload: { notes: "Updated note without replacing other fields." },
  });
  assert.equal(edited.statusCode, 200, edited.body);
  assert.equal(edited.json().person.isOwner, true);
  assert.deepEqual(edited.json().person.aliases, ["Y"]);
  assert.deepEqual(edited.json().person.details, {
    city: "Ahmedabad",
    favoriteDrink: "coffee",
  });

  const identified = await app.inject({
    method: "POST",
    url: "/face/identify",
    headers: { "content-type": "image/jpeg" },
    payload: Buffer.from([99]),
  });
  assert.equal(identified.statusCode, 200, identified.body);
  assert.equal(identified.json().faces[0].match.person.id, personId);
  assert.equal(identified.json().faces[0].match.person.displayName, "Yash");
  assert.deepEqual(identified.json().faces[0].match.person.details, {
    city: "Ahmedabad",
    favoriteDrink: "coffee",
  });
  assert.doesNotMatch(identified.body, /"embedding"|imageSha256/);

  const verified = await app.inject({
    method: "POST",
    url: `/face/verify?personId=${personId}`,
    headers: { "content-type": "image/jpeg" },
    payload: Buffer.from([100]),
  });
  assert.equal(verified.statusCode, 200, verified.body);
  assert.equal(verified.json().verified, true);
  assert.equal(verified.json().person.id, personId);
});

test("each enrollment upload is independent so rejected photos do not roll back accepted samples", async (context) => {
  const { app, faceProvider } = setupApp();
  context.after(() => app.close());

  const created = await app.inject({
    method: "POST",
    url: "/api/people",
    headers: { "content-type": "application/json" },
    payload: {
      displayName: "Charmi",
      isOwner: false,
      relationship: "wife",
      aliases: [],
      details: {},
    },
  });
  const personId = created.json().person.id as string;

  const accepted = await app.inject({
    method: "POST",
    url: `/api/people/${personId}/faces`,
    headers: { "content-type": "image/jpeg" },
    payload: Buffer.from([1]),
  });
  assert.equal(accepted.statusCode, 201);

  faceProvider.result = faceAnalysis(baseEmbedding, {
    enrollmentEligible: false,
    rejectionReasons: ["IMAGE_TOO_BLURRY"],
  });
  const rejected = await app.inject({
    method: "POST",
    url: `/api/people/${personId}/faces`,
    headers: { "content-type": "image/jpeg" },
    payload: Buffer.from([2]),
  });
  assert.equal(rejected.statusCode, 422);
  assert.equal(rejected.json().error.code, "LOW_QUALITY");
  assert.match(rejected.json().error.message, /sharper photo/);

  const profile = await app.inject({
    method: "GET",
    url: `/api/people/${personId}`,
  });
  assert.equal(profile.json().person.faceSampleCount, 1);

  const unsupported = await app.inject({
    method: "POST",
    url: `/api/people/${personId}/faces`,
    headers: { "content-type": "application/octet-stream" },
    payload: Buffer.from([3]),
  });
  assert.equal(unsupported.statusCode, 415);
});
