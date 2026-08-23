import { createHash } from "node:crypto";

import type {
  FaceMatchCandidate,
  PeopleRepositoryPort,
  Person,
  PersonFaceSample,
  PersonFaceTemplate,
} from "../people/types";
import { FaceImageAlreadyEnrolledError } from "../people/types";
import {
  FACE_EMBEDDING_DIMENSIONS,
  FaceProviderError,
  type FaceAnalysisInput,
  type FaceBoundingBox,
  type FaceObservation,
  type FaceProvider,
} from "./provider";

export type FaceRecognitionErrorCode =
  | "PERSON_NOT_FOUND"
  | "PERSON_NOT_ENROLLED"
  | "NO_FACE"
  | "MULTIPLE_FACES"
  | "LOW_QUALITY"
  | "FACE_MISMATCH"
  | "DUPLICATE_FACE";

export class FaceRecognitionError extends Error {
  override readonly name = "FaceRecognitionError";

  constructor(
    readonly code: FaceRecognitionErrorCode,
    readonly publicMessage: string,
  ) {
    super(publicMessage);
  }
}

export interface FaceRecognitionServiceOptions {
  readonly repository: PeopleRepositoryPort;
  readonly provider: FaceProvider;
  readonly matchThreshold: number;
  readonly enrollmentThreshold: number;
  readonly ambiguityMargin: number;
  readonly candidateLimit?: number;
}

export interface FaceImageInput {
  readonly userId: string;
  readonly image: Uint8Array;
  readonly contentType: string;
  readonly signal?: AbortSignal;
}

export interface EnrollFaceInput extends FaceImageInput {
  readonly personId: string;
  readonly source?: string;
}

export interface EnrollFaceResult {
  readonly person: Person;
  readonly faceSample: PersonFaceSample;
  readonly consistencySimilarity: number | null;
}

export type FaceMatchConfidence = "medium" | "high";

export interface IdentifiedPersonMatch {
  readonly person: Person;
  readonly similarity: number;
  readonly confidence: FaceMatchConfidence;
  readonly supportingSamples: number;
}

export interface IdentifiedFace {
  readonly boundingBox: FaceBoundingBox;
  readonly detectionScore: number;
  readonly qualityScore: number;
  readonly match: IdentifiedPersonMatch | null;
  readonly ambiguous: boolean;
}

export interface FaceIdentificationResult {
  readonly model: string;
  readonly image: { readonly width: number; readonly height: number };
  readonly threshold: number;
  readonly faces: readonly IdentifiedFace[];
}

export interface VerifyFaceInput extends FaceImageInput {
  readonly personId: string;
}

export interface FaceVerificationResult {
  readonly person: Person;
  readonly verified: boolean;
  readonly similarity: number;
  readonly threshold: number;
  readonly model: string;
}

export class FaceRecognitionService {
  private readonly candidateLimit: number;
  private readonly enrollmentTails = new Map<string, Promise<void>>();

  constructor(private readonly options: FaceRecognitionServiceOptions) {
    this.candidateLimit = options.candidateLimit ?? 40;
  }

  async enroll(input: EnrollFaceInput): Promise<EnrollFaceResult> {
    const key = input.userId;
    const previous = this.enrollmentTails.get(key) ?? Promise.resolve();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const tail = previous.then(() => gate);
    this.enrollmentTails.set(key, tail);

    await previous;
    try {
      return await this.enrollSerially(input);
    } finally {
      release();
      if (this.enrollmentTails.get(key) === tail) {
        this.enrollmentTails.delete(key);
      }
    }
  }

