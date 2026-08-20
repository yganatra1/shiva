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
  uniqueIndex,
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
export const agentRunStatus = pgEnum("agent_run_status", [
  "running",
  "succeeded",
  "failed",
  "cancelled",
  "max_steps",
]);
export const skillRunStatus = pgEnum("skill_run_status", [
  "running",
  "succeeded",
  "failed",
  "denied",
  "cancelled",
]);
export const expenseSheetBindingStatus = pgEnum(
  "expense_sheet_binding_status",
  ["provisioning", "ready"],
);

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

/**
 * Per-user pointer to Shiva's externally stored expense ledger.
 *
 * This table contains only Google resource identifiers and provisioning state;
 * expense rows and Google credentials must never be persisted here.
 */
export const expenseSheetBindings = pgTable(
  "expense_sheet_bindings",
  {
    userId: uuid("user_id")
      .primaryKey()
      .references(() => users.id, { onDelete: "cascade" }),
    spreadsheetId: text("spreadsheet_id"),
    sheetId: integer("sheet_id"),
    status: expenseSheetBindingStatus("status")
      .default("provisioning")
      .notNull(),
    schemaVersion: integer("schema_version").default(1).notNull(),
    leaseOwner: uuid("lease_owner"),
    leaseExpiresAt: timestamp("lease_expires_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .defaultNow()
      .$onUpdate(() => new Date())
      .notNull(),
  },
  (table) => [
    uniqueIndex("expense_sheet_bindings_spreadsheet_unique")
      .on(table.spreadsheetId)
      .where(sql`${table.spreadsheetId} IS NOT NULL`),
    check(
      "expense_sheet_bindings_spreadsheet_not_empty",
      sql`${table.spreadsheetId} IS NULL OR length(btrim(${table.spreadsheetId})) > 0`,
    ),
    check(
      "expense_sheet_bindings_sheet_id_nonnegative",
      sql`${table.sheetId} IS NULL OR ${table.sheetId} >= 0`,
    ),
    check(
      "expense_sheet_bindings_schema_version_positive",
      sql`${table.schemaVersion} > 0`,
    ),
    check(
      "expense_sheet_bindings_lease_shape",
      sql`(${table.leaseOwner} IS NULL) = (${table.leaseExpiresAt} IS NULL)`,
    ),
    check(
      "expense_sheet_bindings_ready_shape",
      sql`${table.status} <> 'ready' OR (${table.spreadsheetId} IS NOT NULL AND ${table.sheetId} IS NOT NULL AND ${table.leaseOwner} IS NULL)`,
    ),
  ],
);

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

export const agentRuns = pgTable(
  "agent_runs",
  {
    id: uuid("id").primaryKey(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    conversationId: uuid("conversation_id")
      .notNull()
      .references(() => conversations.id, { onDelete: "cascade" }),
    request: text("request").notNull(),
    status: agentRunStatus("status").default("running").notNull(),
    stepCount: integer("step_count").default(0).notNull(),
    errorCode: text("error_code"),
    startedAt: timestamp("started_at", { withTimezone: true }).notNull(),
    finishedAt: timestamp("finished_at", { withTimezone: true }),
    durationMs: integer("duration_ms"),
    metadata: jsonb("metadata")
      .$type<Record<string, unknown>>()
      .default({})
      .notNull(),
  },
  (table) => [
    check("agent_runs_request_not_empty", sql`length(btrim(${table.request})) > 0`),
    check("agent_runs_step_count_nonnegative", sql`${table.stepCount} >= 0`),
    check(
      "agent_runs_duration_nonnegative",
      sql`${table.durationMs} IS NULL OR ${table.durationMs} >= 0`,
    ),
    index("agent_runs_user_started_idx").on(
      table.userId,
      table.startedAt.desc(),
    ),
    index("agent_runs_conversation_started_idx").on(
      table.conversationId,
      table.startedAt.desc(),
    ),
  ],
);

export const skillRuns = pgTable(
  "skill_runs",
  {
    id: uuid("id").primaryKey(),
    agentRunId: uuid("agent_run_id")
      .notNull()
      .references(() => agentRuns.id, { onDelete: "cascade" }),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    conversationId: uuid("conversation_id")
      .notNull()
      .references(() => conversations.id, { onDelete: "cascade" }),
    skill: text("skill").notNull(),
    input: jsonb("input").$type<unknown>().notNull(),
    permissions: text("permissions").array().notNull(),
    result: jsonb("result").$type<unknown>(),
    status: skillRunStatus("status").default("running").notNull(),
    errorCode: text("error_code"),
    startedAt: timestamp("started_at", { withTimezone: true }).notNull(),
    finishedAt: timestamp("finished_at", { withTimezone: true }),
    durationMs: integer("duration_ms"),
  },
  (table) => [
    check("skill_runs_skill_not_empty", sql`length(btrim(${table.skill})) > 0`),
    check(
      "skill_runs_duration_nonnegative",
      sql`${table.durationMs} IS NULL OR ${table.durationMs} >= 0`,
    ),
    index("skill_runs_agent_started_idx").on(
      table.agentRunId,
      table.startedAt,
    ),
    index("skill_runs_user_skill_started_idx").on(
      table.userId,
      table.skill,
      table.startedAt.desc(),
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
