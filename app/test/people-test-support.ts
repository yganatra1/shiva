import {
  FACE_READY_SAMPLE_COUNT,
  FaceImageAlreadyEnrolledError,
  type AddPersonFaceSampleInput,
  type CreatePersonInput,
  type FaceMatchCandidate,
  type FindNearestFaceCandidatesInput,
  type PeopleRepositoryPort,
  type Person,
  type PersonFaceSample,
  type PersonFaceTemplate,
  type UpdatePersonInput,
} from "../src/people/types";
import type {
  FaceAnalysisInput,
  FaceAnalysisResult,
  FaceProvider,
  FaceProviderHealth,
} from "../src/face/provider";
import { FACE_EMBEDDING_DIMENSIONS } from "../src/face/provider";

export const baseEmbedding = Object.freeze([
  1,
  ...Array.from({ length: FACE_EMBEDDING_DIMENSIONS - 1 }, () => 0),
]);

export function orthogonalEmbedding(axis = 1): readonly number[] {
  return Array.from(
    { length: FACE_EMBEDDING_DIMENSIONS },
    (_value, index) => (index === axis ? 1 : 0),
  );
}

export function faceAnalysis(
  embedding: readonly number[] = baseEmbedding,
  overrides: Partial<FaceAnalysisResult["faces"][number]> = {},
): FaceAnalysisResult {
  return {
    model: "buffalo_l",
    dimensions: 512,
    provider: "CUDAExecutionProvider",
    image: { width: 640, height: 480 },
    faces: [
      {
        embedding,
        boundingBox: { x1: 120, y1: 80, x2: 340, y2: 360 },
        detectionScore: 0.99,
        qualityScore: 0.92,
        enrollmentEligible: true,
        rejectionReasons: [],
        ...overrides,
      },
    ],
  };
}

export class FakeFaceProvider implements FaceProvider {
  readonly inputs: FaceAnalysisInput[] = [];
  result: FaceAnalysisResult = faceAnalysis();
  failure: Error | undefined;

  async analyze(input: FaceAnalysisInput): Promise<FaceAnalysisResult> {
    this.inputs.push(input);
    if (this.failure) throw this.failure;
    return this.result;
  }

  async health(): Promise<FaceProviderHealth> {
    return {
      status: "ok",
      service: "face",
      model: "buffalo_l",
      loaded: true,
      provider: "CUDAExecutionProvider",
    };
  }
}

export class InMemoryPeopleRepository implements PeopleRepositoryPort {
  private readonly people = new Map<string, Omit<Person, "faceSampleCount" | "faceReady">>();
  private readonly templates = new Map<string, PersonFaceTemplate[]>();
  private sequence = 1;

  async ensureUser(): Promise<void> {}

  async createPerson(input: CreatePersonInput): Promise<Person> {
    if (input.isOwner) this.unsetOwners(input.userId);
    const now = new Date("2026-08-23T10:00:00.000Z");
    const id = this.uuid();
    this.people.set(id, {
      id,
      userId: input.userId,
      displayName: input.displayName.trim(),
      isOwner: input.isOwner ?? false,
      relationship: input.relationship ?? null,
      notes: input.notes ?? null,
      details: { ...(input.details ?? {}) },
      aliases: [...(input.aliases ?? [])],
      createdAt: now,
      updatedAt: now,
    });
    return this.requiredPerson(input.userId, id);
  }

  async updatePerson(input: UpdatePersonInput): Promise<Person | null> {
    const existing = this.people.get(input.personId);
    if (!existing || existing.userId !== input.userId) return null;
    if (input.isOwner) this.unsetOwners(input.userId);
    this.people.set(input.personId, {
      ...existing,
      ...(input.displayName !== undefined ? { displayName: input.displayName } : {}),
      ...(input.isOwner !== undefined ? { isOwner: input.isOwner } : {}),
      ...(input.relationship !== undefined
        ? { relationship: input.relationship }
        : {}),
      ...(input.notes !== undefined ? { notes: input.notes } : {}),
      ...(input.details !== undefined ? { details: { ...input.details } } : {}),
      ...(input.aliases !== undefined ? { aliases: [...input.aliases] } : {}),
      updatedAt: new Date("2026-08-23T10:01:00.000Z"),
    });
    return this.requiredPerson(input.userId, input.personId);
  }

  async getPerson(userId: string, personId: string): Promise<Person | null> {
    const person = this.people.get(personId);
    if (!person || person.userId !== userId) return null;
    return this.withCounts(person);
  }

  async listPeople(userId: string): Promise<readonly Person[]> {
    return [...this.people.values()]
      .filter((person) => person.userId === userId)
      .map((person) => this.withCounts(person));
  }

  async searchPeople(
    userId: string,
    query: string,
    limit = 25,
  ): Promise<readonly Person[]> {
    const needle = query.toLowerCase();
    return (await this.listPeople(userId))
      .filter((person) =>
        JSON.stringify({
          name: person.displayName,
          aliases: person.aliases,
          relationship: person.relationship,
          notes: person.notes,
          details: person.details,
        })
          .toLowerCase()
          .includes(needle),
      )
      .slice(0, limit);
  }

