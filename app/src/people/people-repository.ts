import {
  and,
  asc,
  cosineDistance,
  desc,
  eq,
  inArray,
  or,
  sql,
} from "drizzle-orm";

import type { ShivaDatabase } from "../database/pool.js";
import {
  people,
  personAliases,
  personFaceEmbeddings,
  users,
} from "../database/schema.js";
import {
  FACE_READY_SAMPLE_COUNT,
  FaceImageAlreadyEnrolledError,
  PERSON_FACE_EMBEDDING_DIMENSIONS,
  type AddPersonFaceSampleInput,
  type CreatePersonInput,
  type FaceBoundingBox,
  type FaceMatchCandidate,
  type FindNearestFaceCandidatesInput,
  type PeopleRepositoryPort,
  type Person,
  type PersonDetails,
  type PersonFaceSample,
  type PersonFaceTemplate,
  type UpdatePersonInput,
} from "./types.js";

const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SHA256 = /^[a-f0-9]{64}$/i;
const MAX_DISPLAY_NAME_CHARACTERS = 255;
const MAX_RELATIONSHIP_CHARACTERS = 500;
const MAX_NOTES_CHARACTERS = 10_000;
const MAX_ALIAS_CHARACTERS = 255;
const MAX_ALIASES = 50;
const MAX_DETAIL_ENTRIES = 100;
const MAX_DETAIL_KEY_CHARACTERS = 128;
const MAX_DETAIL_VALUE_CHARACTERS = 4_000;
const MAX_SEARCH_RESULTS = 100;

type PersonRow = typeof people.$inferSelect;
type FaceSampleRow = typeof personFaceEmbeddings.$inferSelect;

interface PersonCountRow {
  readonly person: PersonRow;
  readonly faceSampleCount: number;
}

/** PostgreSQL-backed structured person directory and biometric gallery. */
export class DrizzlePeopleRepository implements PeopleRepositoryPort {
  constructor(private readonly database: ShivaDatabase) {}

  async ensureUser(userId: string, displayName: string): Promise<void> {
    assertUuid(userId, "userId");
    const normalizedName = requiredText(
      displayName,
      "displayName",
      MAX_DISPLAY_NAME_CHARACTERS,
    );
    await this.database
      .insert(users)
      .values({ id: userId, displayName: normalizedName })
      .onConflictDoUpdate({
        target: users.id,
        set: { displayName: normalizedName, updatedAt: new Date() },
      });
  }

  async createPerson(input: CreatePersonInput): Promise<Person> {
    const normalized = validateCreatePersonInput(input);
    const created = await this.database.transaction(async (transaction) => {
      if (input.isOwner === true) {
        await transaction
          .update(people)
          .set({ isOwner: false, updatedAt: new Date() })
          .where(and(eq(people.userId, input.userId), eq(people.isOwner, true)));
      }
      const [person] = await transaction
        .insert(people)
        .values({
          userId: input.userId,
          displayName: normalized.displayName,
          isOwner: input.isOwner ?? false,
          relationship: normalized.relationship,
          notes: normalized.notes,
          details: normalized.details,
        })
        .returning();
      const inserted = requiredRow(person, "person");
      await insertAliases(transaction, inserted.id, normalized.aliases);
      return inserted;
    });

    return mapPerson(created, normalized.aliases.map(({ alias }) => alias), 0);
  }

