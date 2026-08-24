import type { FastifyInstance } from "fastify";

import {
  AgentCancelledError,
  AgentEvidenceError,
  AgentTimeoutError,
} from "../agent/agent-loop";
import { AIProviderError } from "../brain/ai-provider";
import { FaceProviderError } from "../face/provider";
import { FaceRecognitionError } from "../face/face-recognition-service";
import { VoiceProviderError } from "../voice/provider";
import { ApiError } from "./api-error";

interface PublicError {
  readonly statusCode: number;
  readonly code: string;
  readonly message: string;
}

export function registerErrorHandling(app: FastifyInstance): void {
  app.setNotFoundHandler((_request, reply) =>
    reply.status(404).send({
      error: {
        code: "NOT_FOUND",
        message: "The requested endpoint does not exist.",
      },
    }),
  );

  app.setErrorHandler((error, request, reply) => {
    const publicError = toPublicError(error);

    if (publicError.statusCode >= 500) {
      request.log.error(
        {
          ...safeErrorLogMetadata(error),
          apiErrorCode: publicError.code,
          providerFailure:
            error instanceof AIProviderError ? error.failure : undefined,
          // Safe to log unlike the generic error message (see
          // safeErrorLogMetadata's doc comment): this is only ever Ollama's
          // own local server response text, never DB/face-derived content.
          providerMessage:
            error instanceof AIProviderError ? error.message : undefined,
        },
        "Request failed",
      );
    } else {
      request.log.warn(
        { apiErrorCode: publicError.code },
        "Request rejected",
      );
    }

    return reply.status(publicError.statusCode).send({
      error: {
        code: publicError.code,
        message: publicError.message,
      },
    });
  });
}

/**
 * Never pass an arbitrary error to Pino's `err` serializer here. Database
 * wrappers can embed SQL parameters in their message, stack, query, and params
 * properties; face queries contain biometric vectors.
 */
export function safeErrorLogMetadata(error: unknown): {
  readonly errorType: string;
  readonly errorCode: string | undefined;
  readonly causeType: string | undefined;
  readonly causeCode: string | undefined;
} {
  const cause = getErrorCause(error);
  return {
    errorType: getErrorType(error),
    errorCode: getErrorMetadata(error).code,
    causeType: cause === undefined ? undefined : getErrorType(cause),
    causeCode:
      cause === undefined ? undefined : getErrorMetadata(cause).code,
  };
}

function toPublicError(error: unknown): PublicError {
  if (error instanceof ApiError) {
    return {
      statusCode: error.statusCode,
      code: error.code,
      message: error.publicMessage,
    };
  }

  if (error instanceof AgentCancelledError) {
    return {
      statusCode: 499,
      code: "REQUEST_CANCELLED",
      message: "The request was cancelled.",
    };
  }

  if (error instanceof AgentEvidenceError) {
    return {
      statusCode: 502,
      code: "AGENT_INVALID_RESPONSE",
      message: "Shiva could not verify the required skill result.",
    };
  }

  if (error instanceof AgentTimeoutError) {
    return {
      statusCode: 504,
      code: "AGENT_TIMEOUT",
      message: "Shiva's skill request did not complete in time.",
    };
  }

  if (error instanceof AIProviderError) {
    return providerErrorToPublicError(error);
  }

  if (error instanceof VoiceProviderError) {
    return voiceProviderErrorToPublicError(error);
  }

  if (error instanceof FaceProviderError) {
    return faceProviderErrorToPublicError(error);
  }

  if (error instanceof FaceRecognitionError) {
    return faceRecognitionErrorToPublicError(error);
  }

  const metadata = getErrorMetadata(error);

  if (
    metadata.code === "FST_ERR_CTP_BODY_TOO_LARGE" ||
    metadata.statusCode === 413
  ) {
    return {
      statusCode: 413,
      code: "PAYLOAD_TOO_LARGE",
      message: "The request body is too large.",
    };
  }

  if (
    metadata.code === "FST_ERR_CTP_INVALID_MEDIA_TYPE" ||
    metadata.statusCode === 415
  ) {
    return {
      statusCode: 415,
      code: "UNSUPPORTED_MEDIA_TYPE",
      message: "The request Content-Type is not supported.",
    };
  }

  if (metadata.statusCode === 400) {
    return {
      statusCode: 400,
      code: "INVALID_REQUEST",
      message: "The request body is not valid JSON.",
    };
  }

  return {
    statusCode: 500,
    code: "INTERNAL_ERROR",
    message: "Shiva could not complete the request.",
  };
}

