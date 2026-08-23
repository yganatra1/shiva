import type { FastifyInstance } from "fastify";
import { z } from "zod";

import type { ExecutionStatusPort } from "../security/execution-status";
import { ApiError } from "./api-error";

const querySchema = z
  .object({ conversationId: z.string().uuid().optional() })
  .strict();

export function registerExecutionSettingsRoute(
  app: FastifyInstance,
  status: ExecutionStatusPort,
): void {
  app.get<{ Querystring: unknown }>("/settings/execution", async (request, reply) => {
    const parsed = querySchema.safeParse(request.query);
    if (!parsed.success) {
      throw new ApiError(
        400,
        "INVALID_REQUEST",
        "conversationId must be a UUID when provided.",
      );
    }
    reply.header("cache-control", "no-store");
    return status.getStatus(parsed.data.conversationId);
  });
}
