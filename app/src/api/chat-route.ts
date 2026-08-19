import type { FastifyInstance } from "fastify";
import { once } from "node:events";
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
  app.post<{ Body: unknown }>("/chat", async (request, reply) => {
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

    const clientDisconnectController = new AbortController();
    const abortOnPrematureClose = (): void => {
      if (!reply.raw.writableEnded) {
        clientDisconnectController.abort();
      }
    };

    reply.raw.once("close", abortOnPrematureClose);
    if (reply.raw.destroyed && !reply.raw.writableEnded) {
      clientDisconnectController.abort();
    }

    let streamStarted = false;

    try {
      for await (const chunk of chatService.streamResponseTo(
        parsedRequest.data.message,
        clientDisconnectController.signal,
      )) {
        if (!streamStarted) {
          reply.hijack();
          reply.raw.writeHead(200, {
            "cache-control": "no-cache, no-transform",
            "content-type": "text/plain; charset=utf-8",
            "x-content-type-options": "nosniff",
          });
          streamStarted = true;
        }

        if (!reply.raw.write(chunk.content)) {
          await once(reply.raw, "drain", {
            signal: clientDisconnectController.signal,
          });
        }
      }

      if (streamStarted && !reply.raw.destroyed) {
        reply.raw.end();
      }
    } catch (error: unknown) {
      if (!streamStarted) {
        throw error;
      }

      if (!clientDisconnectController.signal.aborted) {
        request.log.error({ err: error }, "Streaming chat response failed");
      }

      if (!reply.raw.destroyed) {
        reply.raw.destroy();
      }
    } finally {
      reply.raw.removeListener("close", abortOnPrematureClose);
    }

    return reply;
  });
}