  async updatePerson(input: UpdatePersonInput): Promise<Person | null> {
    assertUuid(input.userId, "userId");
    assertUuid(input.personId, "personId");
    const existing = await this.selectPersonRow(input.userId, input.personId);
    if (!existing) return null;

    const displayName =
      input.displayName === undefined
        ? existing.displayName
        : requiredText(
            input.displayName,
            "displayName",
            MAX_DISPLAY_NAME_CHARACTERS,
          );
    const aliases =
      input.aliases === undefined
        ? undefined
        : validatedAliases(input.aliases, displayName);
    const now = new Date();

    await this.database.transaction(async (transaction) => {
      if (input.isOwner === true) {
        await transaction
          .update(people)
          .set({ isOwner: false, updatedAt: now })
          .where(and(eq(people.userId, input.userId), eq(people.isOwner, true)));
      }
      await transaction
        .update(people)
        .set({
          ...(input.displayName !== undefined ? { displayName } : {}),
          ...(input.isOwner !== undefined ? { isOwner: input.isOwner } : {}),
          ...(input.relationship !== undefined
            ? {
                relationship: optionalText(
                  input.relationship,
                  "relationship",
                  MAX_RELATIONSHIP_CHARACTERS,
                ),
              }
            : {}),
          ...(input.notes !== undefined
            ? {
                notes: optionalText(
                  input.notes,
                  "notes",
                  MAX_NOTES_CHARACTERS,
                ),
              }
            : {}),
          ...(input.details !== undefined
            ? { details: validatedDetails(input.details) }
            : {}),
          updatedAt: now,
        })
        .where(
          and(eq(people.id, input.personId), eq(people.userId, input.userId)),
        );

      if (aliases) {
        await transaction
          .delete(personAliases)
          .where(eq(personAliases.personId, input.personId));
        await insertAliases(transaction, input.personId, aliases, now);
      }
    });

    return this.getPerson(input.userId, input.personId);
  }

  async getPerson(userId: string, personId: string): Promise<Person | null> {
    assertUuid(userId, "userId");
    assertUuid(personId, "personId");
    const [row] = await this.selectPeopleWithCounts(
      and(eq(people.userId, userId), eq(people.id, personId)),
    );
    if (!row) return null;
    return (await this.hydratePeople([row]))[0] ?? null;
  }

  async listPeople(userId: string): Promise<readonly Person[]> {
    assertUuid(userId, "userId");
    const rows = await this.selectPeopleWithCounts(eq(people.userId, userId));
    return this.hydratePeople(rows);
  }

  async searchPeople(
    userId: string,
    query: string,
    limit = 25,
  ): Promise<readonly Person[]> {
    assertUuid(userId, "userId");
    const normalizedQuery = normalizeAlias(query);
    if (!normalizedQuery) return [];
    assertLimit(limit);
    // Spacing/casing shouldn't matter for a name lookup ("miralididi" should
    // find "Mirali Didi" and vice versa), so also compare fully
    // whitespace-stripped forms alongside the exact/collapsed-whitespace ones.
    const looseQuery = normalizedQuery.replace(/\s+/g, "");

    const matches = await this.database
      .selectDistinct({
        id: people.id,
        displayName: people.displayName,
      })
      .from(people)
      .leftJoin(personAliases, eq(personAliases.personId, people.id))
      .where(
        and(
          eq(people.userId, userId),
          or(
            containsNormalized(people.displayName, normalizedQuery),
            containsNormalized(people.relationship, normalizedQuery),
            containsNormalized(people.notes, normalizedQuery),
            sql`position(${normalizedQuery} in lower(${people.details}::text)) > 0`,
            sql`position(${normalizedQuery} in ${personAliases.normalizedAlias}) > 0`,
            sql`position(${looseQuery} in regexp_replace(lower(coalesce(${people.displayName}, '')), '\\s+', '', 'g')) > 0`,
            sql`position(${looseQuery} in regexp_replace(${personAliases.normalizedAlias}, '\\s+', '', 'g')) > 0`,
          ),
        ),
      )
      .orderBy(asc(people.displayName), asc(people.id))
      .limit(limit);
    if (matches.length === 0) return [];

    const order = new Map(matches.map((match, index) => [match.id, index]));
    const rows = await this.selectPeopleWithCounts(
      and(
        eq(people.userId, userId),
        inArray(
          people.id,
          matches.map(({ id }) => id),
        ),
      ),
    );
    const hydrated = await this.hydratePeople(rows);
    return hydrated.sort(
      (left, right) =>
        (order.get(left.id) ?? Number.MAX_SAFE_INTEGER) -
        (order.get(right.id) ?? Number.MAX_SAFE_INTEGER),
    );
  }

  async deletePerson(userId: string, personId: string): Promise<boolean> {
    assertUuid(userId, "userId");
    assertUuid(personId, "personId");
    const deleted = await this.database
      .delete(people)
      .where(and(eq(people.id, personId), eq(people.userId, userId)))
      .returning({ id: people.id });
    return deleted.length === 1;
  }

