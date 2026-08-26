export const PERSON_FACE_EMBEDDING_DIMENSIONS = 512;
export const FACE_READY_SAMPLE_COUNT = 5;

export class FaceImageAlreadyEnrolledError extends Error {
  override readonly name = "FaceImageAlreadyEnrolledError";
}

/** Thrown by createPerson/updatePerson instead of silently creating a duplicate person record. */
export class PersonAlreadyExistsError extends Error {
  override readonly name = "PersonAlreadyExistsError";

  constructor(
    readonly existingPersonId: string,
    readonly existingDisplayName: string,
    message: string,
  ) {
    super(message);
  }
}

export type PersonDetails = Readonly<Record<string, string>>;

export interface FaceBoundingBox {
  readonly x1: number;
  readonly y1: number;
  readonly x2: number;
  readonly y2: number;
}

/** Public person model. Biometric vectors and source hashes are excluded. */
export interface Person {
  readonly id: string;
  readonly userId: string;
  readonly displayName: string;
  readonly isOwner: boolean;
  readonly relationship: string | null;
  readonly notes: string | null;
  readonly details: PersonDetails;
  readonly aliases: readonly string[];
  readonly faceSampleCount: number;
  readonly faceReady: boolean;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

/** Public metadata for an enrolled face sample. */
export interface PersonFaceSample {
  readonly id: string;
  readonly personId: string;
  readonly qualityScore: number;
  readonly detectionScore: number;
  readonly boundingBox: FaceBoundingBox;
  readonly model: string;
  readonly source: string | null;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

/** Internal biometric template. Never serialize this object in a public API. */
export interface PersonFaceTemplate extends PersonFaceSample {
  readonly embedding: readonly number[];
  readonly imageSha256: string;
}

export interface CreatePersonInput {
  readonly userId: string;
  readonly displayName: string;
  readonly isOwner?: boolean;
  readonly relationship?: string | null;
  readonly notes?: string | null;
  readonly details?: PersonDetails;
  readonly aliases?: readonly string[];
}

export interface UpdatePersonInput {
  readonly userId: string;
  readonly personId: string;
  readonly displayName?: string;
  readonly isOwner?: boolean;
  readonly relationship?: string | null;
  readonly notes?: string | null;
  readonly details?: PersonDetails;
  readonly aliases?: readonly string[];
}

/** Internal persistence input. Never serialize this object in an API response. */
export interface AddPersonFaceSampleInput {
  readonly userId: string;
  readonly personId: string;
  readonly embedding: readonly number[];
  readonly qualityScore: number;
  readonly detectionScore: number;
  readonly boundingBox: FaceBoundingBox;
  readonly model: string;
  readonly source?: string | null;
  readonly imageSha256: string;
}

/** A directed person-to-person edge, e.g. Yash --father--> Rajesh. */
export interface PersonRelationship {
  readonly id: string;
  readonly userId: string;
  readonly fromPersonId: string;
  readonly toPersonId: string;
  readonly toPersonDisplayName: string;
  readonly relationship: string;
  readonly notes: string | null;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

export interface AddPersonRelationshipInput {
  readonly userId: string;
  readonly fromPersonId: string;
  readonly toPersonId: string;
  readonly relationship: string;
  readonly notes?: string | null;
}

export interface FindNearestFaceCandidatesInput {
  readonly userId: string;
  readonly embedding: readonly number[];
  readonly model: string;
  readonly limit: number;
}

/** The best compatible gallery-template candidate for one person. */
export interface FaceMatchCandidate {
  readonly sampleId: string;
  readonly personId: string;
  readonly displayName: string;
  readonly similarity: number;
  readonly qualityScore: number;
  readonly detectionScore: number;
  readonly model: string;
}

export interface PeopleRepositoryPort {
  ensureUser(userId: string, displayName: string): Promise<void>;
  createPerson(input: CreatePersonInput): Promise<Person>;
  updatePerson(input: UpdatePersonInput): Promise<Person | null>;
  getPerson(userId: string, personId: string): Promise<Person | null>;
  listPeople(userId: string): Promise<readonly Person[]>;
  searchPeople(
    userId: string,
    query: string,
    limit?: number,
  ): Promise<readonly Person[]>;
  deletePerson(userId: string, personId: string): Promise<boolean>;
  addFaceSample(
    input: AddPersonFaceSampleInput,
  ): Promise<PersonFaceSample | null>;
  listFaceSamples(
    userId: string,
    personId: string,
  ): Promise<readonly PersonFaceSample[]>;
  listFaceTemplates(
    userId: string,
    personId: string,
  ): Promise<readonly PersonFaceTemplate[]>;
  deleteFaceSample(
    userId: string,
    personId: string,
    sampleId: string,
  ): Promise<boolean>;
  countFaceSamples(userId: string, personId: string): Promise<number>;
  findNearestFaceCandidates(
    input: FindNearestFaceCandidatesInput,
  ): Promise<readonly FaceMatchCandidate[]>;
  addRelationship(
    input: AddPersonRelationshipInput,
  ): Promise<PersonRelationship>;
  /** Outgoing edges only, e.g. listRelationshipsFrom(yash) -> [{relationship:"father", toPersonId:rajesh}, ...]. */
  listRelationshipsFrom(
    userId: string,
    personId: string,
  ): Promise<readonly PersonRelationship[]>;
}
