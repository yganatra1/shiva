CREATE EXTENSION IF NOT EXISTS vector;--> statement-breakpoint
CREATE EXTENSION IF NOT EXISTS pgcrypto;--> statement-breakpoint
CREATE TYPE "public"."memory_status" AS ENUM('active', 'superseded', 'archived');--> statement-breakpoint
CREATE TYPE "public"."memory_type" AS ENUM('episodic', 'semantic');--> statement-breakpoint
CREATE TYPE "public"."message_role" AS ENUM('user', 'assistant');--> statement-breakpoint
CREATE TYPE "public"."semantic_memory_type" AS ENUM('fact', 'preference', 'relationship', 'project_fact', 'profile');--> statement-breakpoint
CREATE TABLE "conversations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"title" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_message_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "memories" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"memory_type" "memory_type" NOT NULL,
	"semantic_type" "semantic_memory_type",
	"content" text NOT NULL,
	"importance" real NOT NULL,
	"confidence" real NOT NULL,
	"occurred_at" timestamp with time zone,
	"valid_from" timestamp with time zone,
	"valid_until" timestamp with time zone,
	"status" "memory_status" DEFAULT 'active' NOT NULL,
	"superseded_by" uuid,
	"source_conversation_id" uuid,
	"source_message_id" uuid,
	"embedding" vector(768) NOT NULL,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_accessed_at" timestamp with time zone,
	"access_count" integer DEFAULT 0 NOT NULL,
	CONSTRAINT "memories_content_not_empty" CHECK (length("memories"."content") > 0),
	CONSTRAINT "memories_importance_range" CHECK ("memories"."importance" >= 0 AND "memories"."importance" <= 1),
	CONSTRAINT "memories_confidence_range" CHECK ("memories"."confidence" >= 0 AND "memories"."confidence" <= 1),
	CONSTRAINT "memories_access_count_nonnegative" CHECK ("memories"."access_count" >= 0),
	CONSTRAINT "memories_type_shape" CHECK (("memories"."memory_type" = 'episodic' AND "memories"."semantic_type" IS NULL) OR ("memories"."memory_type" = 'semantic' AND "memories"."semantic_type" IS NOT NULL)),
	CONSTRAINT "memories_validity_window" CHECK ("memories"."valid_until" IS NULL OR "memories"."valid_from" IS NULL OR "memories"."valid_until" >= "memories"."valid_from")
);
--> statement-breakpoint
CREATE TABLE "messages" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"conversation_id" uuid NOT NULL,
	"role" "message_role" NOT NULL,
	"content" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "messages_content_not_empty" CHECK (length("messages"."content") > 0)
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" uuid PRIMARY KEY NOT NULL,
	"display_name" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "conversations" ADD CONSTRAINT "conversations_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memories" ADD CONSTRAINT "memories_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memories" ADD CONSTRAINT "memories_superseded_by_memories_id_fk" FOREIGN KEY ("superseded_by") REFERENCES "public"."memories"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memories" ADD CONSTRAINT "memories_source_conversation_id_conversations_id_fk" FOREIGN KEY ("source_conversation_id") REFERENCES "public"."conversations"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memories" ADD CONSTRAINT "memories_source_message_id_messages_id_fk" FOREIGN KEY ("source_message_id") REFERENCES "public"."messages"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "messages" ADD CONSTRAINT "messages_conversation_id_conversations_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."conversations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "conversations_user_recent_idx" ON "conversations" USING btree ("user_id","last_message_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "memories_user_type_status_idx" ON "memories" USING btree ("user_id","memory_type","status");--> statement-breakpoint
CREATE INDEX "memories_user_semantic_type_status_idx" ON "memories" USING btree ("user_id","semantic_type","status") WHERE "memories"."memory_type" = 'semantic';--> statement-breakpoint
CREATE INDEX "memories_occurred_at_idx" ON "memories" USING btree ("user_id","occurred_at" DESC NULLS LAST) WHERE "memories"."occurred_at" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "memories_source_conversation_idx" ON "memories" USING btree ("source_conversation_id") WHERE "memories"."source_conversation_id" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "messages_conversation_created_idx" ON "messages" USING btree ("conversation_id","created_at" DESC NULLS LAST,"id" DESC NULLS LAST);