  async addFaceSample(
    input: AddPersonFaceSampleInput,
  ): Promise<PersonFaceSample | null> {
    const normalized = validateFaceSampleInput(input);
    return this.database.transaction(async (transaction) => {
      const [ownedPerson] = await transaction
        .select({ id: people.id })
        .from(people)
        .where(
          and(eq(people.id, input.personId), eq(people.userId, input.userId)),
        )
        .limit(1);
      if (!ownedPerson) return null;

      const [inserted] = await transaction
        .insert(personFaceEmbeddings)
        .values({
          personId: input.personId,
          embedding: normalized.embedding,
          qualityScore: input.qualityScore,
          detectionScore: input.detectionScore,
          boundingBox: normalized.boundingBox,
          model: normalized.model,
          source: normalized.source,
          imageSha256: normalized.imageSha256,
        })
        .onConflictDoNothing({ target: personFaceEmbeddings.imageSha256 })
        .returning();
      if (inserted) return mapFaceSample(inserted);

      const [existing] = await transaction
        .select()
        .from(personFaceEmbeddings)
        .where(eq(personFaceEmbeddings.imageSha256, normalized.imageSha256))
        .limit(1);
      if (!existing) {
        throw new Error(
          "The conflicting face sample disappeared before it could be read.",
        );
      }
      if (existing.personId !== input.personId) {
        throw new FaceImageAlreadyEnrolledError(
          "This source image is already enrolled for another person.",
        );
      }
      return null;
    });
  }

  async listFaceSamples(
    userId: string,
    personId: string,
  ): Promise<readonly PersonFaceSample[]> {
    assertUuid(userId, "userId");
    assertUuid(personId, "personId");
    const rows = await this.database
      .select({ sample: personFaceEmbeddings })
      .from(personFaceEmbeddings)
      .innerJoin(people, eq(people.id, personFaceEmbeddings.personId))
      .where(
        and(
          eq(people.userId, userId),
          eq(personFaceEmbeddings.personId, personId),
        ),
      )
      .orderBy(
        asc(personFaceEmbeddings.createdAt),
        asc(personFaceEmbeddings.id),
      );
    return rows.map(({ sample }) => mapFaceSample(sample));
  }

  async listFaceTemplates(
    userId: string,
    personId: string,
  ): Promise<readonly PersonFaceTemplate[]> {
    assertUuid(userId, "userId");
    assertUuid(personId, "personId");
    const rows = await this.database
      .select({ sample: personFaceEmbeddings })
      .from(personFaceEmbeddings)
      .innerJoin(people, eq(people.id, personFaceEmbeddings.personId))
      .where(
        and(
          eq(people.userId, userId),
          eq(personFaceEmbeddings.personId, personId),
        ),
      )
      .orderBy(
        asc(personFaceEmbeddings.createdAt),
        asc(personFaceEmbeddings.id),
      );
    return rows.map(({ sample }) => mapFaceTemplate(sample));
  }

  async deleteFaceSample(
    userId: string,
    personId: string,
    sampleId: string,
  ): Promise<boolean> {
    assertUuid(userId, "userId");
    assertUuid(personId, "personId");
    assertUuid(sampleId, "sampleId");
    return this.database.transaction(async (transaction) => {
      const [ownedPerson] = await transaction
        .select({ id: people.id })
        .from(people)
        .where(and(eq(people.id, personId), eq(people.userId, userId)))
        .limit(1);
      if (!ownedPerson) return false;
      const deleted = await transaction
        .delete(personFaceEmbeddings)
        .where(
          and(
            eq(personFaceEmbeddings.id, sampleId),
            eq(personFaceEmbeddings.personId, personId),
          ),
        )
        .returning({ id: personFaceEmbeddings.id });
      return deleted.length === 1;
    });
  }

