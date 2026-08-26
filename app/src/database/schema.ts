import { sql } from "drizzle-orm";
import {
  type AnyPgColumn,
  boolean,
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

import {
  PERSON_FACE_EMBEDDING_DIMENSIONS,
  type FaceBoundingBox,
  type PersonDetails,
} from "../people/types.js";
import { EMBEDDING_DIMENSIONS } from "../types/embedding";

export const messageRole = pgEnum("message_role", ["user", "assistant"]);
export const messageSource = pgEnum("message_source", [
  "chat",
  "scheduled_task",
]);
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
export const executionMode = pgEnum("execution_mode", [
  "SAFE",
  "AUTO",
  "FULL_ACCESS",
]);
export const actionMutability = pgEnum("action_mutability", ["read", "write"]);
export const actionImpact = pgEnum("action_impact", ["normal", "sensitive"]);
export const confirmationStatus = pgEnum("confirmation_status", [
  "PENDING",
  "APPROVED",
  "DENIED",
  "EXPIRED",
  "EXECUTING",
  "EXECUTED",
  "FAILED",
]);
export const scheduledTaskType = pgEnum("scheduled_task_type", [
  "once",
  "cron",
  "interval",
]);
export const scheduledTaskLastStatus = pgEnum("scheduled_task_last_status", [
  "pending",
  "running",
  "succeeded",
  "failed",
  "skipped",
]);
export const scheduledTaskExecutionStatus = pgEnum(
  "scheduled_task_execution_status",
  ["processing", "succeeded", "failed"],
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

/** Structured identities known by one Shiva owner. */
export const people = pgTable(
  "people",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    displayName: text("display_name").notNull(),
    isOwner: boolean("is_owner").default(false).notNull(),
    relationship: text("relationship"),
    notes: text("notes"),
    details: jsonb("details")
      .$type<PersonDetails>()
      .default({})
      .notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .defaultNow()
      .$onUpdate(() => new Date())
      .notNull(),
  },
  (table) => [
    check(
      "people_display_name_not_empty",
      sql`length(btrim(${table.displayName})) > 0`,
    ),
    check(
      "people_relationship_not_empty",
      sql`${table.relationship} IS NULL OR length(btrim(${table.relationship})) > 0`,
    ),
    check(
      "people_notes_not_empty",
      sql`${table.notes} IS NULL OR length(btrim(${table.notes})) > 0`,
    ),
    check("people_details_object", sql`jsonb_typeof(${table.details}) = 'object'`),
    uniqueIndex("people_one_owner_per_user")
      .on(table.userId)
      .where(sql`${table.isOwner} = true`),
    index("people_user_display_name_idx").on(table.userId, table.displayName),
  ],
);

/** Searchable, normalized alternate names for a known person. */
export const personAliases = pgTable(
  "person_aliases",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    personId: uuid("person_id")
      .notNull()
      .references(() => people.id, { onDelete: "cascade" }),
    alias: text("alias").notNull(),
    normalizedAlias: text("normalized_alias").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .defaultNow()
      .$onUpdate(() => new Date())
      .notNull(),
  },
  (table) => [
    check(
      "person_aliases_alias_not_empty",
      sql`length(btrim(${table.alias})) > 0`,
    ),
    check(
      "person_aliases_normalized_not_empty",
      sql`length(${table.normalizedAlias}) > 0`,
    ),
    uniqueIndex("person_aliases_person_normalized_unique").on(
      table.personId,
      table.normalizedAlias,
    ),
    index("person_aliases_person_idx").on(table.personId),
    index("person_aliases_normalized_idx").on(table.normalizedAlias),
  ],
);

/**
 * Directed person-to-person edges (e.g. Yash --father--> Rajesh), independent
 * of `people.relationship` (which only expresses a relationship to the
 * account owner). Free-text `relationship` deliberately has no enum so new
 * relationship kinds never need a migration.
 */
