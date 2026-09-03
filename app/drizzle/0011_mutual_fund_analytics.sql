CREATE TABLE "mutual_fund_scheme_list_cache" (
	"id" text PRIMARY KEY NOT NULL,
	"fetched_at" timestamp with time zone NOT NULL,
	"funds_json" jsonb NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "mutual_fund_nav_history" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"scheme_code" integer NOT NULL,
	"latest_nav_date" text NOT NULL,
	"inception_date" text NOT NULL,
	"nav_observation_count" integer NOT NULL,
	"history_json" jsonb NOT NULL,
	"fetched_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "mutual_fund_nav_history_scheme_positive" CHECK ("mutual_fund_nav_history"."scheme_code" > 0),
	CONSTRAINT "mutual_fund_nav_history_latest_iso" CHECK ("mutual_fund_nav_history"."latest_nav_date" ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$'),
	CONSTRAINT "mutual_fund_nav_history_inception_iso" CHECK ("mutual_fund_nav_history"."inception_date" ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$'),
	CONSTRAINT "mutual_fund_nav_history_count_positive" CHECK ("mutual_fund_nav_history"."nav_observation_count" > 0),
	CONSTRAINT "mutual_fund_nav_history_json_object" CHECK (jsonb_typeof("mutual_fund_nav_history"."history_json") = 'object')
);
--> statement-breakpoint
CREATE TABLE "mutual_fund_analytics" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"scheme_code" integer NOT NULL,
	"latest_nav_date" text NOT NULL,
	"calculation_version" text NOT NULL,
	"risk_free_rate" double precision NOT NULL,
	"nav_observation_count" integer NOT NULL,
	"assumptions_json" jsonb NOT NULL,
	"snapshot_json" jsonb NOT NULL,
	"calculated_at" timestamp with time zone NOT NULL,
	CONSTRAINT "mutual_fund_analytics_scheme_positive" CHECK ("mutual_fund_analytics"."scheme_code" > 0),
	CONSTRAINT "mutual_fund_analytics_latest_iso" CHECK ("mutual_fund_analytics"."latest_nav_date" ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$'),
	CONSTRAINT "mutual_fund_analytics_version_not_empty" CHECK (length(btrim("mutual_fund_analytics"."calculation_version")) > 0),
	CONSTRAINT "mutual_fund_analytics_count_positive" CHECK ("mutual_fund_analytics"."nav_observation_count" > 0),
	CONSTRAINT "mutual_fund_analytics_snapshot_object" CHECK (jsonb_typeof("mutual_fund_analytics"."snapshot_json") = 'object')
);
--> statement-breakpoint
CREATE UNIQUE INDEX "mutual_fund_nav_history_scheme_latest_idx" ON "mutual_fund_nav_history" USING btree ("scheme_code","latest_nav_date");
--> statement-breakpoint
CREATE INDEX "mutual_fund_nav_history_scheme_idx" ON "mutual_fund_nav_history" USING btree ("scheme_code");
--> statement-breakpoint
CREATE UNIQUE INDEX "mutual_fund_analytics_scheme_date_version_idx" ON "mutual_fund_analytics" USING btree ("scheme_code","latest_nav_date","calculation_version");
--> statement-breakpoint
CREATE INDEX "mutual_fund_analytics_scheme_idx" ON "mutual_fund_analytics" USING btree ("scheme_code");