  async countFaceSamples(userId: string, personId: string): Promise<number> {
    assertUuid(userId, "userId");
    assertUuid(personId, "personId");
    const [row] = await this.database
      .select({ count: sql<number>`count(${personFaceEmbeddings.id})::integer` })
      .from(people)
      .leftJoin(
        personFaceEmbeddings,
        eq(personFaceEmbeddings.personId, people.id),
      )
      .where(and(eq(people.userId, userId), eq(people.id, personId)))
      .groupBy(people.id);
    return Number(row?.count ?? 0);
  }

  async findNearestFaceCandidates(
    input: FindNearestFaceCandidatesInput,
  ): Promise<readonly FaceMatchCandidate[]> {
    assertUuid(input.userId, "userId");
    assertLimit(input.limit);
    const embedding = validatedEmbedding(input.embedding);
    const model = requiredText(input.model, "model", 255);
    const distance = cosineDistance(personFaceEmbeddings.embedding, embedding);
    const similarity = sql<number>`1 - (${distance})`.as("similarity");

    // Rank inside each person before applying the public limit. Limiting raw
    // sample rows first lets one large gallery hide every runner-up and can
    // incorrectly suppress the ambiguity safeguard.
    const ranked = this.database
      .select({
        // Drizzle preserves physical column names inside subqueries. Both
        // joined tables expose `id`, so give them distinct SQL aliases before
        // the outer query references them.
        sampleId: sql<string>`${personFaceEmbeddings.id}`.as("sample_id"),
        personId: sql<string>`${people.id}`.as("person_id"),
        displayName: people.displayName,
        similarity,
        qualityScore: personFaceEmbeddings.qualityScore,
        detectionScore: personFaceEmbeddings.detectionScore,
        model: personFaceEmbeddings.model,
        personRank:
          sql<number>`row_number() over (partition by ${people.id} order by ${distance})`.as(
            "person_rank",
          ),
      })
      .from(personFaceEmbeddings)
      .innerJoin(people, eq(people.id, personFaceEmbeddings.personId))
      .where(
        and(
          eq(people.userId, input.userId),
          eq(personFaceEmbeddings.model, model),
        ),
      )
      .as("ranked_face_candidates");

    const candidates = await this.database
      .select({
        sampleId: ranked.sampleId,
        personId: ranked.personId,
        displayName: ranked.displayName,
        similarity: ranked.similarity,
        qualityScore: ranked.qualityScore,
        detectionScore: ranked.detectionScore,
        model: ranked.model,
      })
      .from(ranked)
      .where(eq(ranked.personRank, 1))
      .orderBy(desc(ranked.similarity))
      .limit(input.limit);

    return candidates.map((candidate) => ({
      ...candidate,
      similarity: Number(candidate.similarity),
    }));
  }

  private async selectPersonRow(
    userId: string,
    personId: string,
  ): Promise<PersonRow | null> {
    const [person] = await this.database
      .select()
      .from(people)
      .where(and(eq(people.id, personId), eq(people.userId, userId)))
      .limit(1);
    return person ?? null;
  }

  private async selectPeopleWithCounts(
    condition: ReturnType<typeof eq> | ReturnType<typeof and>,
  ): Promise<readonly PersonCountRow[]> {
    const rows = await this.database
      .select({
        person: people,
        faceSampleCount: sql<number>`count(${personFaceEmbeddings.id})::integer`,
      })
      .from(people)
      .leftJoin(
        personFaceEmbeddings,
        eq(personFaceEmbeddings.personId, people.id),
      )
      .where(condition)
      .groupBy(people.id)
      .orderBy(asc(people.displayName), asc(people.id));
    return rows.map((row) => ({
      person: row.person,
      faceSampleCount: Number(row.faceSampleCount),
    }));
  }

  private async hydratePeople(
    rows: readonly PersonCountRow[],
  ): Promise<Person[]> {
    if (rows.length === 0) return [];
    const aliases = await this.database
      .select()
      .from(personAliases)
      .where(
        inArray(
          personAliases.personId,
          rows.map(({ person }) => person.id),
        ),
      )
      .orderBy(asc(personAliases.normalizedAlias), asc(personAliases.id));
    const aliasesByPerson = new Map<string, string[]>();
    for (const alias of aliases) {
      const existing = aliasesByPerson.get(alias.personId) ?? [];
      existing.push(alias.alias);
      aliasesByPerson.set(alias.personId, existing);
    }
    return rows.map(({ person, faceSampleCount }) =>
      mapPerson(person, aliasesByPerson.get(person.id) ?? [], faceSampleCount),
    );
  }
}

