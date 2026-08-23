import type {
  FastifyInstance,
  FastifyReply,
  FastifyRequest,
} from "fastify";
import { z } from "zod";

import {
  FaceRecognitionError,
  type FaceIdentificationResult,
  type FaceRecognitionService,
} from "../face/face-recognition-service";
import type { FaceProvider } from "../face/provider";
import { createPeoplePage } from "../people/people-ui";
import type {
  PeopleRepositoryPort,
  Person,
  PersonFaceSample,
} from "../people/types";
import { ApiError } from "./api-error";

const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
const IMAGE_CONTENT_TYPES = ["image/jpeg", "image/png", "image/webp"] as const;

const detailsSchema = z
  .record(z.string().trim().min(1).max(128), z.string().trim().min(1).max(4_000))
  .refine((value) => Object.keys(value).length <= 100, {
    message: "Details cannot contain more than 100 entries.",
  });
const personFieldsSchema = z.object({
  displayName: z.string().trim().min(1).max(255),
  isOwner: z.boolean(),
  relationship: z.string().trim().min(1).max(500).nullable().optional(),
  notes: z.string().trim().min(1).max(10_000).nullable().optional(),
  details: detailsSchema,
  aliases: z.array(z.string().trim().min(1).max(255)).max(50),
});
const createPersonSchema = personFieldsSchema
  .extend({
    isOwner: personFieldsSchema.shape.isOwner.default(false),
    details: personFieldsSchema.shape.details.default({}),
    aliases: personFieldsSchema.shape.aliases.default([]),
  })
  .strict();
const updatePersonSchema = personFieldsSchema
  .partial()
  .strict()
  .refine((value) => Object.keys(value).length > 0, {
    message: "At least one person field is required.",
  });
const personParamsSchema = z.object({ personId: z.string().uuid() }).strict();
const faceParamsSchema = z
  .object({ personId: z.string().uuid(), faceId: z.string().uuid() })
  .strict();
const personQuerySchema = z.object({ personId: z.string().uuid() }).strict();

export interface PeopleRouteOptions {
  readonly repository: PeopleRepositoryPort;
  readonly recognition: FaceRecognitionService;
  readonly provider: FaceProvider;
  readonly userId: string;
  readonly userName: string;
}

