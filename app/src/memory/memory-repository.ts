import {
  and,
  asc,
  cosineDistance,
  desc,
  eq,
  gte,
  inArray,
  isNull,
  lt,
  lte,
  or,
  sql,
} from "drizzle-orm";

import type { ShivaDatabase } from "../database/pool";
import {
  conversations,
  memories,
  messages,
  users,
} from "../database/schema";
import { EMBEDDING_DIMENSIONS } from "../types/embedding";
import type {
  Conversation,
  ConversationCursor,
  ConversationSummary,
  MemoryRecord,
  MemoryRepositoryPort,
  MemorySearchResult,
  MemoryType,
  MessageCursor,
  NewMemoryInput,
  SemanticMemoryType,
  StoredMessage,
  StoredMessageRole,
} from "./types";

type MemoryRow = typeof memories.$inferSelect;

export class ConversationNotFoundError extends Error {
  override readonly name = "ConversationNotFoundError";
}

export class MemoryRepository implements MemoryRepositoryPort {
  constructor(private readonly db: ShivaDatabase) {}

  async ensureUser(userId: string, displayName: string): Promise<void> {
    await this.db
      .insert(users)
      .values({ id: userId, displayName })
      .onConflictDoUpdate({
        target: users.id,
        set: { displayName, updatedAt: new Date() },
      });
  }

  async resolveConversation(
    userId: string,
    conversationId?: string,
  ): Promise<Conversation> {
    if (conversationId) {
      const [existing] = await this.db
        .select()
        .from(conversations)
        .where(
          and(
            eq(conversations.id, conversationId),
            eq(conversations.userId, userId),
          ),
        )
        .limit(1);

      if (!existing) {
        throw new ConversationNotFoundError(
          "The conversation does not exist for the configured user.",
        );
      }
      return existing;
    }

    const [created] = await this.db
      .insert(conversations)
      .values({ userId })
      .returning();
    return requiredRow(created, "conversation");
  }

  async listConversations(
    userId: string,
    limit: number,
    before?: ConversationCursor,
  ): Promise<readonly ConversationSummary[]> {
    const cursorCondition = before
      ? or(
          lt(conversations.lastMessageAt, before.lastMessageAt),
          and(
            eq(conversations.lastMessageAt, before.lastMessageAt),
            lt(conversations.id, before.id),
          ),
        )
      : undefined;
    const rows = await this.db
      .select({
        conversation: conversations,
        messageCount: sql<number>`(
          select count(*)::int
          from ${messages}
          where ${messages.conversationId} = ${conversations.id}
        )`,
      })
      .from(conversations)
      .where(
        cursorCondition
          ? and(eq(conversations.userId, userId), cursorCondition)
          : eq(conversations.userId, userId),
      )
      .orderBy(desc(conversations.lastMessageAt), desc(conversations.id))
      .limit(limit);

    return rows.map(({ conversation, messageCount }) => ({
      ...conversation,
      messageCount: Number(messageCount),
    }));
  }

  async listConversationMessages(
    userId: string,
    conversationId: string,
    limit: number,
    before?: MessageCursor,
  ): Promise<readonly StoredMessage[]> {
    const cursorCondition = before
      ? or(
          lt(messages.createdAt, before.createdAt),
          and(eq(messages.createdAt, before.createdAt), lt(messages.id, before.id)),
        )
      : undefined;
    const rows = await this.db
      .select({ message: messages })
      .from(messages)
      .innerJoin(conversations, eq(messages.conversationId, conversations.id))
      .where(
        and(
          eq(conversations.userId, userId),
          eq(messages.conversationId, conversationId),
          ...(cursorCondition ? [cursorCondition] : []),
        ),
      )
      .orderBy(desc(messages.createdAt), desc(messages.id))
      .limit(limit);

    return rows.map(({ message }) => message);
  }

  async updateConversationTitle(
    userId: string,
    conversationId: string,
    title: string,
  ): Promise<Conversation | null> {
    const [updated] = await this.db
      .update(conversations)
      .set({ title, updatedAt: new Date() })
      .where(
        and(
          eq(conversations.id, conversationId),
          eq(conversations.userId, userId),
        ),
      )
      .returning();
    return updated ?? null;
  }

  async setConversationTitleIfEmpty(
    userId: string,
    conversationId: string,
    title: string,
  ): Promise<void> {
    await this.db
      .update(conversations)
      .set({ title, updatedAt: new Date() })
      .where(
        and(
          eq(conversations.id, conversationId),
          eq(conversations.userId, userId),
          isNull(conversations.title),
        ),
      );
  }

  async deleteConversation(
    userId: string,
    conversationId: string,
  ): Promise<boolean> {
    const deleted = await this.db
      .delete(conversations)
      .where(
        and(
          eq(conversations.id, conversationId),
          eq(conversations.userId, userId),
        ),
      )
      .returning({ id: conversations.id });
    return deleted.length > 0;
  }

  async addMessage(
    conversationId: string,
    role: StoredMessageRole,
    content: string,
  ): Promise<StoredMessage> {
    return this.db.transaction(async (transaction) => {
      const [inserted] = await transaction
        .insert(messages)
        .values({ conversationId, role, content })
        .returning();
      const now = new Date();
      await transaction
        .update(conversations)
        .set({ lastMessageAt: now, updatedAt: now })
        .where(eq(conversations.id, conversationId));
      return requiredRow(inserted, "message");
    });
  }

