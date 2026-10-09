CREATE TYPE "public"."attempt_resolver" AS ENUM('supplier', 'poll', 'webhook', 'admin');--> statement-breakpoint
CREATE TYPE "public"."attempt_status" AS ENUM('sending', 'pending', 'unknown', 'delivered', 'failed');--> statement-breakpoint
CREATE TYPE "public"."code_reveal_actor" AS ENUM('customer', 'admin');--> statement-breakpoint
CREATE TYPE "public"."order_event_actor" AS ENUM('customer', 'system', 'supplier', 'admin');--> statement-breakpoint
CREATE TYPE "public"."order_event_kind" AS ENUM('status', 'attempt', 'note');--> statement-breakpoint
CREATE TYPE "public"."order_status" AS ENUM('awaiting_balance', 'paid', 'sent_to_supplier', 'failed', 'needs_review', 'delivered', 'partially_refunded', 'refunded', 'cancelled');--> statement-breakpoint
CREATE TYPE "public"."refund_reason" AS ENUM('no_route', 'routes_exhausted', 'input_rejected', 'admin');--> statement-breakpoint
CREATE TYPE "public"."webhook_event_result" AS ENUM('applied', 'same_result', 'unknown_key', 'conflict', 'malformed');--> statement-breakpoint
ALTER TYPE "public"."email_template" ADD VALUE 'customer_order_delivered';--> statement-breakpoint
ALTER TYPE "public"."email_template" ADD VALUE 'customer_order_partially_refunded';--> statement-breakpoint
ALTER TYPE "public"."email_template" ADD VALUE 'customer_order_refunded';--> statement-breakpoint
ALTER TYPE "public"."notification_event" ADD VALUE 'order_delivered';--> statement-breakpoint
ALTER TYPE "public"."notification_event" ADD VALUE 'order_partially_refunded';--> statement-breakpoint
ALTER TYPE "public"."notification_event" ADD VALUE 'order_refunded';--> statement-breakpoint
ALTER TYPE "public"."notification_event" ADD VALUE 'order_delayed';--> statement-breakpoint
CREATE TABLE "fulfilment_attempts" (
	"id" uuid PRIMARY KEY NOT NULL,
	"order_id" uuid NOT NULL,
	"route_id" uuid NOT NULL,
	"supplier_id" uuid NOT NULL,
	"offer_id" uuid NOT NULL,
	"supplier_offer_id" text NOT NULL,
	"quantity" integer NOT NULL,
	"unit_cost_usd_units" bigint NOT NULL,
	"status" "attempt_status" NOT NULL,
	"delivered_quantity" integer DEFAULT 0 NOT NULL,
	"supplier_order_id" text,
	"failure_reason" text,
	"input_rejected" boolean DEFAULT false NOT NULL,
	"supplier_error_code" text,
	"candidates" jsonb NOT NULL,
	"result" jsonb,
	"sent_at" timestamp with time zone,
	"poll_count" integer DEFAULT 0 NOT NULL,
	"next_poll_at" timestamp with time zone,
	"reminded_at" timestamp with time zone,
	"resolved_at" timestamp with time zone,
	"resolved_by" "attempt_resolver",
	"admin_reason" text,
	"decision_idempotency_key" uuid,
	"cost_journal_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "fulfilment_attempts_decision_idempotency_key_unique" UNIQUE("decision_idempotency_key"),
	CONSTRAINT "fulfilment_attempts_cost_journal_id_unique" UNIQUE("cost_journal_id"),
	CONSTRAINT "fulfilment_attempts_quantity_check" CHECK ("fulfilment_attempts"."quantity" between 1 and 50),
	CONSTRAINT "fulfilment_attempts_delivered_check" CHECK ("fulfilment_attempts"."delivered_quantity" between 0 and "fulfilment_attempts"."quantity"
        and ("fulfilment_attempts"."status" = 'delivered') = ("fulfilment_attempts"."delivered_quantity" > 0)),
	CONSTRAINT "fulfilment_attempts_unit_cost_check" CHECK ("fulfilment_attempts"."unit_cost_usd_units" > 0),
	CONSTRAINT "fulfilment_attempts_resolved_check" CHECK (("fulfilment_attempts"."status" in ('delivered', 'failed')) = ("fulfilment_attempts"."resolved_at" is not null)
        and ("fulfilment_attempts"."resolved_at" is null) = ("fulfilment_attempts"."resolved_by" is null)
        and ("fulfilment_attempts"."status" = 'delivered') = ("fulfilment_attempts"."cost_journal_id" is not null)
        and (not "fulfilment_attempts"."input_rejected" or "fulfilment_attempts"."status" = 'failed')
        and ("fulfilment_attempts"."resolved_by" = 'admin') = ("fulfilment_attempts"."admin_reason" is not null)),
	CONSTRAINT "fulfilment_attempts_text_check" CHECK (char_length("fulfilment_attempts"."supplier_offer_id") between 1 and 128
        and char_length("fulfilment_attempts"."supplier_order_id") between 1 and 128
        and char_length("fulfilment_attempts"."failure_reason") between 1 and 200
        and char_length("fulfilment_attempts"."supplier_error_code") between 1 and 64
        and char_length("fulfilment_attempts"."admin_reason") between 5 and 500),
	CONSTRAINT "fulfilment_attempts_poll_count_check" CHECK ("fulfilment_attempts"."poll_count" >= 0)
);
--> statement-breakpoint
CREATE TABLE "order_code_reveals" (
	"id" uuid PRIMARY KEY NOT NULL,
	"code_id" uuid NOT NULL,
	"order_id" uuid NOT NULL,
	"actor" "code_reveal_actor" NOT NULL,
	"actor_id" uuid NOT NULL,
	"ip" "inet",
	"user_agent" text,
	"created_at" timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
	CONSTRAINT "order_code_reveals_user_agent_check" CHECK (char_length("order_code_reveals"."user_agent") <= 300)
);
--> statement-breakpoint
CREATE TABLE "order_codes" (
	"id" uuid PRIMARY KEY NOT NULL,
	"order_id" uuid NOT NULL,
	"attempt_id" uuid NOT NULL,
	"position" integer NOT NULL,
	"ciphertext" "bytea" NOT NULL,
	"hint" text,
	"created_at" timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
	CONSTRAINT "order_codes_position_check" CHECK ("order_codes"."position" between 1 and 50),
	CONSTRAINT "order_codes_hint_check" CHECK (char_length("order_codes"."hint") = 4)
);
--> statement-breakpoint
CREATE TABLE "order_events" (
	"id" uuid PRIMARY KEY NOT NULL,
	"order_id" uuid NOT NULL,
	"kind" "order_event_kind" NOT NULL,
	"from_status" "order_status",
	"to_status" "order_status",
	"actor" "order_event_actor" NOT NULL,
	"actor_id" uuid,
	"attempt_id" uuid,
	"reason" text,
	"details" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
	CONSTRAINT "order_events_reason_check" CHECK (char_length("order_events"."reason") between 1 and 64),
	CONSTRAINT "order_events_status_check" CHECK (("order_events"."kind" = 'status') = ("order_events"."to_status" is not null))
);
--> statement-breakpoint
CREATE TABLE "order_policy" (
	"id" uuid PRIMARY KEY NOT NULL,
	"first_poll_seconds" integer NOT NULL,
	"fast_poll_seconds" integer NOT NULL,
	"fast_poll_minutes" integer NOT NULL,
	"slow_poll_seconds" integer NOT NULL,
	"hard_limit_minutes" integer NOT NULL,
	"review_poll_minutes" integer NOT NULL,
	"review_poll_hours" integer NOT NULL,
	"manual_reminder_minutes" integer NOT NULL,
	"admin_id" uuid,
	"created_at" timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
	CONSTRAINT "order_policy_bounds_check" CHECK ("order_policy"."first_poll_seconds" between 15 and 600
        and "order_policy"."fast_poll_seconds" between 15 and 600
        and "order_policy"."fast_poll_minutes" between 1 and 60
        and "order_policy"."slow_poll_seconds" between 60 and 3600
        and "order_policy"."hard_limit_minutes" between 5 and 240
        and "order_policy"."review_poll_minutes" between 5 and 240
        and "order_policy"."review_poll_hours" between 1 and 72
        and "order_policy"."manual_reminder_minutes" between 5 and 240)
);
--> statement-breakpoint
CREATE TABLE "orders" (
	"id" uuid PRIMARY KEY NOT NULL,
	"number" text NOT NULL,
	"customer_id" uuid NOT NULL,
	"is_test" boolean NOT NULL,
	"product_id" uuid NOT NULL,
	"game_id" uuid NOT NULL,
	"kind" "product_kind" NOT NULL,
	"status" "order_status" NOT NULL,
	"quantity" integer NOT NULL,
	"unit_price_usd_units" bigint NOT NULL,
	"total_usd_units" bigint NOT NULL,
	"price_id" uuid NOT NULL,
	"min_margin_usd_units" bigint NOT NULL,
	"fields" jsonb NOT NULL,
	"display_rate_id" uuid,
	"total_syp_units" bigint,
	"delivered_quantity" integer DEFAULT 0 NOT NULL,
	"refunded_quantity" integer DEFAULT 0 NOT NULL,
	"refunded_usd_units" bigint DEFAULT 0 NOT NULL,
	"refund_reason" "refund_reason",
	"idempotency_key" uuid NOT NULL,
	"request_hash" text NOT NULL,
	"purchase_journal_id" uuid NOT NULL,
	"refund_journal_id" uuid,
	"refund_idempotency_key" uuid,
	"paid_at" timestamp with time zone,
	"delivered_at" timestamp with time zone,
	"finished_at" timestamp with time zone,
	"review_since" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "orders_number_unique" UNIQUE("number"),
	CONSTRAINT "orders_idempotency_key_unique" UNIQUE("idempotency_key"),
	CONSTRAINT "orders_purchase_journal_id_unique" UNIQUE("purchase_journal_id"),
	CONSTRAINT "orders_refund_journal_id_unique" UNIQUE("refund_journal_id"),
	CONSTRAINT "orders_refund_idempotency_key_unique" UNIQUE("refund_idempotency_key"),
	CONSTRAINT "orders_number_check" CHECK ("orders"."number" ~ '^VO-[2-9A-HJKMNP-Z]{6}$'),
	CONSTRAINT "orders_quantity_check" CHECK ("orders"."quantity" between 1 and 50),
	CONSTRAINT "orders_unit_price_check" CHECK ("orders"."unit_price_usd_units" > 0 and "orders"."unit_price_usd_units" % 10000 = 0),
	CONSTRAINT "orders_total_check" CHECK ("orders"."total_usd_units" = "orders"."unit_price_usd_units" * "orders"."quantity"),
	CONSTRAINT "orders_min_margin_check" CHECK ("orders"."min_margin_usd_units" >= 0),
	CONSTRAINT "orders_fields_check" CHECK (jsonb_typeof("orders"."fields") = 'object'),
	CONSTRAINT "orders_syp_check" CHECK (("orders"."display_rate_id" is null) = ("orders"."total_syp_units" is null) and "orders"."total_syp_units" >= 0),
	CONSTRAINT "orders_quantities_check" CHECK ("orders"."delivered_quantity" >= 0 and "orders"."refunded_quantity" >= 0
        and "orders"."delivered_quantity" + "orders"."refunded_quantity" <= "orders"."quantity"),
	CONSTRAINT "orders_refunded_check" CHECK ("orders"."refunded_usd_units" = "orders"."unit_price_usd_units" * "orders"."refunded_quantity"
        and ("orders"."refunded_quantity" = 0) = ("orders"."refund_journal_id" is null)
        and ("orders"."refunded_quantity" = 0) = ("orders"."refund_reason" is null)),
	CONSTRAINT "orders_terminal_check" CHECK (("orders"."status" <> 'delivered' or "orders"."delivered_quantity" = "orders"."quantity")
        and ("orders"."status" <> 'partially_refunded' or ("orders"."delivered_quantity" > 0
          and "orders"."refunded_quantity" > 0
          and "orders"."delivered_quantity" + "orders"."refunded_quantity" = "orders"."quantity"))
        and ("orders"."status" <> 'refunded' or ("orders"."delivered_quantity" = 0
          and "orders"."refunded_quantity" = "orders"."quantity"))
        and ("orders"."status" in ('delivered', 'partially_refunded', 'refunded', 'cancelled'))
          = ("orders"."finished_at" is not null)
        and ("orders"."status" = 'delivered') = ("orders"."delivered_at" is not null)
        and ("orders"."status" = 'needs_review') = ("orders"."review_since" is not null)),
	CONSTRAINT "orders_request_hash_check" CHECK ("orders"."request_hash" ~ '^[0-9a-f]{64}$')
);
--> statement-breakpoint
CREATE TABLE "supplier_webhook_events" (
	"id" uuid PRIMARY KEY NOT NULL,
	"supplier_id" uuid NOT NULL,
	"event_id" text NOT NULL,
	"body_ciphertext" "bytea" NOT NULL,
	"attempt_id" uuid,
	"processed_at" timestamp with time zone,
	"result" "webhook_event_result",
	"created_at" timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
	CONSTRAINT "supplier_webhook_events_event_id_check" CHECK (char_length("supplier_webhook_events"."event_id") between 1 and 128),
	CONSTRAINT "supplier_webhook_events_processed_check" CHECK (("supplier_webhook_events"."processed_at" is null) = ("supplier_webhook_events"."result" is null))
);
--> statement-breakpoint
ALTER TABLE "fulfilment_attempts" ADD CONSTRAINT "fulfilment_attempts_order_id_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."orders"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fulfilment_attempts" ADD CONSTRAINT "fulfilment_attempts_route_id_product_routes_id_fk" FOREIGN KEY ("route_id") REFERENCES "public"."product_routes"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fulfilment_attempts" ADD CONSTRAINT "fulfilment_attempts_supplier_id_suppliers_id_fk" FOREIGN KEY ("supplier_id") REFERENCES "public"."suppliers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fulfilment_attempts" ADD CONSTRAINT "fulfilment_attempts_offer_id_supplier_offers_id_fk" FOREIGN KEY ("offer_id") REFERENCES "public"."supplier_offers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fulfilment_attempts" ADD CONSTRAINT "fulfilment_attempts_cost_journal_id_ledger_journals_id_fk" FOREIGN KEY ("cost_journal_id") REFERENCES "public"."ledger_journals"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "order_code_reveals" ADD CONSTRAINT "order_code_reveals_code_id_order_codes_id_fk" FOREIGN KEY ("code_id") REFERENCES "public"."order_codes"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "order_code_reveals" ADD CONSTRAINT "order_code_reveals_order_id_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."orders"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "order_codes" ADD CONSTRAINT "order_codes_order_id_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."orders"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "order_codes" ADD CONSTRAINT "order_codes_attempt_id_fulfilment_attempts_id_fk" FOREIGN KEY ("attempt_id") REFERENCES "public"."fulfilment_attempts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "order_events" ADD CONSTRAINT "order_events_order_id_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."orders"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "order_events" ADD CONSTRAINT "order_events_attempt_id_fulfilment_attempts_id_fk" FOREIGN KEY ("attempt_id") REFERENCES "public"."fulfilment_attempts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "orders" ADD CONSTRAINT "orders_customer_id_customers_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "orders" ADD CONSTRAINT "orders_product_id_catalog_products_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."catalog_products"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "orders" ADD CONSTRAINT "orders_game_id_catalog_games_id_fk" FOREIGN KEY ("game_id") REFERENCES "public"."catalog_games"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "orders" ADD CONSTRAINT "orders_price_id_product_prices_id_fk" FOREIGN KEY ("price_id") REFERENCES "public"."product_prices"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "orders" ADD CONSTRAINT "orders_display_rate_id_exchange_rates_id_fk" FOREIGN KEY ("display_rate_id") REFERENCES "public"."exchange_rates"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "orders" ADD CONSTRAINT "orders_purchase_journal_id_ledger_journals_id_fk" FOREIGN KEY ("purchase_journal_id") REFERENCES "public"."ledger_journals"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "orders" ADD CONSTRAINT "orders_refund_journal_id_ledger_journals_id_fk" FOREIGN KEY ("refund_journal_id") REFERENCES "public"."ledger_journals"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "supplier_webhook_events" ADD CONSTRAINT "supplier_webhook_events_supplier_id_suppliers_id_fk" FOREIGN KEY ("supplier_id") REFERENCES "public"."suppliers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "supplier_webhook_events" ADD CONSTRAINT "supplier_webhook_events_attempt_id_fulfilment_attempts_id_fk" FOREIGN KEY ("attempt_id") REFERENCES "public"."fulfilment_attempts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "fulfilment_attempts_order_id_route_id_idx" ON "fulfilment_attempts" USING btree ("order_id","route_id");--> statement-breakpoint
CREATE UNIQUE INDEX "fulfilment_attempts_open_idx" ON "fulfilment_attempts" USING btree ("order_id") WHERE "fulfilment_attempts"."status" in ('sending', 'pending', 'unknown');--> statement-breakpoint
CREATE INDEX "fulfilment_attempts_status_next_poll_at_idx" ON "fulfilment_attempts" USING btree ("status","next_poll_at");--> statement-breakpoint
CREATE INDEX "fulfilment_attempts_route_id_idx" ON "fulfilment_attempts" USING btree ("route_id");--> statement-breakpoint
CREATE INDEX "fulfilment_attempts_supplier_id_idx" ON "fulfilment_attempts" USING btree ("supplier_id");--> statement-breakpoint
CREATE INDEX "fulfilment_attempts_offer_id_idx" ON "fulfilment_attempts" USING btree ("offer_id");--> statement-breakpoint
CREATE INDEX "order_code_reveals_code_id_created_at_idx" ON "order_code_reveals" USING btree ("code_id","created_at");--> statement-breakpoint
CREATE INDEX "order_code_reveals_order_id_idx" ON "order_code_reveals" USING btree ("order_id");--> statement-breakpoint
CREATE UNIQUE INDEX "order_codes_attempt_id_position_idx" ON "order_codes" USING btree ("attempt_id","position");--> statement-breakpoint
CREATE INDEX "order_codes_order_id_idx" ON "order_codes" USING btree ("order_id");--> statement-breakpoint
CREATE INDEX "order_events_order_id_created_at_idx" ON "order_events" USING btree ("order_id","created_at");--> statement-breakpoint
CREATE INDEX "order_events_attempt_id_idx" ON "order_events" USING btree ("attempt_id");--> statement-breakpoint
CREATE INDEX "order_policy_created_at_idx" ON "order_policy" USING btree ("created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "orders_customer_id_created_at_idx" ON "orders" USING btree ("customer_id","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "orders_status_created_at_idx" ON "orders" USING btree ("status","created_at");--> statement-breakpoint
CREATE INDEX "orders_created_at_idx" ON "orders" USING btree ("created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "orders_product_id_idx" ON "orders" USING btree ("product_id");--> statement-breakpoint
CREATE INDEX "orders_game_id_idx" ON "orders" USING btree ("game_id");--> statement-breakpoint
CREATE INDEX "orders_price_id_idx" ON "orders" USING btree ("price_id");--> statement-breakpoint
CREATE INDEX "orders_display_rate_id_idx" ON "orders" USING btree ("display_rate_id");--> statement-breakpoint
CREATE INDEX "orders_delivery_stats_idx" ON "orders" USING btree ("product_id","delivered_at" DESC NULLS LAST) WHERE "orders"."status" = 'delivered' and not "orders"."is_test";--> statement-breakpoint
CREATE UNIQUE INDEX "supplier_webhook_events_supplier_id_event_id_idx" ON "supplier_webhook_events" USING btree ("supplier_id","event_id");--> statement-breakpoint
CREATE INDEX "supplier_webhook_events_attempt_id_idx" ON "supplier_webhook_events" USING btree ("attempt_id");