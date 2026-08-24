CREATE TABLE "agent_responses" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"task_id" uuid NOT NULL,
	"agent_id" text NOT NULL,
	"message" text NOT NULL,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"agent_timestamp" timestamp with time zone NOT NULL,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL,
	"redis_message_id" text NOT NULL,
	"processing_started_at" timestamp with time zone,
	"processed_at" timestamp with time zone,
	"assistant_message_id" uuid,
	CONSTRAINT "agent_responses_agent_id_not_empty" CHECK (length(btrim("agent_responses"."agent_id")) > 0),
	CONSTRAINT "agent_responses_message_not_empty" CHECK (length(btrim("agent_responses"."message")) > 0),
	CONSTRAINT "agent_responses_metadata_object" CHECK (jsonb_typeof("agent_responses"."metadata") = 'object'),
	CONSTRAINT "agent_responses_processing_shape" CHECK ("agent_responses"."processed_at" IS NULL OR "agent_responses"."processing_started_at" IS NOT NULL)
);
--> statement-breakpoint
CREATE TABLE "agent_tasks" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"orchestration_request_id" uuid NOT NULL,
	"agent_id" text NOT NULL,
	"instruction" text NOT NULL,
	"created_from_response_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deadline_at" timestamp with time zone NOT NULL,
	"published_at" timestamp with time zone,
	"redis_message_id" text,
	"delivery_attempts" integer DEFAULT 0 NOT NULL,
	"last_delivery_error" text,
	"abandoned_at" timestamp with time zone,
	CONSTRAINT "agent_tasks_agent_id_not_empty" CHECK (length(btrim("agent_tasks"."agent_id")) > 0),
	CONSTRAINT "agent_tasks_instruction_not_empty" CHECK (length(btrim("agent_tasks"."instruction")) > 0),
	CONSTRAINT "agent_tasks_deadline_after_creation" CHECK ("agent_tasks"."deadline_at" > "agent_tasks"."created_at"),
	CONSTRAINT "agent_tasks_delivery_attempts_nonnegative" CHECK ("agent_tasks"."delivery_attempts" >= 0),
	CONSTRAINT "agent_tasks_publish_shape" CHECK (("agent_tasks"."published_at" IS NULL) = ("agent_tasks"."redis_message_id" IS NULL))
);
--> statement-breakpoint
CREATE TABLE "orchestration_requests" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"conversation_id" uuid NOT NULL,
	"source_message_id" uuid NOT NULL,
	"original_user_request" text NOT NULL,
	"execution_context" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"completed_at" timestamp with time zone,
	CONSTRAINT "orchestration_requests_original_request_not_empty" CHECK (length(btrim("orchestration_requests"."original_user_request")) > 0),
	CONSTRAINT "orchestration_requests_execution_context_not_empty" CHECK (length(btrim("orchestration_requests"."execution_context")) > 0),
	CONSTRAINT "orchestration_requests_completion_after_creation" CHECK ("orchestration_requests"."completed_at" IS NULL OR "orchestration_requests"."completed_at" >= "orchestration_requests"."created_at")
);
--> statement-breakpoint
ALTER TABLE "agent_responses" ADD CONSTRAINT "agent_responses_task_id_agent_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."agent_tasks"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_responses" ADD CONSTRAINT "agent_responses_assistant_message_id_messages_id_fk" FOREIGN KEY ("assistant_message_id") REFERENCES "public"."messages"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_tasks" ADD CONSTRAINT "agent_tasks_orchestration_request_id_orchestration_requests_id_fk" FOREIGN KEY ("orchestration_request_id") REFERENCES "public"."orchestration_requests"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_tasks" ADD CONSTRAINT "agent_tasks_created_from_response_id_agent_responses_id_fk" FOREIGN KEY ("created_from_response_id") REFERENCES "public"."agent_responses"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "orchestration_requests" ADD CONSTRAINT "orchestration_requests_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "orchestration_requests" ADD CONSTRAINT "orchestration_requests_conversation_id_conversations_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."conversations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "orchestration_requests" ADD CONSTRAINT "orchestration_requests_source_message_id_messages_id_fk" FOREIGN KEY ("source_message_id") REFERENCES "public"."messages"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "agent_responses_task_unique" ON "agent_responses" USING btree ("task_id");--> statement-breakpoint
CREATE UNIQUE INDEX "agent_responses_redis_message_unique" ON "agent_responses" USING btree ("redis_message_id");--> statement-breakpoint
CREATE INDEX "agent_responses_unprocessed_idx" ON "agent_responses" USING btree ("received_at") WHERE "agent_responses"."processed_at" IS NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "agent_tasks_source_response_unique" ON "agent_tasks" USING btree ("created_from_response_id") WHERE "agent_tasks"."created_from_response_id" IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "agent_tasks_redis_message_unique" ON "agent_tasks" USING btree ("redis_message_id") WHERE "agent_tasks"."redis_message_id" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "agent_tasks_request_created_idx" ON "agent_tasks" USING btree ("orchestration_request_id","created_at");--> statement-breakpoint
CREATE INDEX "agent_tasks_unpublished_idx" ON "agent_tasks" USING btree ("created_at") WHERE "agent_tasks"."published_at" IS NULL AND "agent_tasks"."abandoned_at" IS NULL;--> statement-breakpoint
CREATE INDEX "agent_tasks_deadline_idx" ON "agent_tasks" USING btree ("deadline_at") WHERE "agent_tasks"."abandoned_at" IS NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "orchestration_requests_source_message_unique" ON "orchestration_requests" USING btree ("source_message_id");--> statement-breakpoint
CREATE INDEX "orchestration_requests_conversation_created_idx" ON "orchestration_requests" USING btree ("conversation_id","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "orchestration_requests_active_idx" ON "orchestration_requests" USING btree ("updated_at") WHERE "orchestration_requests"."completed_at" IS NULL;