export const personRelationships = pgTable(
  "person_relationships",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    fromPersonId: uuid("from_person_id")
      .notNull()
      .references(() => people.id, { onDelete: "cascade" }),
    toPersonId: uuid("to_person_id")
      .notNull()
      .references(() => people.id, { onDelete: "cascade" }),
    relationship: text("relationship").notNull(),
    notes: text("notes"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .defaultNow()
      .$onUpdate(() => new Date())
      .notNull(),
  },
  (table) => [
    check(
      "person_relationships_relationship_not_empty",
      sql`length(btrim(${table.relationship})) > 0`,
    ),
    check(
      "person_relationships_notes_not_empty",
      sql`${table.notes} IS NULL OR length(btrim(${table.notes})) > 0`,
    ),
    check(
      "person_relationships_not_self",
      sql`${table.fromPersonId} <> ${table.toPersonId}`,
    ),
    uniqueIndex("person_relationships_unique").on(
      table.userId,
      table.fromPersonId,
      table.toPersonId,
      table.relationship,
    ),
    index("person_relationships_from_idx").on(table.fromPersonId),
    index("person_relationships_to_idx").on(table.toPersonId),
  ],
);

/**
 * Biometric gallery templates are deliberately separate from semantic-memory
 * embeddings. Source image bytes are never persisted here.
 */
export const personFaceEmbeddings = pgTable(
  "person_face_embeddings",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    personId: uuid("person_id")
      .notNull()
      .references(() => people.id, { onDelete: "cascade" }),
    embedding: vector("embedding", {
      dimensions: PERSON_FACE_EMBEDDING_DIMENSIONS,
    }).notNull(),
    qualityScore: real("quality_score").notNull(),
    detectionScore: real("detection_score").notNull(),
    boundingBox: jsonb("bounding_box").$type<FaceBoundingBox>().notNull(),
    model: text("model").notNull(),
    source: text("source"),
    imageSha256: text("image_sha256").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .defaultNow()
      .$onUpdate(() => new Date())
      .notNull(),
  },
  (table) => [
    check(
      "person_face_embeddings_quality_range",
      sql`${table.qualityScore} >= 0 AND ${table.qualityScore} <= 1`,
    ),
    check(
      "person_face_embeddings_detection_range",
      sql`${table.detectionScore} >= 0 AND ${table.detectionScore} <= 1`,
    ),
    check(
      "person_face_embeddings_bbox_object",
      sql`jsonb_typeof(${table.boundingBox}) = 'object'`,
    ),
    check(
      "person_face_embeddings_model_not_empty",
      sql`length(btrim(${table.model})) > 0`,
    ),
    check(
      "person_face_embeddings_source_not_empty",
      sql`${table.source} IS NULL OR length(btrim(${table.source})) > 0`,
    ),
    check(
      "person_face_embeddings_sha256_shape",
      sql`${table.imageSha256} ~ '^[a-f0-9]{64}$'`,
    ),
    uniqueIndex("person_face_embeddings_sha256_unique").on(table.imageSha256),
    index("person_face_embeddings_person_idx").on(table.personId),
    index("person_face_embeddings_embedding_hnsw").using(
      "hnsw",
      table.embedding.op("vector_cosine_ops"),
    ),
  ],
);

