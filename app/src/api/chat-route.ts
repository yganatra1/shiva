import type { FastifyInstance } from "fastify";
import { once } from "node:events";
import { z } from "zod";

import type {
  ChatInteractionMode,
  ShivaChatService,
} from "../services/chat-service";
import { ConversationNotFoundError } from "../memory/memory-repository";
import {
  ChatPerformanceTrace,
  formatChatPerformanceLog,
  type ChatPerformanceLogSink,
  type ChatPerformanceOutcome,
} from "../observability/chat-performance";
import { sanitizeAuditText } from "../security/audit-sanitizer";
import { ApiError } from "./api-error";

const MAX_MESSAGE_CHARACTERS = 20_000;
/** Base64 JPEG from the phone — keep under Ollama / Fastify body comfort. */
const MAX_CHAT_IMAGE_BASE64_CHARS = 1_500_000;
const MAX_CHAT_IMAGES = 4;

interface ChatRouteOptions {
  readonly performanceLogging: boolean;
  readonly performanceLogSink?: ChatPerformanceLogSink;
}

const chatRequestSchema = z
  .object({
    message: z.string().max(MAX_MESSAGE_CHARACTERS),
    conversationId: z.string().uuid().optional(),
    /** Raw base64 image bytes (no data: URI prefix) for vision-capable models. */
    images: z
      .array(z.string().trim().min(1).max(MAX_CHAT_IMAGE_BASE64_CHARS))
      .max(MAX_CHAT_IMAGES)
      .optional(),
  })
  .strict()
  .superRefine((value, context) => {
    const hasText = value.message.trim().length > 0;
    const hasImages = (value.images?.length ?? 0) > 0;
    if (!hasText && !hasImages) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Message must contain text and/or at least one image.",
        path: ["message"],
      });
    }
  });

export function registerChatRoute(
  app: FastifyInstance,
  chatService: ShivaChatService,
  options: ChatRouteOptions,
): void {
  registerStreamingChatRoute(app, "/chat", "text", chatService, options);
}

/**
 * Diagnostic voice-styled streaming chat over plain HTTP. The realtime browser
 * client uses the `/voice/chat` WebSocket instead; this route exists so voice
 * prompting can be exercised with curl and without audio.
 */
export function registerVoiceChatDiagnosticRoute(
  app: FastifyInstance,
  chatService: ShivaChatService,
  options: ChatRouteOptions,
): void {
  registerStreamingChatRoute(
    app,
    "/voice/chat",
    "voice",
    chatService,
    options,
  );
}

function registerStreamingChatRoute(
  app: FastifyInstance,
  path: "/chat" | "/voice/chat",
  interactionMode: ChatInteractionMode,
  chatService: ShivaChatService,
  options: ChatRouteOptions,
): void {
  app.post<{ Body: unknown }>(path, async (request, reply) => {
    const performance = options.performanceLogging
      ? new ChatPerformanceTrace({
          requestId: request.id,
          sink:
            options.performanceLogSink ??
            ((entry) => {
              request.log.info(
                { shivaPerformance: entry },
                formatChatPerformanceLog(entry),
              );
            }),
        })
      : undefined;
    let outcome: ChatPerformanceOutcome = "success";

    try {
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
          `Request body must contain a message (text and/or images) of at most ${MAX_MESSAGE_CHARACTERS.toLocaleString("en-US")} characters.`,
        );
      }

      request.log.info(
        { message: sanitizeAuditText(parsedRequest.data.message) },
        "Chat message received",
      );

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
          {
            mode: interactionMode,
            ...(performance ? { performance } : {}),
          },
          parsedRequest.data.images,
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

        outcome = clientDisconnectController.signal.aborted
          ? "cancelled"
          : "stream-error";
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
    } catch (error: unknown) {
      outcome = "error";
      throw error;
    } finally {
      performance?.finishForeground(outcome);
    }
  });
}
