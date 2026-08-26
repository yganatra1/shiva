import type {
  FastifyInstance,
  FastifyReply,
  FastifyRequest,
} from "fastify";
import { z } from "zod";

import { ConversationNotFoundError } from "../memory/memory-repository";
import type {
  Conversation,
  ConversationCursor,
  ConversationSummary,
  MemoryRepositoryPort,
  MessageCursor,
  StoredMessage,
} from "../memory/types";
import { ApiError } from "./api-error";

const DEFAULT_CONVERSATION_LIMIT = 50;
const DEFAULT_MESSAGE_LIMIT = 100;
const MAX_PAGE_LIMIT = 100;
const MAX_TITLE_LENGTH = 120;

const listQuerySchema = z
  .object({
    limit: z.coerce.number().int().min(1).max(MAX_PAGE_LIMIT).default(
      DEFAULT_CONVERSATION_LIMIT,
    ),
    cursor: z.string().trim().min(1).max(1_000).optional(),
  })
  .strict();
const messagesQuerySchema = z
  .object({
    limit: z.coerce.number().int().min(1).max(MAX_PAGE_LIMIT).default(
      DEFAULT_MESSAGE_LIMIT,
    ),
    cursor: z.string().trim().min(1).max(1_000).optional(),
  })
  .strict();
const paramsSchema = z
  .object({ conversationId: z.string().uuid() })
  .strict();
const renameSchema = z
  .object({
    title: z.string().trim().min(1).max(MAX_TITLE_LENGTH),
  })
  .strict();
const cursorPayloadSchema = z
  .object({
    at: z.string().datetime({ offset: true }),
    id: z.string().uuid(),
  })
  .strict();

export interface ConversationsRouteOptions {
  readonly repository: MemoryRepositoryPort;
  readonly userId: string;
}

export function registerConversationsRoutes(
  app: FastifyInstance,
  options: ConversationsRouteOptions,
): void {
  app.get<{ Querystring: unknown }>(
    "/api/conversations",
    async (request, reply) => {
      const query = listQuerySchema.safeParse(request.query);
      if (!query.success) throw invalidListRequest();
      const before = query.data.cursor
        ? decodeConversationCursor(query.data.cursor)
        : undefined;
      const rows = await options.repository.listConversations(
        options.userId,
        query.data.limit + 1,
        before,
      );
      const hasMore = rows.length > query.data.limit;
      const page = rows.slice(0, query.data.limit);
      const last = page.at(-1);
      return noStore(reply).send({
        conversations: page.map(publicConversation),
        nextCursor:
          hasMore && last
            ? encodeCursor(last.lastMessageAt, last.id)
            : null,
      });
    },
  );

  app.get<{ Params: unknown; Querystring: unknown }>(
    "/api/conversations/:conversationId/messages",
    async (request, reply) => {
      const { conversationId } = parseParams(request.params);
      const query = messagesQuerySchema.safeParse(request.query);
      if (!query.success) throw invalidListRequest();
      const conversation = await requireConversation(
        options.repository,
        options.userId,
        conversationId,
      );
      const before = query.data.cursor
        ? decodeMessageCursor(query.data.cursor)
        : undefined;
      const rows = await options.repository.listConversationMessages(
        options.userId,
        conversationId,
        query.data.limit + 1,
        before,
      );
      const hasMore = rows.length > query.data.limit;
      const newestFirst = rows.slice(0, query.data.limit);
      const oldest = newestFirst.at(-1);
      return noStore(reply).send({
        conversation: publicConversation(conversation),
        // Clients render a transcript from oldest to newest.
        messages: newestFirst.reverse().map(publicMessage),
        nextCursor:
          hasMore && oldest
            ? encodeCursor(oldest.createdAt, oldest.id)
            : null,
      });
    },
  );

  app.patch<{ Params: unknown; Body: unknown }>(
    "/api/conversations/:conversationId",
    async (request, reply) => {
      requireJson(request);
      const { conversationId } = parseParams(request.params);
      const body = renameSchema.safeParse(request.body);
      if (!body.success) throw invalidTitleRequest();
      const conversation = await options.repository.updateConversationTitle(
        options.userId,
        conversationId,
        body.data.title,
      );
      if (!conversation) throw conversationNotFound();
      return noStore(reply).send({
        conversation: publicConversation(conversation),
      });
    },
  );

  app.delete<{ Params: unknown }>(
    "/api/conversations/:conversationId",
    async (request, reply) => {
      const { conversationId } = parseParams(request.params);
      const deleted = await options.repository.deleteConversation(
        options.userId,
        conversationId,
      );
      if (!deleted) throw conversationNotFound();
      return noStore(reply).status(204).send();
    },
  );
}