/** The single durable, host-wide execution-control record. */
export const systemSettings = pgTable(
  "system_settings",
  {
    key: text("key").primaryKey().default("global"),
    executionMode: executionMode("execution_mode").default("AUTO").notNull(),
    lockdown: boolean("lockdown").default(false).notNull(),
    revision: integer("revision").default(0).notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    updatedBy: uuid("updated_by").references(() => users.id, {
      onDelete: "set null",
    }),
  },
  (table) => [
    check("system_settings_singleton", sql`${table.key} = 'global'`),
    check("system_settings_revision_nonnegative", sql`${table.revision} >= 0`),
  ],
);

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
    source: messageSource("source").default("chat").notNull(),
    sourceId: text("source_id"),
    metadata: jsonb("metadata")
      .$type<Record<string, unknown>>()
      .default({})
      .notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    check("messages_content_not_empty", sql`length(${table.content}) > 0`),
    check(
      "messages_source_shape",
      sql`(${table.source} = 'chat' AND ${table.sourceId} IS NULL) OR (${table.source} = 'scheduled_task' AND length(btrim(${table.sourceId})) > 0)`,
    ),
    check(
      "messages_metadata_object",
      sql`jsonb_typeof(${table.metadata}) = 'object'`,
    ),
    uniqueIndex("messages_source_role_unique")
      .on(table.source, table.sourceId, table.role)
      .where(sql`${table.sourceId} IS NOT NULL`),
    index("messages_conversation_created_idx").on(
      table.conversationId,
      table.createdAt.desc(),
      table.id.desc(),
    ),
  ],
);

/** User-facing metadata for persistent Shiva wake-ups managed by pg-boss. */
export const scheduledTasks = pgTable(
  "scheduled_tasks",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    conversationId: uuid("conversation_id").references(() => conversations.id, {
      onDelete: "set null",
    }),
    name: text("name").notNull(),
    instruction: text("instruction").notNull(),
    scheduleType: scheduledTaskType("schedule_type").notNull(),
    scheduleExpression: text("schedule_expression"),
    runAt: timestamp("run_at", { withTimezone: true }),
    intervalSeconds: integer("interval_seconds"),
    timezone: text("timezone").notNull(),
    enabled: boolean("enabled").default(true).notNull(),
    revision: integer("revision").default(1).notNull(),
    currentJobId: text("current_job_id"),
    scheduleKey: text("schedule_key"),
    nextRunAt: timestamp("next_run_at", { withTimezone: true }),
    lastRunAt: timestamp("last_run_at", { withTimezone: true }),
    lastStatus: scheduledTaskLastStatus("last_status"),
    lastError: text("last_error"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .defaultNow()
      .$onUpdate(() => new Date())
      .notNull(),
  },
  (table) => [
    check("scheduled_tasks_name_not_empty", sql`length(btrim(${table.name})) > 0`),
    check(
      "scheduled_tasks_instruction_not_empty",
      sql`length(btrim(${table.instruction})) > 0`,
    ),
    check(
      "scheduled_tasks_timezone_not_empty",
      sql`length(btrim(${table.timezone})) > 0`,
    ),
    check("scheduled_tasks_revision_positive", sql`${table.revision} > 0`),
    check(
      "scheduled_tasks_interval_positive",
      sql`${table.intervalSeconds} IS NULL OR ${table.intervalSeconds} > 0`,
    ),
    check(
      "scheduled_tasks_schedule_shape",
      sql`(${table.scheduleType} = 'once' AND ${table.runAt} IS NOT NULL AND ${table.scheduleExpression} IS NULL AND ${table.intervalSeconds} IS NULL AND ${table.scheduleKey} IS NULL) OR (${table.scheduleType} = 'cron' AND ${table.runAt} IS NULL AND ${table.scheduleExpression} IS NOT NULL AND ${table.intervalSeconds} IS NULL AND ${table.scheduleKey} IS NOT NULL) OR (${table.scheduleType} = 'interval' AND ${table.runAt} IS NULL AND ${table.scheduleExpression} IS NULL AND ${table.intervalSeconds} IS NOT NULL AND ${table.scheduleKey} IS NULL)`,
    ),
    check(
      "scheduled_tasks_last_error_not_empty",
      sql`${table.lastError} IS NULL OR length(btrim(${table.lastError})) > 0`,
    ),
    uniqueIndex("scheduled_tasks_current_job_unique")
      .on(table.currentJobId)
      .where(sql`${table.currentJobId} IS NOT NULL`),
    uniqueIndex("scheduled_tasks_schedule_key_unique")
      .on(table.scheduleKey)
      .where(sql`${table.scheduleKey} IS NOT NULL`),
    index("scheduled_tasks_user_enabled_updated_idx").on(
      table.userId,
      table.enabled,
      table.updatedAt.desc(),
    ),
    index("scheduled_tasks_next_run_idx")
      .on(table.nextRunAt)
      .where(sql`${table.enabled} = true`),
  ],
);

