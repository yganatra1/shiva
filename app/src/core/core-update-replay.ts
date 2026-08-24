import { and, asc, desc, eq, gt, or } from "drizzle-orm";

import type { ShivaDatabase } from "../database/pool";
import { agentResponses, messages } from "../database/schema";

export interface PersistedCoreUpdate {
  readonly messageId: string;
  readonly conversationId: string;
  readonly message: string;
  readonly timestamp: string;
}

export interface CoreUpdateReplaySource {
  /**
   * Returns Core-authored asynchronous messages in stable chronological order.
   * Without a cursor, only the most recent bounded window is returned.
   */
  listAfter(
    conversationId: string,
    afterMessageId: string | undefined,
    limit: number,
  ): Promise<readonly PersistedCoreUpdate[]>;
}

export class CoreUpdateReplayCursorNotFoundError extends Error {
  override readonly name = "CoreUpdateReplayCursorNotFoundError";
}

/**
 * Reads only assistant messages finalized from agent responses. Normal HTTP
 * chat responses are deliberately excluded so reconnecting clients do not
 * receive their foreground response a second time.
 */
export class DrizzleCoreUpdateReplaySource implements CoreUpdateReplaySource {
  constructor(private readonly database: ShivaDatabase) {}

  async listAfter(
    conversationId: string,
    afterMessageId: string | undefined,
    limit: number,
  ): Promise<readonly PersistedCoreUpdate[]> {
    const boundedLimit = normalizeLimit(limit);
    if (!afterMessageId) {
      const recent = await this.database
        .select({ message: messages })
        .from(agentResponses)
        .innerJoin(messages, eq(agentResponses.assistantMessageId, messages.id))
        .where(eq(messages.conversationId, conversationId))
        .orderBy(desc(messages.createdAt), desc(messages.id))
        .limit(boundedLimit);
      return recent.reverse().map(({ message }) => mapUpdate(message));
    }

    const [cursor] = await this.database
      .select({ createdAt: messages.createdAt })
      .from(agentResponses)
      .innerJoin(messages, eq(agentResponses.assistantMessageId, messages.id))
      .where(
        and(
          eq(messages.id, afterMessageId),
          eq(messages.conversationId, conversationId),
        ),
      )
      .limit(1);
    if (!cursor) {
      throw new CoreUpdateReplayCursorNotFoundError(
        "The update cursor does not belong to this conversation.",
      );
    }

    const following = await this.database
      .select({ message: messages })
      .from(agentResponses)
      .innerJoin(messages, eq(agentResponses.assistantMessageId, messages.id))
      .where(
        and(
          eq(messages.conversationId, conversationId),
          or(
            gt(messages.createdAt, cursor.createdAt),
            and(
              eq(messages.createdAt, cursor.createdAt),
              gt(messages.id, afterMessageId),
            ),
          ),
        ),
      )
      .orderBy(asc(messages.createdAt), asc(messages.id))
      .limit(boundedLimit);
    return following.map(({ message }) => mapUpdate(message));
  }
}

function mapUpdate(message: typeof messages.$inferSelect): PersistedCoreUpdate {
  return {
    messageId: message.id,
    conversationId: message.conversationId,
    message: message.content,
    timestamp: message.createdAt.toISOString(),
  };
}

function normalizeLimit(limit: number): number {
  if (!Number.isInteger(limit) || limit < 1) {
    throw new RangeError("Core update replay limit must be a positive integer.");
  }
  return Math.min(limit, 100);
}
