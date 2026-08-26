CREATE TABLE "person_relationships" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"from_person_id" uuid NOT NULL,
	"to_person_id" uuid NOT NULL,
	"relationship" text NOT NULL,
	"notes" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "person_relationships_relationship_not_empty" CHECK (length(btrim("person_relationships"."relationship")) > 0),
	CONSTRAINT "person_relationships_notes_not_empty" CHECK ("person_relationships"."notes" IS NULL OR length(btrim("person_relationships"."notes")) > 0),
	CONSTRAINT "person_relationships_not_self" CHECK ("person_relationships"."from_person_id" <> "person_relationships"."to_person_id")
);
--> statement-breakpoint
ALTER TABLE "person_relationships" ADD CONSTRAINT "person_relationships_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "person_relationships" ADD CONSTRAINT "person_relationships_from_person_id_people_id_fk" FOREIGN KEY ("from_person_id") REFERENCES "public"."people"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "person_relationships" ADD CONSTRAINT "person_relationships_to_person_id_people_id_fk" FOREIGN KEY ("to_person_id") REFERENCES "public"."people"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "person_relationships_unique" ON "person_relationships" USING btree ("user_id","from_person_id","to_person_id","relationship");--> statement-breakpoint
CREATE INDEX "person_relationships_from_idx" ON "person_relationships" USING btree ("from_person_id");--> statement-breakpoint
CREATE INDEX "person_relationships_to_idx" ON "person_relationships" USING btree ("to_person_id");