/** Durable Core-side idempotency boundary for one pg-boss occurrence. */
export const scheduledTaskExecutions = pgTable(
  "scheduled_task_executions",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    scheduledTaskId: uuid("scheduled_task_id")
      .notNull()
      .references(() => scheduledTasks.id, { onDelete: "cascade" }),
    pgBossJobId: text("pg_boss_job_id").notNull(),
    occurrenceId: text("occurrence_id").notNull(),
    scheduleRevision: integer("schedule_revision").notNull(),
    status: scheduledTaskExecutionStatus("status")
      .default("processing")
      .notNull(),
    triggeredAt: timestamp("triggered_at", { withTimezone: true }).notNull(),
    startedAt: timestamp("started_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    finishedAt: timestamp("finished_at", { withTimezone: true }),
    sourceMessageId: uuid("source_message_id").references(() => messages.id, {
      onDelete: "set null",
    }),
    assistantMessageId: uuid("assistant_message_id").references(
      () => messages.id,
      { onDelete: "set null" },
    ),
    response: text("response"),
    lastError: text("last_error"),
  },
  (table) => [
    check(
      "scheduled_task_executions_occurrence_not_empty",
      sql`length(btrim(${table.occurrenceId})) > 0`,
    ),
    check(
      "scheduled_task_executions_job_not_empty",
      sql`length(btrim(${table.pgBossJobId})) > 0`,
    ),
    check(
      "scheduled_task_executions_revision_positive",
      sql`${table.scheduleRevision} > 0`,
    ),
    check(
      "scheduled_task_executions_completion_shape",
      sql`(${table.status} = 'processing' AND ${table.finishedAt} IS NULL) OR (${table.status} <> 'processing' AND ${table.finishedAt} IS NOT NULL)`,
    ),
    uniqueIndex("scheduled_task_executions_job_unique").on(table.pgBossJobId),
    uniqueIndex("scheduled_task_executions_occurrence_unique").on(
      table.scheduledTaskId,
      table.occurrenceId,
    ),
    uniqueIndex("scheduled_task_executions_source_message_unique")
      .on(table.sourceMessageId)
      .where(sql`${table.sourceMessageId} IS NOT NULL`),
    index("scheduled_task_executions_task_started_idx").on(
      table.scheduledTaskId,
      table.startedAt.desc(),
    ),
  ],
);

/**
 * Durable natural-language context for one request that Shiva Core delegates
 * across process boundaries. The context is intentionally prose rather than a
 * serialized workflow; nullable completion time is only a lifecycle marker.
 */
export const orchestrationRequests = pgTable(
  "orchestration_requests",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    conversationId: uuid("conversation_id")
      .notNull()
      .references(() => conversations.id, { onDelete: "cascade" }),
    sourceMessageId: uuid("source_message_id")
      .notNull()
      .references(() => messages.id, { onDelete: "cascade" }),
    originalUserRequest: text("original_user_request").notNull(),
    executionContext: text("execution_context").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .defaultNow()
      .$onUpdate(() => new Date())
      .notNull(),
    completedAt: timestamp("completed_at", { withTimezone: true }),
  },
  (table) => [
    check(
      "orchestration_requests_original_request_not_empty",
      sql`length(btrim(${table.originalUserRequest})) > 0`,
    ),
    check(
      "orchestration_requests_execution_context_not_empty",
      sql`length(btrim(${table.executionContext})) > 0`,
    ),
    check(
      "orchestration_requests_completion_after_creation",
      sql`${table.completedAt} IS NULL OR ${table.completedAt} >= ${table.createdAt}`,
    ),
    uniqueIndex("orchestration_requests_source_message_unique").on(
      table.sourceMessageId,
    ),
    index("orchestration_requests_conversation_created_idx").on(
      table.conversationId,
      table.createdAt.desc(),
    ),
    index("orchestration_requests_active_idx")
      .on(table.updatedAt)
      .where(sql`${table.completedAt} IS NULL`),
  ],
);

