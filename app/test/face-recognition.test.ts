import assert from "node:assert/strict";
import { test } from "node:test";

import {
  FaceRecognitionError,
  FaceRecognitionService,
} from "../src/face/face-recognition-service";
import type { FaceAnalysisInput, FaceAnalysisResult } from "../src/face/provider";
import { testConfig } from "./test-support";
import {
  baseEmbedding,
  faceAnalysis,
  FakeFaceProvider,
  InMemoryPeopleRepository,
  orthogonalEmbedding,
} from "./people-test-support";

function service(
  repository = new InMemoryPeopleRepository(),
  provider = new FakeFaceProvider(),
) {
  return {
    repository,
    provider,
    recognition: new FaceRecognitionService({
      repository,
      provider,
      matchThreshold: 0.5,
      enrollmentThreshold: 0.35,
      ambiguityMargin: 0.03,
    }),
  };
}

test("multi-photo enrollment stores separate templates and makes a person ready", async () => {
  const setup = service();
  const person = await setup.repository.createPerson({
    userId: testConfig.userId,
    displayName: "Yash",
    isOwner: true,
    aliases: ["Y"],
    details: { city: "Ahmedabad" },
  });

  for (let index = 0; index < 5; index += 1) {
    const result = await setup.recognition.enroll({
      userId: testConfig.userId,
      personId: person.id,
      image: Uint8Array.from([index + 1]),
      contentType: "image/jpeg",
      source: `self-${index + 1}.jpg`,
    });
    assert.equal("embedding" in result.faceSample, false);
    assert.equal(result.faceSample.source, `self-${index + 1}.jpg`);
  }

  const enrolled = await setup.repository.getPerson(testConfig.userId, person.id);
  assert.equal(enrolled?.faceSampleCount, 5);
  assert.equal(enrolled?.faceReady, true);
});

test("enrollment rejects low quality, duplicate photos, and an inconsistent identity", async () => {
  const setup = service();
  const person = await setup.repository.createPerson({
    userId: testConfig.userId,
    displayName: "Yash",
  });

  setup.provider.result = faceAnalysis(baseEmbedding, {
    enrollmentEligible: false,
    rejectionReasons: ["IMAGE_TOO_BLURRY"],
  });
  await assert.rejects(
    setup.recognition.enroll({
      userId: testConfig.userId,
      personId: person.id,
      image: Uint8Array.from([1]),
      contentType: "image/jpeg",
    }),
    (error: unknown) =>
      error instanceof FaceRecognitionError &&
      error.code === "LOW_QUALITY" &&
      /sharper photo/.test(error.publicMessage),
  );

  setup.provider.result = faceAnalysis(baseEmbedding);
  await setup.recognition.enroll({
    userId: testConfig.userId,
    personId: person.id,
    image: Uint8Array.from([2]),
    contentType: "image/jpeg",
  });
  await assert.rejects(
    setup.recognition.enroll({
      userId: testConfig.userId,
      personId: person.id,
      image: Uint8Array.from([2]),
      contentType: "image/jpeg",
    }),
    (error: unknown) =>
      error instanceof FaceRecognitionError && error.code === "DUPLICATE_FACE",
  );

  const otherPerson = await setup.repository.createPerson({
    userId: testConfig.userId,
    displayName: "Someone else",
  });
  await assert.rejects(
    setup.recognition.enroll({
      userId: testConfig.userId,
      personId: otherPerson.id,
      image: Uint8Array.from([2]),
      contentType: "image/jpeg",
    }),
    (error: unknown) =>
      error instanceof FaceRecognitionError && error.code === "FACE_MISMATCH",
  );
  await assert.rejects(
    setup.recognition.enroll({
      userId: testConfig.userId,
      personId: otherPerson.id,
      image: Uint8Array.from([4]),
      contentType: "image/jpeg",
    }),
    (error: unknown) =>
      error instanceof FaceRecognitionError &&
      error.code === "FACE_MISMATCH" &&
      /another person/.test(error.publicMessage),
  );

  setup.provider.result = faceAnalysis(orthogonalEmbedding());
  await assert.rejects(
    setup.recognition.enroll({
      userId: testConfig.userId,
      personId: person.id,
      image: Uint8Array.from([3]),
      contentType: "image/jpeg",
    }),
    (error: unknown) =>
      error instanceof FaceRecognitionError && error.code === "FACE_MISMATCH",
  );
});

