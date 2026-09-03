CREATE TYPE "public"."trading_market_regime" AS ENUM('BULLISH', 'SIDEWAYS', 'BEARISH', 'UNKNOWN');--> statement-breakpoint
CREATE TABLE "trade_opportunities" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"scan_id" uuid NOT NULL,
	"instrument_token" bigint NOT NULL,
	"exchange" text NOT NULL,
	"tradingsymbol" text NOT NULL,
	"primary_strategy" text NOT NULL,
	"final_score" double precision NOT NULL,
	"regime" "trading_market_regime" NOT NULL,
	"reasons_json" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"metrics_json" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "trade_opportunities_exchange_not_empty" CHECK (length(btrim("trade_opportunities"."exchange")) > 0),
	CONSTRAINT "trade_opportunities_tradingsymbol_not_empty" CHECK (length(btrim("trade_opportunities"."tradingsymbol")) > 0),
	CONSTRAINT "trade_opportunities_primary_strategy_not_empty" CHECK (length(btrim("trade_opportunities"."primary_strategy")) > 0),
	CONSTRAINT "trade_opportunities_final_score_range" CHECK ("trade_opportunities"."final_score" >= 0 AND "trade_opportunities"."final_score" <= 100),
	CONSTRAINT "trade_opportunities_reasons_is_array" CHECK (jsonb_typeof("trade_opportunities"."reasons_json") = 'array'),
	CONSTRAINT "trade_opportunities_metrics_is_object" CHECK (jsonb_typeof("trade_opportunities"."metrics_json") = 'object')
);
--> statement-breakpoint
CREATE TABLE "trading_scans" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"started_at" timestamp with time zone NOT NULL,
	"completed_at" timestamp with time zone NOT NULL,
	"benchmark" text NOT NULL,
	"market_regime" "trading_market_regime" NOT NULL,
	"total_instruments" integer NOT NULL,
	"analyzed_instruments" integer NOT NULL,
	"skipped_instruments" integer NOT NULL,
	"failed_instruments" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "trading_scans_benchmark_not_empty" CHECK (length(btrim("trading_scans"."benchmark")) > 0),
	CONSTRAINT "trading_scans_completed_after_started" CHECK ("trading_scans"."completed_at" >= "trading_scans"."started_at"),
	CONSTRAINT "trading_scans_total_nonnegative" CHECK ("trading_scans"."total_instruments" >= 0),
	CONSTRAINT "trading_scans_analyzed_nonnegative" CHECK ("trading_scans"."analyzed_instruments" >= 0),
	CONSTRAINT "trading_scans_skipped_nonnegative" CHECK ("trading_scans"."skipped_instruments" >= 0),
	CONSTRAINT "trading_scans_failed_nonnegative" CHECK ("trading_scans"."failed_instruments" >= 0)
);
--> statement-breakpoint
ALTER TABLE "trade_opportunities" ADD CONSTRAINT "trade_opportunities_scan_id_trading_scans_id_fk" FOREIGN KEY ("scan_id") REFERENCES "public"."trading_scans"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "trade_opportunities_scan_id_idx" ON "trade_opportunities" USING btree ("scan_id");--> statement-breakpoint
CREATE INDEX "trade_opportunities_symbol_created_idx" ON "trade_opportunities" USING btree ("tradingsymbol","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "trade_opportunities_final_score_idx" ON "trade_opportunities" USING btree ("final_score" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "trading_scans_started_at_idx" ON "trading_scans" USING btree ("started_at" DESC NULLS LAST);