function faceProviderErrorToPublicError(error: FaceProviderError): PublicError {
  switch (error.failure) {
    case "CANCELLED":
      return {
        statusCode: 499,
        code: "REQUEST_CANCELLED",
        message: "The request was cancelled.",
      };
    case "TIMEOUT":
      return {
        statusCode: 504,
        code: "FACE_TIMEOUT",
        message: "Shiva's face service did not respond in time.",
      };
    case "INVALID_IMAGE":
      return {
        statusCode: 400,
        code: "INVALID_IMAGE",
        message: "The uploaded image could not be analyzed.",
      };
    case "PAYLOAD_TOO_LARGE":
      return {
        statusCode: 413,
        code: "PAYLOAD_TOO_LARGE",
        message: "The uploaded image is too large to analyze.",
      };
    case "UNSUPPORTED_MEDIA_TYPE":
      return {
        statusCode: 415,
        code: "UNSUPPORTED_MEDIA_TYPE",
        message: "Upload a supported JPEG, PNG, or WebP image.",
      };
    case "NO_FACE":
      return {
        statusCode: 422,
        code: "NO_FACE",
        message: "No face was found in the uploaded image.",
      };
    case "MULTIPLE_FACES":
      return {
        statusCode: 422,
        code: "MULTIPLE_FACES",
        message: "Use an enrollment photo containing exactly one person.",
      };
    case "INVALID_RESPONSE":
      return {
        statusCode: 502,
        code: "FACE_INVALID_RESPONSE",
        message: "Shiva's face service returned an invalid response.",
      };
    case "UNAVAILABLE":
      return {
        statusCode: 503,
        code: "FACE_UNAVAILABLE",
        message: "Shiva's face service is currently unavailable.",
      };
  }
}

function faceRecognitionErrorToPublicError(
  error: FaceRecognitionError,
): PublicError {
  switch (error.code) {
    case "PERSON_NOT_FOUND":
      return { statusCode: 404, code: error.code, message: error.publicMessage };
    case "NO_FACE":
    case "MULTIPLE_FACES":
    case "LOW_QUALITY":
      return { statusCode: 422, code: error.code, message: error.publicMessage };
    case "PERSON_NOT_ENROLLED":
    case "FACE_MISMATCH":
    case "DUPLICATE_FACE":
      return { statusCode: 409, code: error.code, message: error.publicMessage };
  }
}

function voiceProviderErrorToPublicError(
  error: VoiceProviderError,
): PublicError {
  if (error.failure === "CANCELLED") {
    return {
      statusCode: 499,
      code: "REQUEST_CANCELLED",
      message: "The request was cancelled.",
    };
  }

  if (error.service === "asr" && error.failure === "INVALID_AUDIO") {
    return {
      statusCode: 400,
      code: "INVALID_AUDIO",
      message: "The uploaded audio could not be transcribed.",
    };
  }

  const serviceName = error.service === "asr" ? "transcription" : "speech";
  return {
    statusCode: error.failure === "TIMEOUT" ? 504 : 503,
    code: error.service === "asr" ? "ASR_UNAVAILABLE" : "TTS_UNAVAILABLE",
    message: `Shiva's ${serviceName} service is currently unavailable.`,
  };
}

function getErrorMetadata(error: unknown): {
  readonly code: string | undefined;
  readonly statusCode: number | undefined;
} {
  if (typeof error !== "object" || error === null) {
    return { code: undefined, statusCode: undefined };
  }

  const candidate = error as { code?: unknown; statusCode?: unknown };
  return {
    code: typeof candidate.code === "string" ? candidate.code : undefined,
    statusCode:
      typeof candidate.statusCode === "number"
        ? candidate.statusCode
        : undefined,
  };
}

function getErrorCause(error: unknown): unknown {
  if (typeof error !== "object" || error === null || !("cause" in error)) {
    return undefined;
  }
  return error.cause;
}

function getErrorType(error: unknown): string {
  if (error instanceof Error && error.name.trim()) {
    return error.name;
  }
  if (error === null) return "null";
  return typeof error;
}

function providerErrorToPublicError(error: AIProviderError): PublicError {
  switch (error.failure) {
    case "CANCELLED":
      return {
        statusCode: 499,
        code: "REQUEST_CANCELLED",
        message: "The request was cancelled.",
      };
    case "TIMEOUT":
      return {
        statusCode: 504,
        code: "MODEL_TIMEOUT",
        message: "Shiva's local model did not respond in time.",
      };
    case "INVALID_RESPONSE":
      return {
        statusCode: 502,
        code: "MODEL_INVALID_RESPONSE",
        message: "Shiva's local model returned an invalid response.",
      };
    case "UNAVAILABLE":
    case "UPSTREAM_ERROR":
      return {
        statusCode: 503,
        code: "MODEL_UNAVAILABLE",
        message: "Shiva's local model is currently unavailable.",
      };
  }
}