test("concurrent first-photo uploads cannot seed one person with two identities", async () => {
  class SequencedFaceProvider extends FakeFaceProvider {
    private callCount = 0;

    override async analyze(input: FaceAnalysisInput): Promise<FaceAnalysisResult> {
      this.inputs.push(input);
      const embedding = this.callCount++ === 0 ? baseEmbedding : orthogonalEmbedding();
      return faceAnalysis(embedding);
    }
  }

  const setup = service(new InMemoryPeopleRepository(), new SequencedFaceProvider());
  const person = await setup.repository.createPerson({
    userId: testConfig.userId,
    displayName: "Yash",
  });

  const results = await Promise.allSettled([
    setup.recognition.enroll({
      userId: testConfig.userId,
      personId: person.id,
      image: Uint8Array.from([20]),
      contentType: "image/jpeg",
    }),
    setup.recognition.enroll({
      userId: testConfig.userId,
      personId: person.id,
      image: Uint8Array.from([21]),
      contentType: "image/jpeg",
    }),
  ]);

  assert.equal(results[0]?.status, "fulfilled");
  assert.equal(results[1]?.status, "rejected");
  assert.ok(
    results[1]?.status === "rejected" &&
      results[1].reason instanceof FaceRecognitionError &&
      results[1].reason.code === "FACE_MISMATCH",
  );
  assert.equal(
    (await setup.repository.getPerson(testConfig.userId, person.id))?.faceSampleCount,
    1,
  );
});

test("concurrent profiles cannot seed the same face under two names", async () => {
  const setup = service();
  const firstPerson = await setup.repository.createPerson({
    userId: testConfig.userId,
    displayName: "First profile",
  });
  const secondPerson = await setup.repository.createPerson({
    userId: testConfig.userId,
    displayName: "Second profile",
  });

  const results = await Promise.allSettled([
    setup.recognition.enroll({
      userId: testConfig.userId,
      personId: firstPerson.id,
      image: Uint8Array.from([25]),
      contentType: "image/jpeg",
    }),
    setup.recognition.enroll({
      userId: testConfig.userId,
      personId: secondPerson.id,
      image: Uint8Array.from([26]),
      contentType: "image/jpeg",
    }),
  ]);

  assert.equal(results[0]?.status, "fulfilled");
  assert.ok(
    results[1]?.status === "rejected" &&
      results[1].reason instanceof FaceRecognitionError &&
      results[1].reason.code === "FACE_MISMATCH",
  );
});

test("enrollment consistency and verification never mix incompatible face models", async () => {
  const setup = service();
  const person = await setup.repository.createPerson({
    userId: testConfig.userId,
    displayName: "Yash",
  });
  await setup.repository.addFaceSample({
    userId: testConfig.userId,
    personId: person.id,
    embedding: baseEmbedding,
    qualityScore: 0.9,
    detectionScore: 0.99,
    boundingBox: { x1: 1, y1: 1, x2: 100, y2: 100 },
    model: "buffalo_l-v1",
    imageSha256: "c".repeat(64),
  });

  setup.provider.result = {
    ...faceAnalysis(orthogonalEmbedding()),
    model: "buffalo_l-v2",
  };
  const enrolled = await setup.recognition.enroll({
    userId: testConfig.userId,
    personId: person.id,
    image: Uint8Array.from([30]),
    contentType: "image/jpeg",
  });
  assert.equal(enrolled.consistencySimilarity, null);

  setup.provider.result = {
    ...faceAnalysis(baseEmbedding),
    model: "buffalo_l-v1",
  };
  assert.equal(
    (
      await setup.recognition.verify({
        userId: testConfig.userId,
        personId: person.id,
        image: Uint8Array.from([31]),
        contentType: "image/jpeg",
      })
    ).verified,
    true,
  );

  setup.provider.result = {
    ...faceAnalysis(baseEmbedding),
    model: "buffalo_l-v3",
  };
  await assert.rejects(
    setup.recognition.verify({
      userId: testConfig.userId,
      personId: person.id,
      image: Uint8Array.from([32]),
      contentType: "image/jpeg",
    }),
    (error: unknown) =>
      error instanceof FaceRecognitionError &&
      error.code === "PERSON_NOT_ENROLLED",
  );
});

