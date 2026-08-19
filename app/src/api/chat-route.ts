import type { FastifyInstance } from "fastify";
import { z } from "zod";

import type { ShivaChatService } from "../services/chat-service.js";
import { ApiError } from "./api-error.js";

const MAX_MESSAGE_CHARACTERS = 20_000;

const chatRequestSchema = z
  .object({
    message: z
      .string()
      .max(MAX_MESSAGE_CHARACTERS)
      .refine((message) => message.trim().length > 0, {
        message: "Message must contain non-whitespace characters.",
      }),
  })
  .strict();

export function registerChatRoute(
  app: FastifyInstance,
  chatService: ShivaChatService,
): void {
  app.post<{ Body: unknown }>("/chat", async (request) => {
    if (request.mediaType !== "application/json") {
      throw new ApiError(
        415,
        "UNSUPPORTED_MEDIA_TYPE",
        "Content-Type must be application/json.",
      );
    }

    const parsedRequest = chatRequestSchema.safeParse(request.body);

    if (!parsedRequest.success) {
      throw new ApiError(
        400,
        "INVALID_REQUEST",
        `Request body must contain a non-empty message of at most ${MAX_MESSAGE_CHARACTERS.toLocaleString("en-US")} characters.`,
      );
    }

    const response = await chatService.respondTo(
      parsedRequest.data.message,
      request.signal,
    );
    return { response };
  });
}