function publicConversation(conversation: Conversation | ConversationSummary) {
  return {
    id: conversation.id,
    title: conversation.title ?? "New conversation",
    messageCount:
      "messageCount" in conversation ? conversation.messageCount : undefined,
    createdAt: conversation.createdAt.toISOString(),
    updatedAt: conversation.updatedAt.toISOString(),
    lastMessageAt: conversation.lastMessageAt.toISOString(),
  };
}

function publicMessage(message: StoredMessage) {
  return {
    id: message.id,
    conversationId: message.conversationId,
    role: message.role,
    content: message.content,
    source: message.source ?? "chat",
    sourceId: message.sourceId ?? null,
    metadata: message.metadata ?? {},
    createdAt: message.createdAt.toISOString(),
  };
}

function parseParams(input: unknown): { readonly conversationId: string } {
  const parsed = paramsSchema.safeParse(input);
  if (!parsed.success) throw conversationNotFound();
  return parsed.data;
}

function encodeCursor(at: Date, id: string): string {
  return Buffer.from(
    JSON.stringify({ at: at.toISOString(), id }),
    "utf8",
  ).toString("base64url");
}

function decodeConversationCursor(cursor: string): ConversationCursor {
  const payload = decodeCursor(cursor);
  return { lastMessageAt: payload.at, id: payload.id };
}

function decodeMessageCursor(cursor: string): MessageCursor {
  const payload = decodeCursor(cursor);
  return { createdAt: payload.at, id: payload.id };
}

function decodeCursor(cursor: string): { readonly at: Date; readonly id: string } {
  try {
    const raw: unknown = JSON.parse(
      Buffer.from(cursor, "base64url").toString("utf8"),
    );
    const parsed = cursorPayloadSchema.safeParse(raw);
    if (!parsed.success) throw new Error("invalid cursor");
    const at = new Date(parsed.data.at);
    if (!Number.isFinite(at.getTime())) throw new Error("invalid date");
    return { at, id: parsed.data.id };
  } catch {
    throw new ApiError(
      400,
      "INVALID_CURSOR",
      "The conversation history cursor is invalid or expired.",
    );
  }
}

async function requireConversation(
  repository: MemoryRepositoryPort,
  userId: string,
  conversationId: string,
): Promise<Conversation> {
  try {
    return await repository.resolveConversation(userId, conversationId);
  } catch (error: unknown) {
    if (error instanceof ConversationNotFoundError) throw conversationNotFound();
    throw error;
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

function noStore(reply: FastifyReply): FastifyReply {
  reply.header("cache-control", "no-store");
  return reply;
}

function conversationNotFound(): ApiError {
  return new ApiError(
    404,
    "CONVERSATION_NOT_FOUND",
    "That conversation does not exist for the configured Shiva user.",
  );
}

function invalidListRequest(): ApiError {
  return new ApiError(
    400,
    "INVALID_CONVERSATION_REQUEST",
    "Conversation pagination parameters are invalid.",
  );
}

function invalidTitleRequest(): ApiError {
  return new ApiError(
    400,
    "INVALID_CONVERSATION_TITLE",
    `Conversation titles must contain 1 to ${MAX_TITLE_LENGTH} characters.`,
  );
}
