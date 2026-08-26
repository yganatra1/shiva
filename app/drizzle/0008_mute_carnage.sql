CREATE TYPE "public"."message_source" AS ENUM('chat', 'scheduled_task');--> statement-breakpoint
CREATE TYPE "public"."scheduled_task_execution_status" AS ENUM('processing', 'succeeded', 'failed');--> statement-breakpoint
CREATE TYPE "public"."scheduled_task_last_status" AS ENUM('pending', 'running', 'succeeded', 'failed', 'skipped');--> statement-breakpoint
CREATE TYPE "public"."scheduled_task_type" AS ENUM('once', 'cron', 'interval');--> statement-breakpoint
CREATE TABLE "scheduled_task_executions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"scheduled_task_id" uuid NOT NULL,
	"pg_boss_job_id" text NOT NULL,
	"occurrence_id" text NOT NULL,
	"schedule_revision" integer NOT NULL,
	"status" "scheduled_task_execution_status" DEFAULT 'processing' NOT NULL,
	"triggered_at" timestamp with time zone NOT NULL,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone,
	"source_message_id" uuid,
	"assistant_message_id" uuid,
	"response" text,
	"last_error" text,
	CONSTRAINT "scheduled_task_executions_occurrence_not_empty" CHECK (length(btrim("scheduled_task_executions"."occurrence_id")) > 0),
	CONSTRAINT "scheduled_task_executions_job_not_empty" CHECK (length(btrim("scheduled_task_executions"."pg_boss_job_id")) > 0),
	CONSTRAINT "scheduled_task_executions_revision_positive" CHECK ("scheduled_task_executions"."schedule_revision" > 0),
	CONSTRAINT "scheduled_task_executions_completion_shape" CHECK (("scheduled_task_executions"."status" = 'processing' AND "scheduled_task_executions"."finished_at" IS NULL) OR ("scheduled_task_executions"."status" <> 'processing' AND "scheduled_task_executions"."finished_at" IS NOT NULL))
);
--> statement-breakpoint
CREATE TABLE "scheduled_tasks" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"conversation_id" uuid,
	"name" text NOT NULL,
	"instruction" text NOT NULL,
	"schedule_type" "scheduled_task_type" NOT NULL,
	"schedule_expression" text,
	"run_at" timestamp with time zone,
	"interval_seconds" integer,
	"timezone" text NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"revision" integer DEFAULT 1 NOT NULL,
	"current_job_id" text,
	"schedule_key" text,
	"next_run_at" timestamp with time zone,
	"last_run_at" timestamp with time zone,
	"last_status" "scheduled_task_last_status",
	"last_error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "scheduled_tasks_name_not_empty" CHECK (length(btrim("scheduled_tasks"."name")) > 0),
	CONSTRAINT "scheduled_tasks_instruction_not_empty" CHECK (length(btrim("scheduled_tasks"."instruction")) > 0),
	CONSTRAINT "scheduled_tasks_timezone_not_empty" CHECK (length(btrim("scheduled_tasks"."timezone")) > 0),
	CONSTRAINT "scheduled_tasks_revision_positive" CHECK ("scheduled_tasks"."revision" > 0),
	CONSTRAINT "scheduled_tasks_interval_positive" CHECK ("scheduled_tasks"."interval_seconds" IS NULL OR "scheduled_tasks"."interval_seconds" > 0),
	CONSTRAINT "scheduled_tasks_schedule_shape" CHECK (("scheduled_tasks"."schedule_type" = 'once' AND "scheduled_tasks"."run_at" IS NOT NULL AND "scheduled_tasks"."schedule_expression" IS NULL AND "scheduled_tasks"."interval_seconds" IS NULL AND "scheduled_tasks"."schedule_key" IS NULL) OR ("scheduled_tasks"."schedule_type" = 'cron' AND "scheduled_tasks"."run_at" IS NULL AND "scheduled_tasks"."schedule_expression" IS NOT NULL AND "scheduled_tasks"."interval_seconds" IS NULL AND "scheduled_tasks"."schedule_key" IS NOT NULL) OR ("scheduled_tasks"."schedule_type" = 'interval' AND "scheduled_tasks"."run_at" IS NULL AND "scheduled_tasks"."schedule_expression" IS NULL AND "scheduled_tasks"."interval_seconds" IS NOT NULL AND "scheduled_tasks"."schedule_key" IS NULL)),
	CONSTRAINT "scheduled_tasks_last_error_not_empty" CHECK ("scheduled_tasks"."last_error" IS NULL OR length(btrim("scheduled_tasks"."last_error")) > 0)
);
--> statement-breakpoint
ALTER TABLE "messages" ADD COLUMN "source" "message_source" DEFAULT 'chat' NOT NULL;--> statement-breakpoint
ALTER TABLE "messages" ADD COLUMN "source_id" text;--> statement-breakpoint
ALTER TABLE "messages" ADD COLUMN "metadata" jsonb DEFAULT '{}'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "scheduled_task_executions" ADD CONSTRAINT "scheduled_task_executions_scheduled_task_id_scheduled_tasks_id_fk" FOREIGN KEY ("scheduled_task_id") REFERENCES "public"."scheduled_tasks"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "scheduled_task_executions" ADD CONSTRAINT "scheduled_task_executions_source_message_id_messages_id_fk" FOREIGN KEY ("source_message_id") REFERENCES "public"."messages"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "scheduled_task_executions" ADD CONSTRAINT "scheduled_task_executions_assistant_message_id_messages_id_fk" FOREIGN KEY ("assistant_message_id") REFERENCES "public"."messages"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "scheduled_tasks" ADD CONSTRAINT "scheduled_tasks_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "scheduled_tasks" ADD CONSTRAINT "scheduled_tasks_conversation_id_conversations_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."conversations"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "scheduled_task_executions_job_unique" ON "scheduled_task_executions" USING btree ("pg_boss_job_id");--> statement-breakpoint
CREATE UNIQUE INDEX "scheduled_task_executions_occurrence_unique" ON "scheduled_task_executions" USING btree ("scheduled_task_id","occurrence_id");--> statement-breakpoint
CREATE UNIQUE INDEX "scheduled_task_executions_source_message_unique" ON "scheduled_task_executions" USING btree ("source_message_id") WHERE "scheduled_task_executions"."source_message_id" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "scheduled_task_executions_task_started_idx" ON "scheduled_task_executions" USING btree ("scheduled_task_id","started_at" DESC NULLS LAST);--> statement-breakpoint
CREATE UNIQUE INDEX "scheduled_tasks_current_job_unique" ON "scheduled_tasks" USING btree ("current_job_id") WHERE "scheduled_tasks"."current_job_id" IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "scheduled_tasks_schedule_key_unique" ON "scheduled_tasks" USING btree ("schedule_key") WHERE "scheduled_tasks"."schedule_key" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "scheduled_tasks_user_enabled_updated_idx" ON "scheduled_tasks" USING btree ("user_id","enabled","updated_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "scheduled_tasks_next_run_idx" ON "scheduled_tasks" USING btree ("next_run_at") WHERE "scheduled_tasks"."enabled" = true;--> statement-breakpoint
CREATE UNIQUE INDEX "messages_source_role_unique" ON "messages" USING btree ("source","source_id","role") WHERE "messages"."source_id" IS NOT NULL;--> statement-breakpoint
ALTER TABLE "messages" ADD CONSTRAINT "messages_source_shape" CHECK (("messages"."source" = 'chat' AND "messages"."source_id" IS NULL) OR ("messages"."source" = 'scheduled_task' AND length(btrim("messages"."source_id")) > 0));--> statement-breakpoint
ALTER TABLE "messages" ADD CONSTRAINT "messages_metadata_object" CHECK (jsonb_typeof("messages"."metadata") = 'object');