export function registerPeopleRoutes(
  app: FastifyInstance,
  options: PeopleRouteOptions,
): void {
  for (const contentType of IMAGE_CONTENT_TYPES) {
    app.addContentTypeParser(
      contentType,
      { parseAs: "buffer", bodyLimit: MAX_IMAGE_BYTES },
      (_request, body, done) => done(null, body),
    );
  }

  app.get("/people", (_request, reply) =>
    reply
      .header("cache-control", "no-store")
      .header(
        "content-security-policy",
        "default-src 'self'; connect-src 'self'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src 'self' blob: data:; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'",
      )
      .type("text/html; charset=utf-8")
      .send(createPeoplePage()),
  );

  app.get("/api/people", async (_request, reply) => {
    const people = await options.repository.listPeople(options.userId);
    return noStore(reply).send({ people: people.map(publicPerson) });
  });

  app.post<{ Body: unknown }>("/api/people", async (request, reply) => {
    requireJson(request);
    const parsed = createPersonSchema.safeParse(request.body);
    if (!parsed.success) throw invalidPersonRequest();

    const person = await repositoryOperation(async () => {
      await options.repository.ensureUser(options.userId, options.userName);
      return options.repository.createPerson({
        userId: options.userId,
        displayName: parsed.data.displayName,
        isOwner: parsed.data.isOwner,
        details: parsed.data.details,
        aliases: parsed.data.aliases,
        ...(parsed.data.relationship !== undefined
          ? { relationship: parsed.data.relationship }
          : {}),
        ...(parsed.data.notes !== undefined ? { notes: parsed.data.notes } : {}),
      });
    });
    return noStore(reply).status(201).send({ person: publicPerson(person) });
  });

  app.get<{ Params: unknown }>(
    "/api/people/:personId",
    async (request, reply) => {
      const { personId } = parsePersonParams(request.params);
      const person = await options.repository.getPerson(options.userId, personId);
      if (!person) throw personNotFound();
      const faceSamples = await options.repository.listFaceSamples(
        options.userId,
        personId,
      );
      return noStore(reply).send({
        person: publicPerson(person),
        faceSamples: faceSamples.map(publicFaceSample),
      });
    },
  );

  app.patch<{ Params: unknown; Body: unknown }>(
    "/api/people/:personId",
    async (request, reply) => {
      requireJson(request);
      const { personId } = parsePersonParams(request.params);
      const parsed = updatePersonSchema.safeParse(request.body);
      if (!parsed.success) throw invalidPersonRequest();
      const person = await repositoryOperation(() =>
        options.repository.updatePerson({
          userId: options.userId,
          personId,
          ...(parsed.data.displayName !== undefined
            ? { displayName: parsed.data.displayName }
            : {}),
          ...(parsed.data.isOwner !== undefined
            ? { isOwner: parsed.data.isOwner }
            : {}),
          ...(parsed.data.relationship !== undefined
            ? { relationship: parsed.data.relationship }
            : {}),
          ...(parsed.data.notes !== undefined
            ? { notes: parsed.data.notes }
            : {}),
          ...(parsed.data.details !== undefined
            ? { details: parsed.data.details }
            : {}),
          ...(parsed.data.aliases !== undefined
            ? { aliases: parsed.data.aliases }
            : {}),
        }),
      );
      if (!person) throw personNotFound();
      return noStore(reply).send({ person: publicPerson(person) });
    },
  );

  app.delete<{ Params: unknown }>(
    "/api/people/:personId",
    async (request, reply) => {
      const { personId } = parsePersonParams(request.params);
      const deleted = await options.repository.deletePerson(
        options.userId,
        personId,
      );
      if (!deleted) throw personNotFound();
      return noStore(reply).status(204).send();
    },
  );

  app.post<{ Params: unknown; Body: unknown }>(
    "/api/people/:personId/faces",
    async (request, reply) => {
      const { personId } = parsePersonParams(request.params);
      const result = await enrollUploadedFace(request, personId, options);
      return noStore(reply).status(201).send({
        person: publicPerson(result.person),
        faceSample: publicFaceSample(result.faceSample),
        consistencySimilarity: result.consistencySimilarity,
      });
    },
  );

  // Stable face capability contract for non-UI clients.
  app.post<{ Querystring: unknown; Body: unknown }>(
    "/face/enroll",
    async (request, reply) => {
      const parsed = personQuerySchema.safeParse(request.query);
      if (!parsed.success) {
        throw new ApiError(
          400,
          "INVALID_REQUEST",
          "A valid personId query parameter is required.",
        );
      }
      const result = await enrollUploadedFace(
        request,
        parsed.data.personId,
        options,
      );
      return noStore(reply).status(201).send({
        person: publicPerson(result.person),
        faceSample: publicFaceSample(result.faceSample),
        consistencySimilarity: result.consistencySimilarity,
      });
    },
  );

  app.delete<{ Params: unknown }>(
    "/api/people/:personId/faces/:faceId",
    async (request, reply) => {
      const parsed = faceParamsSchema.safeParse(request.params);
      if (!parsed.success) throw personNotFound();
      const deleted = await options.repository.deleteFaceSample(
        options.userId,
        parsed.data.personId,
        parsed.data.faceId,
      );
      if (!deleted) {
        throw new ApiError(
          404,
          "FACE_SAMPLE_NOT_FOUND",
          "That enrolled face sample does not exist.",
        );
      }
      return noStore(reply).status(204).send();
    },
  );

  app.post<{ Body: unknown }>("/face/identify", async (request, reply) => {
    const image = uploadedImage(request);
    const result = await withRequestCancellation(request, (signal) =>
      options.recognition.identify({
        userId: options.userId,
        image,
        contentType: requiredImageContentType(request),
        signal,
      }),
    );
    return noStore(reply).send(publicIdentification(result));
  });

  app.post<{ Querystring: unknown; Body: unknown }>(
    "/face/verify",
    async (request, reply) => {
      const query = personQuerySchema.safeParse(request.query);
      if (!query.success) {
        throw new ApiError(
          400,
          "INVALID_REQUEST",
          "A valid personId query parameter is required.",
        );
      }
      const image = uploadedImage(request);
      const result = await withRequestCancellation(request, (signal) =>
        options.recognition.verify({
          userId: options.userId,
          personId: query.data.personId,
          image,
          contentType: requiredImageContentType(request),
          signal,
        }),
      );
      return noStore(reply).send({
        ...result,
        person: publicPerson(result.person),
      });
    },
  );

  app.get("/face/health", async (request, reply) => {
    const result = await withRequestCancellation(request, (signal) =>
      options.provider.health(signal),
    );
    return noStore(reply).send(result);
  });
}

async function enrollUploadedFace(
  request: FastifyRequest,
  personId: string,
  options: PeopleRouteOptions,
) {
  const image = uploadedImage(request);
  const source = sourceFilename(request);
  try {
    return await withRequestCancellation(request, (signal) =>
      options.recognition.enroll({
        userId: options.userId,
        personId,
        image,
        contentType: requiredImageContentType(request),
        ...(source ? { source } : {}),
        signal,
      }),
    );
  } catch (error: unknown) {
    if (error instanceof FaceRecognitionError) {
      throw recognitionApiError(error);
    }
    throw error;
  }
}