  /**
   * Consistency checking and insertion are serialized across an owner's face
   * gallery. The UI intentionally uploads two photos at a time; without this
   * boundary, first photos for one or two people could independently seed
   * conflicting identities before either insertion became visible.
   */
  private async enrollSerially(input: EnrollFaceInput): Promise<EnrollFaceResult> {
    const person = await this.requiredPerson(input.userId, input.personId);
    const analysis = await this.options.provider.analyze(
      providerInput(input, "enroll"),
    );
    const face = requiredSingleFace(analysis.faces);

    if (!face.enrollmentEligible) {
      throw new FaceRecognitionError(
        "LOW_QUALITY",
        qualityRejectionMessage(face.rejectionReasons),
      );
    }

    const imageSha256 = createHash("sha256").update(input.image).digest("hex");
    const templates = await this.options.repository.listFaceTemplates(
      input.userId,
      person.id,
    );
    if (templates.some((template) => template.imageSha256 === imageSha256)) {
      throw new FaceRecognitionError(
        "DUPLICATE_FACE",
        "That exact photo has already been enrolled for this person.",
      );
    }
    const compatibleTemplates = templates.filter(
      (template) => template.model === analysis.model,
    );
    const consistencySimilarity = bestTemplateSimilarity(
      face.embedding,
      compatibleTemplates,
    );
    if (
      consistencySimilarity !== null &&
      consistencySimilarity < this.options.enrollmentThreshold
    ) {
      throw new FaceRecognitionError(
        "FACE_MISMATCH",
        "This face does not match the photos already enrolled for this person.",
      );
    }
    const nearest = await this.options.repository.findNearestFaceCandidates({
      userId: input.userId,
      embedding: normalizedEmbedding(face.embedding),
      model: analysis.model,
      limit: this.candidateLimit,
    });
    const bestOther = nearest.find(
      (candidate) =>
        candidate.personId !== person.id && Number.isFinite(candidate.similarity),
    );
    if (
      bestOther &&
      bestOther.similarity >= this.options.matchThreshold &&
      (consistencySimilarity === null ||
        consistencySimilarity - bestOther.similarity < this.options.ambiguityMargin)
    ) {
      throw new FaceRecognitionError(
        "FACE_MISMATCH",
        "This face appears to be enrolled for another person in Shiva's directory.",
      );
    }

    let faceSample: PersonFaceSample | null;
    try {
      faceSample = await this.options.repository.addFaceSample({
        userId: input.userId,
        personId: person.id,
        embedding: normalizedEmbedding(face.embedding),
        qualityScore: face.qualityScore,
        detectionScore: face.detectionScore,
        boundingBox: face.boundingBox,
        model: analysis.model,
        ...(input.source ? { source: input.source } : {}),
        imageSha256,
      });
    } catch (error: unknown) {
      if (error instanceof FaceImageAlreadyEnrolledError) {
        throw new FaceRecognitionError(
          "DUPLICATE_FACE",
          "That exact photo is already enrolled for another person.",
        );
      }
      throw error;
    }
    if (!faceSample) {
      const stillExists = await this.options.repository.getPerson(
        input.userId,
        person.id,
      );
      if (!stillExists) {
        throw new FaceRecognitionError(
          "PERSON_NOT_FOUND",
          "That person no longer exists in Shiva's people directory.",
        );
      }
      throw new FaceRecognitionError(
        "DUPLICATE_FACE",
        "That exact photo has already been enrolled.",
      );
    }

    return {
      person:
        (await this.options.repository.getPerson(input.userId, person.id)) ??
        person,
      faceSample,
      consistencySimilarity,
    };
  }

  async identify(input: FaceImageInput): Promise<FaceIdentificationResult> {
    const analysis = await this.options.provider.analyze(
      providerInput(input, "identify"),
    );
    const faces: IdentifiedFace[] = [];

    for (const observation of analysis.faces) {
      if (!observation.enrollmentEligible) {
        faces.push({
          boundingBox: observation.boundingBox,
          detectionScore: observation.detectionScore,
          qualityScore: observation.qualityScore,
          match: null,
          ambiguous: false,
        });
        continue;
      }
      const candidates = await this.options.repository.findNearestFaceCandidates({
        userId: input.userId,
        embedding: normalizedEmbedding(observation.embedding),
        model: analysis.model,
        limit: this.candidateLimit,
      });
      faces.push(await this.resolveMatch(input.userId, observation, candidates));
    }

    return {
      model: analysis.model,
      image: analysis.image,
      threshold: this.options.matchThreshold,
      faces,
    };
  }

  async verify(input: VerifyFaceInput): Promise<FaceVerificationResult> {
    const person = await this.requiredPerson(input.userId, input.personId);
    const templates = await this.options.repository.listFaceTemplates(
      input.userId,
      person.id,
    );
    if (templates.length === 0) {
      throw new FaceRecognitionError(
        "PERSON_NOT_ENROLLED",
        "This person does not have any enrolled face photos yet.",
      );
    }

    const analysis = await this.options.provider.analyze(
      providerInput(input, "verify"),
    );
    const face = requiredSingleFace(analysis.faces);
    if (!face.enrollmentEligible) {
      throw new FaceRecognitionError(
        "LOW_QUALITY",
        qualityRejectionMessage(face.rejectionReasons),
      );
    }
    const compatibleTemplates = templates.filter(
      (template) => template.model === analysis.model,
    );
    if (compatibleTemplates.length === 0) {
      throw new FaceRecognitionError(
        "PERSON_NOT_ENROLLED",
        "This person does not have face photos enrolled with Shiva's current face model.",
      );
    }
    const similarity =
      bestTemplateSimilarity(face.embedding, compatibleTemplates) ?? -1;

    return {
      person,
      verified: similarity >= this.options.matchThreshold,
      similarity: roundedSimilarity(similarity),
      threshold: this.options.matchThreshold,
      model: analysis.model,
    };
  }

  private async requiredPerson(userId: string, personId: string): Promise<Person> {
    const person = await this.options.repository.getPerson(userId, personId);
    if (!person) {
      throw new FaceRecognitionError(
        "PERSON_NOT_FOUND",
        "That person does not exist in Shiva's people directory.",
      );
    }
    return person;
  }

