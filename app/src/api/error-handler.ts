import type { FastifyInstance } from "fastify";

import { AIProviderError } from "../brain/ai-provider.js";
import { ApiError } from "./api-error.js";

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
          err: error,
          apiErrorCode: publicError.code,
          providerFailure:
            error instanceof AIProviderError ? error.failure : undefined,
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

function toPublicError(error: unknown): PublicError {
  if (error instanceof ApiError) {
    return {
      statusCode: error.statusCode,
      code: error.code,
      message: error.publicMessage,
    };
  }

  if (error instanceof AIProviderError) {
    return providerErrorToPublicError(error);
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
      message: "Content-Type must be application/json.",
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
