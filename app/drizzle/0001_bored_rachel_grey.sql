CREATE TYPE "public"."agent_run_status" AS ENUM('running', 'succeeded', 'failed', 'cancelled', 'max_steps');--> statement-breakpoint
CREATE TYPE "public"."skill_run_status" AS ENUM('running', 'succeeded', 'failed', 'denied', 'cancelled');--> statement-breakpoint
CREATE TABLE "agent_runs" (
	"id" uuid PRIMARY KEY NOT NULL,
	"user_id" uuid NOT NULL,
	"conversation_id" uuid NOT NULL,
	"request" text NOT NULL,
	"status" "agent_run_status" DEFAULT 'running' NOT NULL,
	"step_count" integer DEFAULT 0 NOT NULL,
	"error_code" text,
	"started_at" timestamp with time zone NOT NULL,
	"finished_at" timestamp with time zone,
	"duration_ms" integer,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	CONSTRAINT "agent_runs_request_not_empty" CHECK (length(btrim("agent_runs"."request")) > 0),
	CONSTRAINT "agent_runs_step_count_nonnegative" CHECK ("agent_runs"."step_count" >= 0),
	CONSTRAINT "agent_runs_duration_nonnegative" CHECK ("agent_runs"."duration_ms" IS NULL OR "agent_runs"."duration_ms" >= 0)
);
--> statement-breakpoint
CREATE TABLE "skill_runs" (
	"id" uuid PRIMARY KEY NOT NULL,
	"agent_run_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"conversation_id" uuid NOT NULL,
	"skill" text NOT NULL,
	"input" jsonb NOT NULL,
	"permissions" text[] NOT NULL,
	"result" jsonb,
	"status" "skill_run_status" DEFAULT 'running' NOT NULL,
	"error_code" text,
	"started_at" timestamp with time zone NOT NULL,
	"finished_at" timestamp with time zone,
	"duration_ms" integer,
	CONSTRAINT "skill_runs_skill_not_empty" CHECK (length(btrim("skill_runs"."skill")) > 0),
	CONSTRAINT "skill_runs_duration_nonnegative" CHECK ("skill_runs"."duration_ms" IS NULL OR "skill_runs"."duration_ms" >= 0)
);
--> statement-breakpoint
ALTER TABLE "agent_runs" ADD CONSTRAINT "agent_runs_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_runs" ADD CONSTRAINT "agent_runs_conversation_id_conversations_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."conversations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "skill_runs" ADD CONSTRAINT "skill_runs_agent_run_id_agent_runs_id_fk" FOREIGN KEY ("agent_run_id") REFERENCES "public"."agent_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "skill_runs" ADD CONSTRAINT "skill_runs_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "skill_runs" ADD CONSTRAINT "skill_runs_conversation_id_conversations_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."conversations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "agent_runs_user_started_idx" ON "agent_runs" USING btree ("user_id","started_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "agent_runs_conversation_started_idx" ON "agent_runs" USING btree ("conversation_id","started_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "skill_runs_agent_started_idx" ON "skill_runs" USING btree ("agent_run_id","started_at");--> statement-breakpoint
CREATE INDEX "skill_runs_user_skill_started_idx" ON "skill_runs" USING btree ("user_id","skill","started_at" DESC NULLS LAST);