CREATE TABLE "people" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"display_name" text NOT NULL,
	"is_owner" boolean DEFAULT false NOT NULL,
	"relationship" text,
	"notes" text,
	"details" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "people_display_name_not_empty" CHECK (length(btrim("people"."display_name")) > 0),
	CONSTRAINT "people_relationship_not_empty" CHECK ("people"."relationship" IS NULL OR length(btrim("people"."relationship")) > 0),
	CONSTRAINT "people_notes_not_empty" CHECK ("people"."notes" IS NULL OR length(btrim("people"."notes")) > 0),
	CONSTRAINT "people_details_object" CHECK (jsonb_typeof("people"."details") = 'object')
);
--> statement-breakpoint
CREATE TABLE "person_aliases" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"person_id" uuid NOT NULL,
	"alias" text NOT NULL,
	"normalized_alias" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "person_aliases_alias_not_empty" CHECK (length(btrim("person_aliases"."alias")) > 0),
	CONSTRAINT "person_aliases_normalized_not_empty" CHECK (length("person_aliases"."normalized_alias") > 0)
);
--> statement-breakpoint
CREATE TABLE "person_face_embeddings" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"person_id" uuid NOT NULL,
	"embedding" vector(512) NOT NULL,
	"quality_score" real NOT NULL,
	"detection_score" real NOT NULL,
	"bounding_box" jsonb NOT NULL,
	"model" text NOT NULL,
	"source" text,
	"image_sha256" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "person_face_embeddings_quality_range" CHECK ("person_face_embeddings"."quality_score" >= 0 AND "person_face_embeddings"."quality_score" <= 1),
	CONSTRAINT "person_face_embeddings_detection_range" CHECK ("person_face_embeddings"."detection_score" >= 0 AND "person_face_embeddings"."detection_score" <= 1),
	CONSTRAINT "person_face_embeddings_bbox_object" CHECK (jsonb_typeof("person_face_embeddings"."bounding_box") = 'object'),
	CONSTRAINT "person_face_embeddings_model_not_empty" CHECK (length(btrim("person_face_embeddings"."model")) > 0),
	CONSTRAINT "person_face_embeddings_source_not_empty" CHECK ("person_face_embeddings"."source" IS NULL OR length(btrim("person_face_embeddings"."source")) > 0),
	CONSTRAINT "person_face_embeddings_sha256_shape" CHECK ("person_face_embeddings"."image_sha256" ~ '^[a-f0-9]{64}$')
);
--> statement-breakpoint
ALTER TABLE "people" ADD CONSTRAINT "people_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "person_aliases" ADD CONSTRAINT "person_aliases_person_id_people_id_fk" FOREIGN KEY ("person_id") REFERENCES "public"."people"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "person_face_embeddings" ADD CONSTRAINT "person_face_embeddings_person_id_people_id_fk" FOREIGN KEY ("person_id") REFERENCES "public"."people"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "people_one_owner_per_user" ON "people" USING btree ("user_id") WHERE "people"."is_owner" = true;--> statement-breakpoint
CREATE INDEX "people_user_display_name_idx" ON "people" USING btree ("user_id","display_name");--> statement-breakpoint
CREATE UNIQUE INDEX "person_aliases_person_normalized_unique" ON "person_aliases" USING btree ("person_id","normalized_alias");--> statement-breakpoint
CREATE INDEX "person_aliases_person_idx" ON "person_aliases" USING btree ("person_id");--> statement-breakpoint
CREATE INDEX "person_aliases_normalized_idx" ON "person_aliases" USING btree ("normalized_alias");--> statement-breakpoint
CREATE UNIQUE INDEX "person_face_embeddings_sha256_unique" ON "person_face_embeddings" USING btree ("image_sha256");--> statement-breakpoint
CREATE INDEX "person_face_embeddings_person_idx" ON "person_face_embeddings" USING btree ("person_id");--> statement-breakpoint
CREATE INDEX "person_face_embeddings_embedding_hnsw" ON "person_face_embeddings" USING hnsw ("embedding" vector_cosine_ops);