function uploadedImage(request: FastifyRequest): Buffer {
  requiredImageContentType(request);
  if (!Buffer.isBuffer(request.body) || request.body.byteLength === 0) {
    throw new ApiError(
      400,
      "INVALID_IMAGE",
      "Upload one non-empty JPEG, PNG, or WebP image.",
    );
  }
  return request.body;
}

function requiredImageContentType(request: FastifyRequest): string {
  const mediaType = request.mediaType;
  if (!mediaType || !(IMAGE_CONTENT_TYPES as readonly string[]).includes(mediaType)) {
    throw new ApiError(
      415,
      "UNSUPPORTED_MEDIA_TYPE",
      "Upload a JPEG, PNG, or WebP image.",
    );
  }
  return mediaType;
}

function sourceFilename(request: FastifyRequest): string | undefined {
  const header = request.headers["x-shiva-file-name"];
  const raw = Array.isArray(header) ? header[0] : header;
  if (!raw) return undefined;
  const leaf = raw.split(/[\\/]/).at(-1)?.replace(/[\u0000-\u001f\u007f]/g, "").trim();
  return leaf ? leaf.slice(0, 255) : undefined;
}

function publicPerson(person: Person) {
  return {
    id: person.id,
    displayName: person.displayName,
    isOwner: person.isOwner,
    relationship: person.relationship,
    notes: person.notes,
    details: person.details,
    aliases: person.aliases,
    faceSampleCount: person.faceSampleCount,
    faceReady: person.faceReady,
    createdAt: person.createdAt.toISOString(),
    updatedAt: person.updatedAt.toISOString(),
  };
}

function publicFaceSample(sample: PersonFaceSample) {
  return {
    id: sample.id,
    personId: sample.personId,
    qualityScore: sample.qualityScore,
    detectionScore: sample.detectionScore,
    boundingBox: sample.boundingBox,
    model: sample.model,
    createdAt: sample.createdAt.toISOString(),
    updatedAt: sample.updatedAt.toISOString(),
  };
}

function publicIdentification(result: FaceIdentificationResult) {
  return {
    ...result,
    faces: result.faces.map((face) => ({
      ...face,
      match: face.match
        ? { ...face.match, person: publicPerson(face.match.person) }
        : null,
    })),
  };
}

function parsePersonParams(input: unknown): { readonly personId: string } {
  const parsed = personParamsSchema.safeParse(input);
  if (!parsed.success) throw personNotFound();
  return parsed.data;
}

function recognitionApiError(error: FaceRecognitionError): ApiError {
  switch (error.code) {
    case "PERSON_NOT_FOUND":
      return new ApiError(404, error.code, error.publicMessage);
    case "LOW_QUALITY":
    case "NO_FACE":
    case "MULTIPLE_FACES":
      return new ApiError(422, error.code, error.publicMessage);
    case "PERSON_NOT_ENROLLED":
    case "FACE_MISMATCH":
    case "DUPLICATE_FACE":
      return new ApiError(409, error.code, error.publicMessage);
  }
}

function requireJson(request: FastifyRequest): void {
  if (request.mediaType !== "application/json") {
    throw new ApiError(
      415,
      "UNSUPPORTED_MEDIA_TYPE",
      "Content-Type must be application/json.",
    );
  }
}

function invalidPersonRequest(): ApiError {
  return new ApiError(
    400,
    "INVALID_PERSON",
    "Person details are invalid or exceed Shiva's supported limits.",
  );
}

function personNotFound(): ApiError {
  return new ApiError(
    404,
    "PERSON_NOT_FOUND",
    "That person does not exist in Shiva's people directory.",
  );
}

async function repositoryOperation<T>(operation: () => Promise<T>): Promise<T> {
  try {
    return await operation();
  } catch (error: unknown) {
    if (error instanceof TypeError || error instanceof RangeError) {
      throw invalidPersonRequest();
    }
    throw error;
  }
}

async function withRequestCancellation<T>(
  request: FastifyRequest,
  operation: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
  const controller = new AbortController();
  const abort = (): void => controller.abort();
  request.raw.once("aborted", abort);
  try {
    return await operation(controller.signal);
  } finally {
    request.raw.removeListener("aborted", abort);
  }
}

function noStore(reply: FastifyReply): FastifyReply {
  reply.header("cache-control", "no-store");
  return reply;
}