/** Minimal durable outbox record for one instruction routed to an agent. */
export const agentTasks = pgTable(
  "agent_tasks",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    orchestrationRequestId: uuid("orchestration_request_id")
      .notNull()
      .references(() => orchestrationRequests.id, { onDelete: "cascade" }),
    agentId: text("agent_id").notNull(),
    instruction: text("instruction").notNull(),
    createdFromResponseId: uuid("created_from_response_id").references(
      (): AnyPgColumn => agentResponses.id,
      { onDelete: "set null" },
    ),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    deadlineAt: timestamp("deadline_at", { withTimezone: true }).notNull(),
    publishedAt: timestamp("published_at", { withTimezone: true }),
    redisMessageId: text("redis_message_id"),
    deliveryAttempts: integer("delivery_attempts").default(0).notNull(),
    lastDeliveryError: text("last_delivery_error"),
    abandonedAt: timestamp("abandoned_at", { withTimezone: true }),
  },
  (table) => [
    check("agent_tasks_agent_id_not_empty", sql`length(btrim(${table.agentId})) > 0`),
    check(
      "agent_tasks_instruction_not_empty",
      sql`length(btrim(${table.instruction})) > 0`,
    ),
    check(
      "agent_tasks_deadline_after_creation",
      sql`${table.deadlineAt} > ${table.createdAt}`,
    ),
    check(
      "agent_tasks_delivery_attempts_nonnegative",
      sql`${table.deliveryAttempts} >= 0`,
    ),
    check(
      "agent_tasks_publish_shape",
      sql`(${table.publishedAt} IS NULL) = (${table.redisMessageId} IS NULL)`,
    ),
    uniqueIndex("agent_tasks_source_response_unique")
      .on(table.createdFromResponseId)
      .where(sql`${table.createdFromResponseId} IS NOT NULL`),
    uniqueIndex("agent_tasks_redis_message_unique")
      .on(table.redisMessageId)
      .where(sql`${table.redisMessageId} IS NOT NULL`),
    index("agent_tasks_request_created_idx").on(
      table.orchestrationRequestId,
      table.createdAt,
    ),
    index("agent_tasks_unpublished_idx")
      .on(table.createdAt)
      .where(
        sql`${table.publishedAt} IS NULL AND ${table.abandonedAt} IS NULL`,
      ),
    index("agent_tasks_deadline_idx")
      .on(table.deadlineAt)
      .where(sql`${table.abandonedAt} IS NULL`),
  ],
);

/**
 * Plain-language reply from an agent. Processing fields are transport recovery
 * metadata only; the message itself carries the task's meaning.
 */