  private async resolveMatch(
    userId: string,
    observation: FaceObservation,
    candidates: readonly FaceMatchCandidate[],
  ): Promise<IdentifiedFace> {
    const grouped = bestCandidatePerPerson(candidates);
    const top = grouped[0];
    const runnerUp = grouped[1];
    const ambiguous = Boolean(
      top &&
        runnerUp &&
        top.similarity - runnerUp.similarity < this.options.ambiguityMargin,
    );
    let match: IdentifiedPersonMatch | null = null;

    if (top && top.similarity >= this.options.matchThreshold && !ambiguous) {
      const person = await this.options.repository.getPerson(userId, top.personId);
      if (person) {
        match = {
          person,
          similarity: roundedSimilarity(top.similarity),
          confidence:
            top.similarity >= Math.min(0.95, this.options.matchThreshold + 0.15)
              ? "high"
              : "medium",
          supportingSamples: top.supportingSamples,
        };
      }
    }

    return {
      boundingBox: observation.boundingBox,
      detectionScore: observation.detectionScore,
      qualityScore: observation.qualityScore,
      match,
      ambiguous,
    };
  }
}

function providerInput(
  input: FaceImageInput,
  mode: FaceAnalysisInput["mode"],
): FaceAnalysisInput {
  return {
    image: input.image,
    contentType: input.contentType,
    mode,
    ...(input.signal ? { signal: input.signal } : {}),
  };
}

function requiredSingleFace(faces: readonly FaceObservation[]): FaceObservation {
  if (faces.length === 0) {
    throw new FaceProviderError("NO_FACE", "No face was detected.");
  }
  if (faces.length !== 1) {
    throw new FaceProviderError(
      "MULTIPLE_FACES",
      "More than one face was detected.",
    );
  }
  return faces[0] as FaceObservation;
}

function normalizedEmbedding(embedding: readonly number[]): readonly number[] {
  if (embedding.length !== FACE_EMBEDDING_DIMENSIONS) {
    throw new FaceProviderError(
      "INVALID_RESPONSE",
      "Face embedding has the wrong dimensions.",
    );
  }
  const norm = Math.sqrt(
    embedding.reduce((sum, value) => sum + value * value, 0),
  );
  if (!Number.isFinite(norm) || norm <= 0) {
    throw new FaceProviderError(
      "INVALID_RESPONSE",
      "Face embedding is not finite.",
    );
  }
  return embedding.map((value) => value / norm);
}

export function cosineSimilarity(
  left: readonly number[],
  right: readonly number[],
): number {
  if (left.length !== right.length || left.length === 0) return -1;
  let dot = 0;
  let leftNorm = 0;
  let rightNorm = 0;
  for (let index = 0; index < left.length; index += 1) {
    const leftValue = left[index];
    const rightValue = right[index];
    if (leftValue === undefined || rightValue === undefined) return -1;
    dot += leftValue * rightValue;
    leftNorm += leftValue * leftValue;
    rightNorm += rightValue * rightValue;
  }
  const denominator = Math.sqrt(leftNorm * rightNorm);
  return denominator > 0 ? dot / denominator : -1;
}

function bestTemplateSimilarity(
  embedding: readonly number[],
  templates: readonly PersonFaceTemplate[],
): number | null {
  if (templates.length === 0) return null;
  return Math.max(
    ...templates.map((template) =>
      cosineSimilarity(embedding, template.embedding),
    ),
  );
}

interface AggregatedCandidate {
  readonly personId: string;
  readonly similarity: number;
  readonly supportingSamples: number;
}

function bestCandidatePerPerson(
  candidates: readonly FaceMatchCandidate[],
): readonly AggregatedCandidate[] {
  const byPerson = new Map<string, { best: number; samples: number }>();
  for (const candidate of candidates) {
    if (!Number.isFinite(candidate.similarity)) continue;
    const existing = byPerson.get(candidate.personId);
    if (existing) {
      existing.best = Math.max(existing.best, candidate.similarity);
      existing.samples += 1;
    } else {
      byPerson.set(candidate.personId, {
        best: candidate.similarity,
        samples: 1,
      });
    }
  }
  return [...byPerson.entries()]
    .map(([personId, value]) => ({
      personId,
      similarity: value.best,
      supportingSamples: value.samples,
    }))
    .sort((left, right) => right.similarity - left.similarity);
}

function roundedSimilarity(value: number): number {
  return Math.round(value * 10_000) / 10_000;
}

function qualityRejectionMessage(reasons: readonly string[]): string {
  const labels: Readonly<Record<string, string>> = {
    FACE_TOO_SMALL: "move closer to the camera",
    TOO_BLURRY: "use a sharper photo",
    IMAGE_TOO_BLURRY: "use a sharper photo",
    TOO_DARK: "use a brighter photo",
    IMAGE_TOO_DARK: "use a brighter photo",
    TOO_BRIGHT: "avoid overexposed lighting",
    IMAGE_TOO_BRIGHT: "avoid overexposed lighting",
    POSE_TOO_EXTREME: "look more toward the camera",
    FACE_PARTIALLY_OUT_OF_FRAME: "keep the whole face inside the frame",
    LOW_DETECTION_SCORE: "use a clearer, unobstructed face",
  };
  const guidance = [...new Set(reasons.map((reason) => labels[reason]).filter(Boolean))];
  return guidance.length > 0
    ? `This photo is not suitable for enrollment; ${guidance.join(" and ")}.`
    : "This photo is not suitable for enrollment. Use a clear, well-lit photo with one visible face.";
}