type Transaction = Parameters<
  Parameters<ShivaDatabase["transaction"]>[0]
>[0];

async function insertAliases(
  transaction: Transaction,
  personId: string,
  aliases: readonly ValidatedAlias[],
  now?: Date,
): Promise<void> {
  if (aliases.length === 0) return;
  await transaction.insert(personAliases).values(
    aliases.map(({ alias, normalizedAlias }) => ({
      personId,
      alias,
      normalizedAlias,
      ...(now ? { createdAt: now, updatedAt: now } : {}),
    })),
  );
}

function mapPerson(
  row: PersonRow,
  aliases: readonly string[],
  faceSampleCount: number,
): Person {
  return {
    id: row.id,
    userId: row.userId,
    displayName: row.displayName,
    isOwner: row.isOwner,
    relationship: row.relationship,
    notes: row.notes,
    details: { ...row.details },
    aliases: [...aliases],
    faceSampleCount,
    faceReady: faceSampleCount >= FACE_READY_SAMPLE_COUNT,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function mapFaceSample(row: FaceSampleRow): PersonFaceSample {
  return {
    id: row.id,
    personId: row.personId,
    qualityScore: row.qualityScore,
    detectionScore: row.detectionScore,
    boundingBox: { ...row.boundingBox },
    model: row.model,
    source: row.source,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function mapFaceTemplate(row: FaceSampleRow): PersonFaceTemplate {
  return {
    ...mapFaceSample(row),
    embedding: [...row.embedding],
    imageSha256: row.imageSha256,
  };
}

interface ValidatedAlias {
  readonly alias: string;
  readonly normalizedAlias: string;
}

function validateCreatePersonInput(input: CreatePersonInput): {
  readonly displayName: string;
  readonly relationship: string | null;
  readonly notes: string | null;
  readonly details: PersonDetails;
  readonly aliases: readonly ValidatedAlias[];
} {
  assertUuid(input.userId, "userId");
  const displayName = requiredText(
    input.displayName,
    "displayName",
    MAX_DISPLAY_NAME_CHARACTERS,
  );
  return {
    displayName,
    relationship: optionalText(
      input.relationship ?? null,
      "relationship",
      MAX_RELATIONSHIP_CHARACTERS,
    ),
    notes: optionalText(input.notes ?? null, "notes", MAX_NOTES_CHARACTERS),
    details: validatedDetails(input.details ?? {}),
    aliases: validatedAliases(input.aliases ?? [], displayName),
  };
}

function validateFaceSampleInput(input: AddPersonFaceSampleInput): {
  readonly embedding: number[];
  readonly boundingBox: FaceBoundingBox;
  readonly model: string;
  readonly source: string | null;
  readonly imageSha256: string;
} {
  assertUuid(input.userId, "userId");
  assertUuid(input.personId, "personId");
  assertUnitScore(input.qualityScore, "qualityScore");
  assertUnitScore(input.detectionScore, "detectionScore");
  const boundingBox = validatedBoundingBox(input.boundingBox);
  const imageSha256 = input.imageSha256.trim().toLowerCase();
  if (!SHA256.test(imageSha256)) {
    throw new TypeError("imageSha256 must be a lowercase hexadecimal SHA-256 digest.");
  }
  return {
    embedding: validatedEmbedding(input.embedding),
    boundingBox,
    model: requiredText(input.model, "model", 255),
    source: optionalText(input.source ?? null, "source", 255),
    imageSha256,
  };
}

function validatedAliases(
  input: readonly string[],
  displayName: string,
): readonly ValidatedAlias[] {
  if (input.length > MAX_ALIASES) {
    throw new RangeError(`aliases cannot contain more than ${MAX_ALIASES} entries.`);
  }
  const displayNameKey = normalizeAlias(displayName);
  const aliases = new Map<string, string>();
  for (const value of input) {
    const alias = requiredText(value, "alias", MAX_ALIAS_CHARACTERS);
    const normalizedAlias = normalizeAlias(alias);
    if (normalizedAlias !== displayNameKey && !aliases.has(normalizedAlias)) {
      aliases.set(normalizedAlias, alias);
    }
  }
  return [...aliases].map(([normalizedAlias, alias]) => ({
    alias,
    normalizedAlias,
  }));
}

function validatedDetails(input: PersonDetails): PersonDetails {
  const entries = Object.entries(input);
  if (entries.length > MAX_DETAIL_ENTRIES) {
    throw new RangeError(
      `details cannot contain more than ${MAX_DETAIL_ENTRIES} entries.`,
    );
  }
  const output: Record<string, string> = {};
  for (const [rawKey, rawValue] of entries) {
    const key = requiredText(
      rawKey,
      "detail key",
      MAX_DETAIL_KEY_CHARACTERS,
    );
    const value = requiredText(
      rawValue,
      `details.${key}`,
      MAX_DETAIL_VALUE_CHARACTERS,
    );
    if (Object.hasOwn(output, key)) {
      throw new TypeError(`details contains the duplicate key '${key}'.`);
    }
    output[key] = value;
  }
  return output;
}

function validatedEmbedding(input: readonly number[]): number[] {
  if (input.length !== PERSON_FACE_EMBEDDING_DIMENSIONS) {
    throw new RangeError(
      `Face embeddings must contain exactly ${PERSON_FACE_EMBEDDING_DIMENSIONS} values.`,
    );
  }
  const embedding = [...input];
  let normSquared = 0;
  for (const value of embedding) {
    if (!Number.isFinite(value)) {
      throw new TypeError("Face embeddings must contain only finite numbers.");
    }
    normSquared += value * value;
  }
  if (normSquared === 0) {
    throw new RangeError("Face embeddings cannot be the zero vector.");
  }
  return embedding;
}

function validatedBoundingBox(input: FaceBoundingBox): FaceBoundingBox {
  const values = [input.x1, input.y1, input.x2, input.y2];
  if (!values.every(Number.isFinite)) {
    throw new TypeError("boundingBox must contain only finite coordinates.");
  }
  if (input.x1 < 0 || input.y1 < 0 || input.x2 <= input.x1 || input.y2 <= input.y1) {
    throw new RangeError("boundingBox must have non-negative coordinates and positive area.");
  }
  return { x1: input.x1, y1: input.y1, x2: input.x2, y2: input.y2 };
}

function containsNormalized(
  column: typeof people.displayName | typeof people.relationship | typeof people.notes,
  query: string,
) {
  return sql`position(${query} in lower(coalesce(${column}, ''))) > 0`;
}

function normalizeAlias(value: string): string {
  return value.normalize("NFKC").trim().replace(/\s+/g, " ").toLowerCase();
}

function requiredText(value: string, name: string, maximum: number): string {
  if (typeof value !== "string") {
    throw new TypeError(`${name} must be a string.`);
  }
  const normalized = value.normalize("NFKC").trim().replace(/\s+/g, " ");
  if (!normalized) throw new TypeError(`${name} cannot be empty.`);
  if (normalized.length > maximum) {
    throw new RangeError(`${name} cannot exceed ${maximum} characters.`);
  }
  return normalized;
}

function optionalText(
  value: string | null,
  name: string,
  maximum: number,
): string | null {
  return value === null ? null : requiredText(value, name, maximum);
}

function assertUnitScore(value: number, name: string): void {
  if (!Number.isFinite(value) || value < 0 || value > 1) {
    throw new RangeError(`${name} must be a finite number between 0 and 1.`);
  }
}

function assertLimit(limit: number): void {
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_SEARCH_RESULTS) {
    throw new RangeError(
      `limit must be an integer between 1 and ${MAX_SEARCH_RESULTS}.`,
    );
  }
}

function assertUuid(value: string, name: string): void {
  if (!UUID.test(value)) throw new TypeError(`${name} must be a UUID.`);
}

function requiredRow<T>(row: T | undefined, name: string): T {
  if (!row) throw new Error(`The database did not return the inserted ${name}.`);
  return row;
}