  async getRecentMessages(
    conversationId: string,
    limit: number,
  ): Promise<readonly StoredMessage[]> {
    const recent = await this.db
      .select()
      .from(messages)
      .where(eq(messages.conversationId, conversationId))
      .orderBy(desc(messages.createdAt), desc(messages.id))
      .limit(limit);

    return recent.sort((left, right) => {
      const timestampDifference =
        left.createdAt.getTime() - right.createdAt.getTime();
      return timestampDifference || left.id.localeCompare(right.id);
    });
  }

  async searchMemories(
    userId: string,
    requestedMemoryType: MemoryType,
    embedding: readonly number[],
    limit: number,
  ): Promise<readonly MemorySearchResult[]> {
    const vector = validatedEmbedding(embedding);
    const distance = cosineDistance(memories.embedding, vector);
    const similarity = sql<number>`1 - (${distance})`;
    const rows = await this.db
      .select({ memory: memories, similarity })
      .from(memories)
      .where(
        and(
          eq(memories.userId, userId),
          eq(memories.memoryType, requestedMemoryType),
          eq(memories.status, "active"),
          or(isNull(memories.validFrom), lte(memories.validFrom, new Date())),
          or(isNull(memories.validUntil), gte(memories.validUntil, new Date())),
        ),
      )
      .orderBy(asc(distance))
      .limit(limit);

    return rows.map(({ memory, similarity: score }) => ({
      ...mapMemory(memory),
      similarity: Number(score),
    }));
  }

  async findSimilarSemanticMemories(
    userId: string,
    requestedSemanticType: SemanticMemoryType,
    embedding: readonly number[],
    minimumSimilarity: number,
    limit: number,
  ): Promise<readonly MemorySearchResult[]> {
    const vector = validatedEmbedding(embedding);
    const distance = cosineDistance(memories.embedding, vector);
    const similarity = sql<number>`1 - (${distance})`;
    const rows = await this.db
      .select({ memory: memories, similarity })
      .from(memories)
      .where(
        and(
          eq(memories.userId, userId),
          eq(memories.memoryType, "semantic"),
          eq(memories.semanticType, requestedSemanticType),
          eq(memories.status, "active"),
          gte(similarity, minimumSimilarity),
        ),
      )
      .orderBy(asc(distance))
      .limit(limit);

    return rows.map(({ memory, similarity: score }) => ({
      ...mapMemory(memory),
      similarity: Number(score),
    }));
  }

  async saveMemory(
    input: NewMemoryInput,
    supersedesIds: readonly string[] = [],
  ): Promise<MemoryRecord> {
    return this.db.transaction(async (transaction) => {
      const [inserted] = await transaction
        .insert(memories)
        .values({
          userId: input.userId,
          memoryType: input.memoryType,
          semanticType: input.semanticType,
          content: input.content,
          importance: input.importance,
          confidence: input.confidence,
          occurredAt: input.occurredAt,
          validFrom: input.validFrom,
          validUntil: input.validUntil,
          sourceConversationId: input.sourceConversationId,
          sourceMessageId: input.sourceMessageId,
          embedding: validatedEmbedding(input.embedding),
          metadata: { ...input.metadata },
        })
        .returning();
      const memory = requiredRow(inserted, "memory");

      const uniqueSupersedesIds = [...new Set(supersedesIds)];
      if (uniqueSupersedesIds.length > 0) {
        const superseded = await transaction
          .update(memories)
          .set({
            status: "superseded",
            supersededBy: memory.id,
            updatedAt: new Date(),
          })
          .where(
            and(
              inArray(memories.id, uniqueSupersedesIds),
              eq(memories.userId, input.userId),
              eq(memories.status, "active"),
            ),
          )
          .returning({ id: memories.id });

        if (superseded.length !== uniqueSupersedesIds.length) {
          throw new Error(
            "One or more memories selected for superseding are no longer active.",
          );
        }
      }

      return mapMemory(memory);
    });
  }

  async touchMemories(memoryIds: readonly string[]): Promise<void> {
    if (memoryIds.length === 0) {
      return;
    }

    await this.db
      .update(memories)
      .set({
        lastAccessedAt: new Date(),
        accessCount: sql`${memories.accessCount} + 1`,
        updatedAt: new Date(),
      })
      .where(inArray(memories.id, [...memoryIds]));
  }
}

function validatedEmbedding(embedding: readonly number[]): number[] {
  if (
    embedding.length !== EMBEDDING_DIMENSIONS ||
    embedding.some((value) => !Number.isFinite(value))
  ) {
    throw new Error(`Embedding must contain ${EMBEDDING_DIMENSIONS} finite values.`);
  }

  return [...embedding];
}

function mapMemory(row: MemoryRow): MemoryRecord {
  return {
    id: row.id,
    userId: row.userId,
    memoryType: row.memoryType,
    semanticType: row.semanticType,
    content: row.content,
    importance: row.importance,
    confidence: row.confidence,
    occurredAt: row.occurredAt,
    validFrom: row.validFrom,
    validUntil: row.validUntil,
    status: row.status,
    supersededBy: row.supersededBy,
    sourceConversationId: row.sourceConversationId,
    sourceMessageId: row.sourceMessageId,
    metadata: row.metadata,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    lastAccessedAt: row.lastAccessedAt,
    accessCount: row.accessCount,
  };
}

function requiredRow<T>(row: T | undefined, entity: string): T {
  if (!row) {
    throw new Error(`Database did not return the inserted ${entity}.`);
  }
  return row;
}
