CREATE TABLE "trading_orders" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"kite_order_id" text,
	"tradingsymbol" text NOT NULL,
	"exchange" text NOT NULL,
	"transaction_type" text NOT NULL,
	"quantity" integer NOT NULL,
	"order_type" text NOT NULL,
	"product" text NOT NULL,
	"price" numeric,
	"status" text NOT NULL,
	"error_message" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "trading_orders_tradingsymbol_not_empty" CHECK (length(btrim("trading_orders"."tradingsymbol")) > 0),
	CONSTRAINT "trading_orders_exchange_not_empty" CHECK (length(btrim("trading_orders"."exchange")) > 0),
	CONSTRAINT "trading_orders_transaction_type_valid" CHECK ("trading_orders"."transaction_type" IN ('BUY', 'SELL')),
	CONSTRAINT "trading_orders_quantity_positive" CHECK ("trading_orders"."quantity" > 0),
	CONSTRAINT "trading_orders_order_type_valid" CHECK ("trading_orders"."order_type" IN ('MARKET', 'LIMIT')),
	CONSTRAINT "trading_orders_product_valid" CHECK ("trading_orders"."product" IN ('CNC', 'MIS', 'NRML')),
	CONSTRAINT "trading_orders_status_not_empty" CHECK (length(btrim("trading_orders"."status")) > 0)
);
--> statement-breakpoint
CREATE INDEX "trading_orders_created_at_idx" ON "trading_orders" USING btree ("created_at" DESC NULLS LAST);
