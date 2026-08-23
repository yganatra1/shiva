import { z } from "zod";

import {
  FACE_EMBEDDING_DIMENSIONS,
  FaceProviderError,
  type FaceAnalysisInput,
  type FaceAnalysisResult,
  type FaceProvider,
  type FaceProviderFailure,
  type FaceProviderHealth,
} from "./provider";

interface HttpFaceProviderOptions {
  readonly baseUrl: string;
  readonly requestTimeoutMs: number;
  readonly fetchImplementation?: typeof fetch;
}

const finiteNumberSchema = z.number().refine(Number.isFinite);
const unitNumberSchema = finiteNumberSchema.min(0).max(1);

const analysisSchema = z
  .object({
    model: z.string().trim().min(1).max(255),
    dimensions: z.literal(FACE_EMBEDDING_DIMENSIONS),
    provider: z.string().trim().min(1).max(255),
    image: z
      .object({
        width: z.number().int().positive(),
        height: z.number().int().positive(),
      })
      .strict(),
    faces: z
      .array(
        z
          .object({
            embedding: z
              .array(finiteNumberSchema)
              .length(FACE_EMBEDDING_DIMENSIONS),
            boundingBox: z
              .object({
                x1: finiteNumberSchema,
                y1: finiteNumberSchema,
                x2: finiteNumberSchema,
                y2: finiteNumberSchema,
              })
              .strict(),
            detectionScore: unitNumberSchema,
            qualityScore: unitNumberSchema,
            enrollmentEligible: z.boolean(),
            rejectionReasons: z.array(z.string().trim().min(1).max(128)).max(12),
          })
          .strict(),
      )
      .max(100),
  })
  .strict();

const healthSchema = z
  .object({
    status: z.literal("ok"),
    service: z.literal("face"),
    model: z.string().trim().min(1).max(255),
    loaded: z.boolean(),
    provider: z.string().trim().min(1).max(255).nullable(),
  })
  .strict();

const upstreamErrorSchema = z.object({
  detail: z
    .union([
      z.string(),
      z.object({ code: z.string().optional(), message: z.string().optional() }),
    ])
    .optional(),
});

export class HttpFaceProvider implements FaceProvider {
  private readonly analyzeEndpoint: URL;
  private readonly healthEndpoint: URL;
  private readonly fetchImplementation: typeof fetch;

  constructor(private readonly options: HttpFaceProviderOptions) {
    this.analyzeEndpoint = new URL("/analyze", options.baseUrl);
    this.healthEndpoint = new URL("/health", options.baseUrl);
    this.fetchImplementation = options.fetchImplementation ?? fetch;
  }

  async analyze(input: FaceAnalysisInput): Promise<FaceAnalysisResult> {
    const endpoint = new URL(this.analyzeEndpoint);
    endpoint.searchParams.set("mode", input.mode);

    return this.withDeadline(input.signal, async (signal) => {
      const response = await this.fetchImplementation(endpoint, {
        method: "POST",
        headers: {
          accept: "application/json",
          "content-type": input.contentType,
        },
        body: Buffer.from(input.image),
        signal,
      });

      if (!response.ok) {
        const failure = await classifyUpstreamFailure(response);
        throw new FaceProviderError(
          failure,
          `Face service returned HTTP status ${response.status}.`,
        );
      }

      const payload = await parseJsonResponse(response);
      const parsed = analysisSchema.safeParse(payload);
      if (!parsed.success || !validFaceGeometry(parsed.data)) {
        throw new FaceProviderError(
          "INVALID_RESPONSE",
          "Face service returned an unexpected response shape.",
        );
      }
      return parsed.data;
    });
  }

  async health(signal?: AbortSignal): Promise<FaceProviderHealth> {
    return this.withDeadline(signal, async (combinedSignal) => {
      const response = await this.fetchImplementation(this.healthEndpoint, {
        method: "GET",
        headers: { accept: "application/json" },
        signal: combinedSignal,
      });
      if (!response.ok) {
        await discardResponseBody(response);
        throw new FaceProviderError(
          "UNAVAILABLE",
          `Face health endpoint returned HTTP status ${response.status}.`,
        );
      }
      const payload = await parseJsonResponse(response);
      const parsed = healthSchema.safeParse(payload);
      if (!parsed.success) {
        throw new FaceProviderError(
          "INVALID_RESPONSE",
          "Face health endpoint returned an unexpected response shape.",
        );
      }
      return parsed.data;
    });
  }

  private async withDeadline<T>(
    callerSignal: AbortSignal | undefined,
    operation: (signal: AbortSignal) => Promise<T>,
  ): Promise<T> {
    const deadlineController = new AbortController();
    const signal = callerSignal
      ? AbortSignal.any([deadlineController.signal, callerSignal])
      : deadlineController.signal;
    const timeout = setTimeout(
      () => deadlineController.abort(),
      this.options.requestTimeoutMs,
    );
    timeout.unref();

    try {
      return await operation(signal);
    } catch (error: unknown) {
      if (error instanceof FaceProviderError) throw error;
      if (callerSignal?.aborted) {
        throw new FaceProviderError(
          "CANCELLED",
          "The client cancelled the face request.",
          { cause: error },
        );
      }
      if (deadlineController.signal.aborted) {
        throw new FaceProviderError(
          "TIMEOUT",
          `Face service did not respond within ${this.options.requestTimeoutMs}ms.`,
          { cause: error },
        );
      }
      throw new FaceProviderError(
        "UNAVAILABLE",
        "The face request could not be completed.",
        { cause: error },
      );
    } finally {
      clearTimeout(timeout);
    }
  }
}

async function parseJsonResponse(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch (error: unknown) {
    throw new FaceProviderError(
      "INVALID_RESPONSE",
      "Face service returned malformed JSON.",
      { cause: error },
    );
  }
}

async function classifyUpstreamFailure(
  response: Response,
): Promise<FaceProviderFailure> {
  let code: string | undefined;
  try {
    const payload = upstreamErrorSchema.safeParse(await response.json());
    if (payload.success && typeof payload.data.detail === "object") {
      code = payload.data.detail.code;
    }
  } catch {
    await discardResponseBody(response);
  }

  if (code === "NO_FACE" || code === "NO_FACE_DETECTED") return "NO_FACE";
  if (code === "MULTIPLE_FACES" || code === "MULTIPLE_FACES_DETECTED") {
    return "MULTIPLE_FACES";
  }
  if (response.status === 413) return "PAYLOAD_TOO_LARGE";
  if (response.status === 415) return "UNSUPPORTED_MEDIA_TYPE";
  if ([400, 422].includes(response.status)) return "INVALID_IMAGE";
  return "UNAVAILABLE";
}

function validFaceGeometry(result: FaceAnalysisResult): boolean {
  return result.faces.every((face) => {
    const box = face.boundingBox;
    const norm = Math.sqrt(
      face.embedding.reduce((sum, value) => sum + value * value, 0),
    );
    return (
      box.x1 >= 0 &&
      box.y1 >= 0 &&
      box.x2 > box.x1 &&
      box.y2 > box.y1 &&
      box.x2 <= result.image.width &&
      box.y2 <= result.image.height &&
      Math.abs(norm - 1) <= 0.02
    );
  });
}

async function discardResponseBody(response: Response): Promise<void> {
  try {
    await response.body?.cancel();
  } catch {
    // Preserve the already-classified upstream status.
  }
}
