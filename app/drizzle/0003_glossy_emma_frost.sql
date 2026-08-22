-- Global execution modes, action-bound confirmations, and audit metadata.
CREATE TYPE "public"."action_impact" AS ENUM('normal', 'sensitive');--> statement-breakpoint
CREATE TYPE "public"."action_mutability" AS ENUM('read', 'write');--> statement-breakpoint
CREATE TYPE "public"."confirmation_status" AS ENUM('PENDING', 'APPROVED', 'DENIED', 'EXPIRED', 'EXECUTING', 'EXECUTED', 'FAILED');--> statement-breakpoint
CREATE TYPE "public"."execution_mode" AS ENUM('SAFE', 'AUTO', 'FULL_ACCESS');--> statement-breakpoint
CREATE TABLE "action_confirmations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"agent_run_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"conversation_id" uuid NOT NULL,
	"skill" text NOT NULL,
	"sanitized_arguments" jsonb NOT NULL,
	"action_hash" text NOT NULL,
	"reason" text NOT NULL,
	"execution_mode" "execution_mode" NOT NULL,
	"mutability" "action_mutability" NOT NULL,
	"impact" "action_impact" NOT NULL,
	"settings_revision" integer NOT NULL,
	"status" "confirmation_status" DEFAULT 'PENDING' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"resolved_at" timestamp with time zone,
	"resolved_by" uuid,
	CONSTRAINT "action_confirmations_skill_not_empty" CHECK (length(btrim("action_confirmations"."skill")) > 0),
	CONSTRAINT "action_confirmations_hash_shape" CHECK ("action_confirmations"."action_hash" ~ '^[a-f0-9]{64}$'),
	CONSTRAINT "action_confirmations_reason_not_empty" CHECK (length(btrim("action_confirmations"."reason")) > 0),
	CONSTRAINT "action_confirmations_expiry_after_creation" CHECK ("action_confirmations"."expires_at" > "action_confirmations"."created_at"),
	CONSTRAINT "action_confirmations_settings_revision_nonnegative" CHECK ("action_confirmations"."settings_revision" >= 0),
	CONSTRAINT "action_confirmations_resolution_shape" CHECK (("action_confirmations"."status" = 'PENDING' AND "action_confirmations"."resolved_at" IS NULL AND "action_confirmations"."resolved_by" IS NULL) OR ("action_confirmations"."status" <> 'PENDING' AND "action_confirmations"."resolved_at" IS NOT NULL))
);
--> statement-breakpoint
CREATE TABLE "system_settings" (
	"key" text PRIMARY KEY DEFAULT 'global' NOT NULL,
	"execution_mode" "execution_mode" DEFAULT 'AUTO' NOT NULL,
	"lockdown" boolean DEFAULT false NOT NULL,
	"revision" integer DEFAULT 0 NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" uuid,
	CONSTRAINT "system_settings_singleton" CHECK ("system_settings"."key" = 'global'),
	CONSTRAINT "system_settings_revision_nonnegative" CHECK ("system_settings"."revision" >= 0)
);
--> statement-breakpoint
INSERT INTO "system_settings" ("key", "execution_mode", "lockdown", "revision", "updated_by")
VALUES ('global', 'AUTO', false, 0, NULL)
ON CONFLICT ("key") DO NOTHING;--> statement-breakpoint
ALTER TABLE "skill_runs" ADD COLUMN "execution_mode" "execution_mode" DEFAULT 'AUTO' NOT NULL;--> statement-breakpoint
ALTER TABLE "skill_runs" ADD COLUMN "mutability" "action_mutability" DEFAULT 'read' NOT NULL;--> statement-breakpoint
ALTER TABLE "skill_runs" ADD COLUMN "impact" "action_impact" DEFAULT 'normal' NOT NULL;--> statement-breakpoint
ALTER TABLE "skill_runs" ADD COLUMN "confirmation_id" uuid;--> statement-breakpoint
UPDATE "skill_runs"
SET "mutability" = 'write'
WHERE EXISTS (
	SELECT 1
	FROM unnest("skill_runs"."permissions") AS "legacy_permission"("permission_name")
	WHERE "permission_name" LIKE '%.write'
);--> statement-breakpoint
ALTER TABLE "action_confirmations" ADD CONSTRAINT "action_confirmations_agent_run_id_agent_runs_id_fk" FOREIGN KEY ("agent_run_id") REFERENCES "public"."agent_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "action_confirmations" ADD CONSTRAINT "action_confirmations_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "action_confirmations" ADD CONSTRAINT "action_confirmations_conversation_id_conversations_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."conversations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "action_confirmations" ADD CONSTRAINT "action_confirmations_resolved_by_users_id_fk" FOREIGN KEY ("resolved_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "system_settings" ADD CONSTRAINT "system_settings_updated_by_users_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "action_confirmations_one_pending_per_conversation" ON "action_confirmations" USING btree ("user_id","conversation_id") WHERE "action_confirmations"."status" = 'PENDING';--> statement-breakpoint
CREATE INDEX "action_confirmations_expiry_idx" ON "action_confirmations" USING btree ("status","expires_at");--> statement-breakpoint
ALTER TABLE "skill_runs" ADD CONSTRAINT "skill_runs_confirmation_id_action_confirmations_id_fk" FOREIGN KEY ("confirmation_id") REFERENCES "public"."action_confirmations"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "skill_runs" DROP COLUMN "permissions";
