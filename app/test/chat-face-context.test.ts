import assert from "node:assert/strict";
import { test } from "node:test";

import { createApp } from "../src/app";
import type {
  AIProvider,
  ChatInput,
} from "../src/brain/ai-provider";
import {
  FaceRecognitionService,
} from "../src/face/face-recognition-service";
import {
  baseEmbedding,
  FakeFaceProvider,
  InMemoryPeopleRepository,
} from "./people-test-support";
import { createTestOverrides, testConfig } from "./test-support";

test("recognized face details are supplied to chat as bounded untrusted context", async (context) => {
  const inputs: ChatInput[] = [];
  const provider: AIProvider = {
    async chat() {
      return { content: '{"memories":[]}' };
    },
    async *streamChat(input) {
      inputs.push(input);
      yield { content: "That is Yash." };
    },
  };
  const people = new InMemoryPeopleRepository();
  const faceProvider = new FakeFaceProvider();
  const person = await people.createPerson({
    userId: testConfig.userId,
    displayName: "Yash",
    isOwner: true,
    relationship: "self",
    aliases: ["Y"],
    details: { city: "Ahmedabad" },
    notes: "Prefers quiet mornings.",
  });
  await people.addFaceSample({
    userId: testConfig.userId,
    personId: person.id,
    embedding: baseEmbedding,
    qualityScore: 0.9,
    detectionScore: 0.99,
    boundingBox: { x1: 1, y1: 1, x2: 100, y2: 100 },
    model: "buffalo_l",
    imageSha256: "a".repeat(64),
  });
  const recognition = new FaceRecognitionService({
    repository: people,
    provider: faceProvider,
    matchThreshold: testConfig.faceMatchThreshold,
    enrollmentThreshold: testConfig.faceEnrollmentThreshold,
    ambiguityMargin: testConfig.faceAmbiguityMargin,
  });
  const app = createApp(testConfig, {
    ...createTestOverrides(provider),
    peopleRepository: people,
    faceProvider,
    faceRecognition: recognition,
  });
  context.after(() => app.close());

  const response = await app.inject({
    method: "POST",
    url: "/chat",
    headers: { "content-type": "application/json" },
    payload: {
      message: "Who is in this photo?",
      images: [Buffer.from([1, 2, 3]).toString("base64")],
    },
  });

  assert.equal(response.statusCode, 200, response.body);
  const identityMessage = inputs[0]?.messages.find(
    (message) => message.role === "system" && /face-recognition results/.test(message.content),
  );
  assert.ok(identityMessage);
  assert.match(identityMessage.content, /untrusted personal data/);
  assert.match(identityMessage.content, /"name":"Yash"/);
  assert.match(identityMessage.content, /"city":"Ahmedabad"/);
  assert.match(identityMessage.content, /"relationship":"self"/);
  assert.doesNotMatch(identityMessage.content, /embedding|imageSha256/);
  assert.deepEqual(inputs[0]?.messages.at(-1)?.images, [
    Buffer.from([1, 2, 3]).toString("base64"),
  ]);
});

test("chat still answers when local recognition is unavailable", async (context) => {
  const inputs: ChatInput[] = [];
  const provider: AIProvider = {
    async chat() {
      return { content: '{"memories":[]}' };
    },
    async *streamChat(input) {
      inputs.push(input);
      yield { content: "I can still inspect the image." };
    },
  };
  const people = new InMemoryPeopleRepository();
  const faceProvider = new FakeFaceProvider();
  faceProvider.failure = new Error("face service offline");
  const recognition = new FaceRecognitionService({
    repository: people,
    provider: faceProvider,
    matchThreshold: 0.5,
    enrollmentThreshold: 0.35,
    ambiguityMargin: 0.03,
  });
  const app = createApp(testConfig, {
    ...createTestOverrides(provider),
    peopleRepository: people,
    faceProvider,
    faceRecognition: recognition,
  });
  context.after(() => app.close());

  const response = await app.inject({
    method: "POST",
    url: "/chat",
    headers: { "content-type": "application/json" },
    payload: {
      message: "Describe this.",
      images: [Buffer.from([4, 5, 6]).toString("base64")],
    },
  });

  assert.equal(response.statusCode, 200);
  assert.equal(
    inputs[0]?.messages.some((message) => /face-recognition results/.test(message.content)),
    false,
  );
});
