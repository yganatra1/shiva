import type { FastifyInstance } from "fastify";
import type { WebSocket } from "ws";
import { z } from "zod";

import {
  CoreUpdateReplayCursorNotFoundError,
  type CoreUpdateReplaySource,
} from "./core-update-replay";

const querySchema = z
  .object({
    conversationId: z.string().uuid(),
    afterMessageId: z.string().uuid().optional(),
    limit: z.coerce.number().int().min(1).max(100).default(50),
  })
  .strict();

export interface CoreUpdate {
  readonly messageId: string;
  readonly conversationId: string;
  readonly message: string;
  readonly timestamp: string;
}

export interface CoreUpdatePublisher {
  publish(update: CoreUpdate): void;
}

/**
 * Process-local fan-out for Core-authored asynchronous chat messages. Redis is
 * deliberately not exposed to clients: they stay connected only to Shiva
 * Core, and every payload is a plain assistant message.
 */
export class CoreUpdateHub implements CoreUpdatePublisher {
  private readonly sockets = new Map<string, Set<SocketTarget>>();
  private readonly listeners = new Set<(update: CoreUpdate) => void>();

  constructor(
    private readonly onDeliveryError: (error: unknown) => void = () => {},
  ) {}

  publish(update: CoreUpdate): void {
    for (const listener of this.listeners) {
      try {
        listener(update);
      } catch (error: unknown) {
        this.reportDeliveryError(error);
      }
    }
    for (const target of this.sockets.get(update.conversationId) ?? []) {
      if (target.replaying) {
        target.buffer.push(update);
      } else {
        this.send(target.socket, update);
      }
    }
  }

  /** Small non-WebSocket seam used by tests and other Core-owned clients. */
  subscribe(listener: (update: CoreUpdate) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  attach(conversationId: string, socket: WebSocket): () => void {
    const target: SocketTarget = { socket, replaying: false, buffer: [] };
    const sockets = this.sockets.get(conversationId) ?? new Set<SocketTarget>();
    sockets.add(target);
    this.sockets.set(conversationId, sockets);
    return () => {
      sockets.delete(target);
      if (sockets.size === 0) this.sockets.delete(conversationId);
    };
  }

  /**
   * Buffers live messages while PostgreSQL is queried, preventing the gap and
   * out-of-order delivery that a replay-then-subscribe sequence would create.
   */
  attachForReplay(conversationId: string, socket: WebSocket): ReplayAttachment {
    const target: SocketTarget = { socket, replaying: true, buffer: [] };
    const sockets = this.sockets.get(conversationId) ?? new Set<SocketTarget>();
    sockets.add(target);
    this.sockets.set(conversationId, sockets);
    let detached = false;
    const detach = (): void => {
      if (detached) return;
      detached = true;
      sockets.delete(target);
      target.buffer.length = 0;
      if (sockets.size === 0) this.sockets.delete(conversationId);
    };
    return {
      detach,
      complete: (persisted) => {
        if (detached) return;
        const pending = deduplicatedChronological([
          ...persisted,
          ...target.buffer,
        ]);
        target.buffer.length = 0;
        target.replaying = false;
        for (const update of pending) this.send(socket, update);
      },
    };
  }

  private send(socket: WebSocket, update: CoreUpdate): void {
    try {
      if (socket.readyState === socket.OPEN) {
        socket.send(JSON.stringify(update));
      }
    } catch (error: unknown) {
      this.reportDeliveryError(error);
    }
  }

  private reportDeliveryError(error: unknown): void {
    try {
      this.onDeliveryError(error);
    } catch {
      // Update delivery is best effort after the assistant message is durable.
    }
  }
}

export function registerCoreUpdateSocketRoute(
  app: FastifyInstance,
  hub: CoreUpdateHub,
  replaySource?: CoreUpdateReplaySource,
): void {
  app.route<{ Querystring: unknown }>({
    method: "GET",
    url: "/chat/updates",
    handler: (_request, reply) =>
      reply.status(426).header("upgrade", "websocket").send({
        error: {
          code: "UPGRADE_REQUIRED",
          message: "The chat updates endpoint requires a WebSocket upgrade.",
        },
      }),
    wsHandler: (socket, request) => {
      const parsed = querySchema.safeParse(request.query);
      if (!parsed.success) {
        safelyClose(socket, 4400, "invalid update subscription");
        return;
      }
      const attachment = hub.attachForReplay(
        parsed.data.conversationId,
        socket,
      );
      socket.on("close", attachment.detach);
      socket.on("error", (error) => {
        request.log.warn({ err: error }, "Chat update socket failed");
      });
      void Promise.resolve()
        .then(() =>
          replaySource
            ? replaySource.listAfter(
                parsed.data.conversationId,
                parsed.data.afterMessageId,
                parsed.data.limit,
              )
            : [],
        )
        .then((updates) => attachment.complete(updates))
        .catch((error: unknown) => {
          attachment.detach();
          if (error instanceof CoreUpdateReplayCursorNotFoundError) {
            safelyClose(socket, 4404, "update cursor not found");
            return;
          }
          request.log.error({ err: error }, "Chat update replay failed");
          safelyClose(socket, 1011, "update replay failed");
        });
    },
  });
}

interface SocketTarget {
  readonly socket: WebSocket;
  replaying: boolean;
  readonly buffer: CoreUpdate[];
}

interface ReplayAttachment {
  detach(): void;
  complete(persisted: readonly CoreUpdate[]): void;
}

function deduplicatedChronological(
  updates: readonly CoreUpdate[],
): readonly CoreUpdate[] {
  const byId = new Map(updates.map((update) => [update.messageId, update]));
  return [...byId.values()].sort((left, right) => {
    const timestampDifference =
      Date.parse(left.timestamp) - Date.parse(right.timestamp);
    return timestampDifference || left.messageId.localeCompare(right.messageId);
  });
}

function safelyClose(socket: WebSocket, code: number, reason: string): void {
  try {
    socket.close(code, reason);
  } catch {
    // A socket may close concurrently while its replay query is settling.
  }
}
