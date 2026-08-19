import { sql } from "drizzle-orm";
import {
  type AnyPgColumn,
  check,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  real,
  text,
  timestamp,
  uuid,
  vector,
} from "drizzle-orm/pg-core";

import { EMBEDDING_DIMENSIONS } from "../types/embedding.js";

export const messageRole = pgEnum("message_role", ["user", "assistant"]);
export const memoryType = pgEnum("memory_type", ["episodic", "semantic"]);
export const semanticMemoryType = pgEnum("semantic_memory_type", [
  "fact",
  "preference",
  "relationship",
  "project_fact",
  "profile",
]);
export const memoryStatus = pgEnum("memory_status", [
  "active",
  "superseded",
  "archived",
]);

export const users = pgTable("users", {
  id: uuid("id").primaryKey(),
  displayName: text("display_name").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true })
    .defaultNow()
    .notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .defaultNow()
    .$onUpdate(() => new Date())
    .notNull(),
});

export const conversations = pgTable(
  "conversations",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    title: text("title"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .defaultNow()
      .$onUpdate(() => new Date())
      .notNull(),
    lastMessageAt: timestamp("last_message_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    index("conversations_user_recent_idx").on(
      table.userId,
      table.lastMessageAt.desc(),
    ),
  ],
);

export const messages = pgTable(
  "messages",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    conversationId: uuid("conversation_id")
      .notNull()
      .references(() => conversations.id, { onDelete: "cascade" }),
    role: messageRole("role").notNull(),
    content: text("content").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    check("messages_content_not_empty", sql`length(${table.content}) > 0`),
    index("messages_conversation_created_idx").on(
      table.conversationId,
      table.createdAt.desc(),
      table.id.desc(),
    ),
  ],
);

export const memories = pgTable(
  "memories",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    memoryType: memoryType("memory_type").notNull(),
    semanticType: semanticMemoryType("semantic_type"),
    content: text("content").notNull(),
    importance: real("importance").notNull(),
    confidence: real("confidence").notNull(),
    occurredAt: timestamp("occurred_at", { withTimezone: true }),
    validFrom: timestamp("valid_from", { withTimezone: true }),
    validUntil: timestamp("valid_until", { withTimezone: true }),
    status: memoryStatus("status").default("active").notNull(),
    supersededBy: uuid("superseded_by").references(
      (): AnyPgColumn => memories.id,
      { onDelete: "set null" },
    ),
    sourceConversationId: uuid("source_conversation_id").references(
      () => conversations.id,
      { onDelete: "set null" },
    ),
    sourceMessageId: uuid("source_message_id").references(() => messages.id, {
      onDelete: "set null",
    }),
    embedding: vector("embedding", { dimensions: EMBEDDING_DIMENSIONS }).notNull(),
    metadata: jsonb("metadata")
      .$type<Record<string, unknown>>()
      .default({})
      .notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .defaultNow()
      .$onUpdate(() => new Date())
      .notNull(),
    lastAccessedAt: timestamp("last_accessed_at", { withTimezone: true }),
    accessCount: integer("access_count").default(0).notNull(),
  },
  (table) => [
    check("memories_content_not_empty", sql`length(${table.content}) > 0`),
    check(
      "memories_importance_range",
      sql`${table.importance} >= 0 AND ${table.importance} <= 1`,
    ),
    check(
      "memories_confidence_range",
      sql`${table.confidence} >= 0 AND ${table.confidence} <= 1`,
    ),
    check("memories_access_count_nonnegative", sql`${table.accessCount} >= 0`),
    check(
      "memories_type_shape",
      sql`(${table.memoryType} = 'episodic' AND ${table.semanticType} IS NULL) OR (${table.memoryType} = 'semantic' AND ${table.semanticType} IS NOT NULL)`,
    ),
    check(
      "memories_validity_window",
      sql`${table.validUntil} IS NULL OR ${table.validFrom} IS NULL OR ${table.validUntil} >= ${table.validFrom}`,
    ),
    index("memories_user_type_status_idx").on(
      table.userId,
      table.memoryType,
      table.status,
    ),
    index("memories_user_semantic_type_status_idx")
      .on(table.userId, table.semanticType, table.status)
      .where(sql`${table.memoryType} = 'semantic'`),
    index("memories_occurred_at_idx")
      .on(table.userId, table.occurredAt.desc())
      .where(sql`${table.occurredAt} IS NOT NULL`),
    index("memories_source_conversation_idx")
      .on(table.sourceConversationId)
      .where(sql`${table.sourceConversationId} IS NOT NULL`),
  ],
);
