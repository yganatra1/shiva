import type { FastifyInstance } from "fastify";
import { once } from "node:events";
import { z } from "zod";

import type { ShivaChatService } from "../services/chat-service.js";
import { ConversationNotFoundError } from "../memory/memory-repository.js";
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
    conversationId: z.string().uuid().optional(),
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
      const preparedChat = await chatService.startResponseTo(
        parsedRequest.data.message,
        parsedRequest.data.conversationId,
        clientDisconnectController.signal,
      );
      reply.header("x-shiva-conversation-id", preparedChat.conversationId);

      for await (const chunk of preparedChat.chunks) {
        if (!streamStarted) {
          reply.hijack();
          reply.raw.writeHead(200, {
            "cache-control": "no-cache, no-transform",
            "content-type": "text/plain; charset=utf-8",
            "x-content-type-options": "nosniff",
            "x-shiva-conversation-id": preparedChat.conversationId,
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
      if (error instanceof ConversationNotFoundError) {
        throw new ApiError(
          404,
          "CONVERSATION_NOT_FOUND",
          "The requested conversation does not exist.",
        );
      }

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
