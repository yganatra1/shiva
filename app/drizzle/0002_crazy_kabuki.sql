CREATE TYPE "public"."expense_sheet_binding_status" AS ENUM('provisioning', 'ready');--> statement-breakpoint
CREATE TABLE "expense_sheet_bindings" (
	"user_id" uuid PRIMARY KEY NOT NULL,
	"spreadsheet_id" text,
	"sheet_id" integer,
	"status" "expense_sheet_binding_status" DEFAULT 'provisioning' NOT NULL,
	"schema_version" integer DEFAULT 1 NOT NULL,
	"lease_owner" uuid,
	"lease_expires_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "expense_sheet_bindings_spreadsheet_not_empty" CHECK ("expense_sheet_bindings"."spreadsheet_id" IS NULL OR length(btrim("expense_sheet_bindings"."spreadsheet_id")) > 0),
	CONSTRAINT "expense_sheet_bindings_sheet_id_nonnegative" CHECK ("expense_sheet_bindings"."sheet_id" IS NULL OR "expense_sheet_bindings"."sheet_id" >= 0),
	CONSTRAINT "expense_sheet_bindings_schema_version_positive" CHECK ("expense_sheet_bindings"."schema_version" > 0),
	CONSTRAINT "expense_sheet_bindings_lease_shape" CHECK (("expense_sheet_bindings"."lease_owner" IS NULL) = ("expense_sheet_bindings"."lease_expires_at" IS NULL)),
	CONSTRAINT "expense_sheet_bindings_ready_shape" CHECK ("expense_sheet_bindings"."status" <> 'ready' OR ("expense_sheet_bindings"."spreadsheet_id" IS NOT NULL AND "expense_sheet_bindings"."sheet_id" IS NOT NULL AND "expense_sheet_bindings"."lease_owner" IS NULL))
);
--> statement-breakpoint
ALTER TABLE "expense_sheet_bindings" ADD CONSTRAINT "expense_sheet_bindings_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "expense_sheet_bindings_spreadsheet_unique" ON "expense_sheet_bindings" USING btree ("spreadsheet_id") WHERE "expense_sheet_bindings"."spreadsheet_id" IS NOT NULL;