  async deletePerson(userId: string, personId: string): Promise<boolean> {
    const existing = this.people.get(personId);
    if (!existing || existing.userId !== userId) return false;
    this.people.delete(personId);
    this.templates.delete(personId);
    return true;
  }

  async addFaceSample(
    input: AddPersonFaceSampleInput,
  ): Promise<PersonFaceSample | null> {
    const person = this.people.get(input.personId);
    if (!person || person.userId !== input.userId) return null;
    const duplicate = [...this.templates.values()]
      .flat()
      .find((sample) => sample.imageSha256 === input.imageSha256);
    if (duplicate && duplicate.personId !== input.personId) {
      throw new FaceImageAlreadyEnrolledError();
    }
    if (duplicate) return null;
    const now = new Date("2026-08-23T10:02:00.000Z");
    const sample: PersonFaceTemplate = {
      id: this.uuid(),
      personId: input.personId,
      embedding: [...input.embedding],
      imageSha256: input.imageSha256,
      qualityScore: input.qualityScore,
      detectionScore: input.detectionScore,
      boundingBox: { ...input.boundingBox },
      model: input.model,
      source: input.source ?? null,
      createdAt: now,
      updatedAt: now,
    };
    this.templates.set(input.personId, [
      ...(this.templates.get(input.personId) ?? []),
      sample,
    ]);
    return publicSample(sample);
  }

  async listFaceSamples(
    userId: string,
    personId: string,
  ): Promise<readonly PersonFaceSample[]> {
    if (!(await this.getPerson(userId, personId))) return [];
    return (this.templates.get(personId) ?? []).map(publicSample);
  }

  async listFaceTemplates(
    userId: string,
    personId: string,
  ): Promise<readonly PersonFaceTemplate[]> {
    if (!(await this.getPerson(userId, personId))) return [];
    return (this.templates.get(personId) ?? []).map((sample) => ({
      ...sample,
      embedding: [...sample.embedding],
    }));
  }

  async deleteFaceSample(
    userId: string,
    personId: string,
    sampleId: string,
  ): Promise<boolean> {
    if (!(await this.getPerson(userId, personId))) return false;
    const samples = this.templates.get(personId) ?? [];
    const remaining = samples.filter((sample) => sample.id !== sampleId);
    this.templates.set(personId, remaining);
    return remaining.length !== samples.length;
  }

  async countFaceSamples(userId: string, personId: string): Promise<number> {
    return (await this.listFaceSamples(userId, personId)).length;
  }

  async findNearestFaceCandidates(
    input: FindNearestFaceCandidatesInput,
  ): Promise<readonly FaceMatchCandidate[]> {
    const candidates: FaceMatchCandidate[] = [];
    for (const [personId, samples] of this.templates) {
      const person = this.people.get(personId);
      if (!person || person.userId !== input.userId) continue;
      for (const sample of samples) {
        if (sample.model !== input.model) continue;
        candidates.push({
          sampleId: sample.id,
          personId,
          displayName: person.displayName,
          similarity: cosine(input.embedding, sample.embedding),
          qualityScore: sample.qualityScore,
          detectionScore: sample.detectionScore,
          model: sample.model,
        });
      }
    }
    return candidates
      .sort((left, right) => right.similarity - left.similarity)
      .slice(0, input.limit);
  }

  private requiredPerson(userId: string, personId: string): Person {
    const person = this.people.get(personId);
    if (!person || person.userId !== userId) throw new Error("missing person");
    return this.withCounts(person);
  }

  private withCounts(
    person: Omit<Person, "faceSampleCount" | "faceReady">,
  ): Person {
    const count = this.templates.get(person.id)?.length ?? 0;
    return {
      ...person,
      details: { ...person.details },
      aliases: [...person.aliases],
      faceSampleCount: count,
      faceReady: count >= FACE_READY_SAMPLE_COUNT,
    };
  }

  private unsetOwners(userId: string): void {
    for (const [id, person] of this.people) {
      if (person.userId === userId && person.isOwner) {
        this.people.set(id, { ...person, isOwner: false });
      }
    }
  }

  private uuid(): string {
    return `10000000-0000-4000-8000-${String(this.sequence++).padStart(12, "0")}`;
  }
}

function publicSample(sample: PersonFaceTemplate): PersonFaceSample {
  const { embedding: _embedding, imageSha256: _hash, ...output } = sample;
  return output;
}

function cosine(left: readonly number[], right: readonly number[]): number {
  let dot = 0;
  let leftNorm = 0;
  let rightNorm = 0;
  for (let index = 0; index < left.length; index += 1) {
    const l = left[index] ?? 0;
    const r = right[index] ?? 0;
    dot += l * r;
    leftNorm += l * l;
    rightNorm += r * r;
  }
  return dot / Math.sqrt(leftNorm * rightNorm);
}