test("identify resolves person details, rejects ambiguity, and verify is person-specific", async () => {
  const setup = service();
  const yash = await setup.repository.createPerson({
    userId: testConfig.userId,
    displayName: "Yash",
    isOwner: true,
    details: { city: "Ahmedabad" },
  });
  const charmi = await setup.repository.createPerson({
    userId: testConfig.userId,
    displayName: "Charmi",
    relationship: "wife",
  });
  await setup.repository.addFaceSample({
    userId: testConfig.userId,
    personId: yash.id,
    embedding: baseEmbedding,
    qualityScore: 0.9,
    detectionScore: 0.99,
    boundingBox: { x1: 1, y1: 1, x2: 10, y2: 10 },
    model: "buffalo_l",
    imageSha256: "a".repeat(64),
  });
  await setup.repository.addFaceSample({
    userId: testConfig.userId,
    personId: charmi.id,
    embedding: orthogonalEmbedding(),
    qualityScore: 0.9,
    detectionScore: 0.99,
    boundingBox: { x1: 1, y1: 1, x2: 10, y2: 10 },
    model: "buffalo_l",
    imageSha256: "b".repeat(64),
  });

  setup.provider.result = faceAnalysis(baseEmbedding);
  const identified = await setup.recognition.identify({
    userId: testConfig.userId,
    image: Uint8Array.from([9]),
    contentType: "image/jpeg",
  });
  assert.equal(identified.faces[0]?.match?.person.displayName, "Yash");
  assert.deepEqual(identified.faces[0]?.match?.person.details, {
    city: "Ahmedabad",
  });
  assert.equal(identified.faces[0]?.ambiguous, false);

  const ambiguousValue = Math.SQRT1_2;
  setup.provider.result = faceAnalysis([
    ambiguousValue,
    ambiguousValue,
    ...Array.from({ length: 510 }, () => 0),
  ]);
  const ambiguous = await setup.recognition.identify({
    userId: testConfig.userId,
    image: Uint8Array.from([10]),
    contentType: "image/jpeg",
  });
  assert.equal(ambiguous.faces[0]?.match, null);
  assert.equal(ambiguous.faces[0]?.ambiguous, true);

  setup.provider.result = faceAnalysis(baseEmbedding);
  const verified = await setup.recognition.verify({
    userId: testConfig.userId,
    personId: yash.id,
    image: Uint8Array.from([11]),
    contentType: "image/jpeg",
  });
  const notCharmi = await setup.recognition.verify({
    userId: testConfig.userId,
    personId: charmi.id,
    image: Uint8Array.from([12]),
    contentType: "image/jpeg",
  });
  assert.equal(verified.verified, true);
  assert.equal(verified.similarity, 1);
  assert.equal(notCharmi.verified, false);

  setup.provider.result = faceAnalysis(baseEmbedding, {
    enrollmentEligible: false,
    rejectionReasons: ["IMAGE_TOO_BLURRY"],
  });
  const lowQualityIdentification = await setup.recognition.identify({
    userId: testConfig.userId,
    image: Uint8Array.from([13]),
    contentType: "image/jpeg",
  });
  assert.equal(lowQualityIdentification.faces[0]?.match, null);
  await assert.rejects(
    setup.recognition.verify({
      userId: testConfig.userId,
      personId: yash.id,
      image: Uint8Array.from([14]),
      contentType: "image/jpeg",
    }),
    (error: unknown) =>
      error instanceof FaceRecognitionError && error.code === "LOW_QUALITY",
  );
});