export const agentResponses = pgTable(
  "agent_responses",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    taskId: uuid("task_id")
      .notNull()
      .references(() => agentTasks.id, { onDelete: "cascade" }),
    agentId: text("agent_id").notNull(),
    message: text("message").notNull(),
    metadata: jsonb("metadata")
      .$type<Record<string, unknown>>()
      .default({})
      .notNull(),
    agentTimestamp: timestamp("agent_timestamp", { withTimezone: true }).notNull(),
    receivedAt: timestamp("received_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    redisMessageId: text("redis_message_id").notNull(),
    processingStartedAt: timestamp("processing_started_at", {
      withTimezone: true,
    }),
    processingAttempts: integer("processing_attempts").default(0).notNull(),
    lastProcessingError: text("last_processing_error"),
    processedAt: timestamp("processed_at", { withTimezone: true }),
    assistantMessageId: uuid("assistant_message_id").references(
      () => messages.id,
      { onDelete: "set null" },
    ),
  },
  (table) => [
    check(
      "agent_responses_agent_id_not_empty",
      sql`length(btrim(${table.agentId})) > 0`,
    ),
    check(
      "agent_responses_message_not_empty",
      sql`length(btrim(${table.message})) > 0`,
    ),
    check(
      "agent_responses_metadata_object",
      sql`jsonb_typeof(${table.metadata}) = 'object'`,
    ),
    check(
      "agent_responses_processing_shape",
      sql`${table.processedAt} IS NULL OR ${table.processingStartedAt} IS NOT NULL`,
    ),
    check(
      "agent_responses_processing_attempts_nonnegative",
      sql`${table.processingAttempts} >= 0`,
    ),
    uniqueIndex("agent_responses_task_unique").on(table.taskId),
    uniqueIndex("agent_responses_redis_message_unique").on(
      table.redisMessageId,
    ),
    index("agent_responses_unprocessed_idx")
      .on(table.receivedAt)
      .where(sql`${table.processedAt} IS NULL`),
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

/**
 * One-time, action-bound conversational approvals. Arguments are sanitized
 * before storage; the hash binds approval to the exact validated invocation.
 */
export const actionConfirmations = pgTable(
  "action_confirmations",
  {
    id: uuid("id").defaultRandom().primaryKey(),
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
    sanitizedArguments: jsonb("sanitized_arguments").$type<unknown>().notNull(),
    originContext: jsonb("origin_context")
      .$type<{
        originalUserRequest?: string;
        sourceMessageId?: string;
        orchestrationRequestId?: string;
        agentResponseId?: string;
      }>()
      .default({})
      .notNull(),
    actionHash: text("action_hash").notNull(),
    reason: text("reason").notNull(),
    executionMode: executionMode("execution_mode").notNull(),
    mutability: actionMutability("mutability").notNull(),
    impact: actionImpact("impact").notNull(),
    settingsRevision: integer("settings_revision").notNull(),
    status: confirmationStatus("status").default("PENDING").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    resolvedAt: timestamp("resolved_at", { withTimezone: true }),
    resolvedBy: uuid("resolved_by").references(() => users.id, {
      onDelete: "set null",
    }),
  },
  (table) => [
    check("action_confirmations_skill_not_empty", sql`length(btrim(${table.skill})) > 0`),
    check("action_confirmations_hash_shape", sql`${table.actionHash} ~ '^[a-f0-9]{64}$'`),
    check("action_confirmations_reason_not_empty", sql`length(btrim(${table.reason})) > 0`),
    check("action_confirmations_expiry_after_creation", sql`${table.expiresAt} > ${table.createdAt}`),
    check(
      "action_confirmations_settings_revision_nonnegative",
      sql`${table.settingsRevision} >= 0`,
    ),
    check(
      "action_confirmations_resolution_shape",
      sql`(${table.status} = 'PENDING' AND ${table.resolvedAt} IS NULL AND ${table.resolvedBy} IS NULL) OR (${table.status} <> 'PENDING' AND ${table.resolvedAt} IS NOT NULL)`,
    ),
    uniqueIndex("action_confirmations_one_pending_per_conversation")
      .on(table.userId, table.conversationId)
      .where(sql`${table.status} = 'PENDING'`),
    index("action_confirmations_expiry_idx").on(table.status, table.expiresAt),
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
    executionMode: executionMode("execution_mode").default("AUTO").notNull(),
    mutability: actionMutability("mutability").default("read").notNull(),
    impact: actionImpact("impact").default("normal").notNull(),
    confirmationId: uuid("confirmation_id").references(
      () => actionConfirmations.id,
      { onDelete: "set null" },
    ),
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
