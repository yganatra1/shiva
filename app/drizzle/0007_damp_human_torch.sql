ALTER TABLE "agent_responses" ADD COLUMN "processing_attempts" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "agent_responses" ADD COLUMN "last_processing_error" text;--> statement-breakpoint
ALTER TABLE "agent_responses" ADD CONSTRAINT "agent_responses_processing_attempts_nonnegative" CHECK ("agent_responses"."processing_attempts" >= 0);