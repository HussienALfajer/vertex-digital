CREATE TYPE "public"."price_change_cause" AS ENUM('cost_sync', 'route_change', 'rule_change', 'review_accepted', 'margin_adjusted');--> statement-breakpoint
CREATE TYPE "public"."price_review_status" AS ENUM('open', 'accepted', 'margin_adjusted', 'paused', 'superseded');--> statement-breakpoint
CREATE TYPE "public"."supplier_call_operation" AS ENUM('list_offers', 'get_balance', 'validate_player', 'place_order', 'get_order');--> statement-breakpoint
CREATE TYPE "public"."supplier_call_result" AS ENUM('ok', 'refused', 'error');--> statement-breakpoint
CREATE TYPE "public"."supplier_code" AS ENUM('shop2topup', 'wdgzone', 'manual', 'fake');--> statement-breakpoint
CREATE TYPE "public"."supplier_health_state" AS ENUM('healthy', 'degraded', 'down');--> statement-breakpoint
CREATE TYPE "public"."sync_run_status" AS ENUM('running', 'succeeded', 'failed');--> statement-breakpoint
CREATE TYPE "public"."sync_run_trigger" AS ENUM('schedule', 'admin');--> statement-breakpoint
ALTER TYPE "public"."store_switch" ADD VALUE 'shop2topup_paused';--> statement-breakpoint
ALTER TYPE "public"."store_switch" ADD VALUE 'wdgzone_paused';--> statement-breakpoint
ALTER TYPE "public"."store_switch" ADD VALUE 'manual_paused';--> statement-breakpoint
ALTER TYPE "public"."store_switch" ADD VALUE 'fake_paused';--> statement-breakpoint
CREATE TABLE "price_reviews" (
	"id" uuid PRIMARY KEY NOT NULL,
	"product_id" uuid NOT NULL,
	"route_id" uuid NOT NULL,
	"cost_before_usd_units" bigint NOT NULL,
	"cost_after_usd_units" bigint NOT NULL,
	"change_bp" integer NOT NULL,
	"price_before_usd_units" bigint NOT NULL,
	"proposed_price_usd_units" bigint NOT NULL,
	"status" "price_review_status" DEFAULT 'open' NOT NULL,
	"decided_at" timestamp with time zone,
	"admin_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "price_reviews_amounts_check" CHECK ("price_reviews"."cost_before_usd_units" > 0 and "price_reviews"."cost_after_usd_units" > 0
        and "price_reviews"."price_before_usd_units" > 0 and "price_reviews"."price_before_usd_units" % 10000 = 0
        and "price_reviews"."proposed_price_usd_units" > 0 and "price_reviews"."proposed_price_usd_units" % 10000 = 0),
	CONSTRAINT "price_reviews_decided_check" CHECK (("price_reviews"."status" = 'open') = ("price_reviews"."decided_at" is null))
);
--> statement-breakpoint
CREATE TABLE "product_prices" (
	"id" uuid PRIMARY KEY NOT NULL,
	"product_id" uuid NOT NULL,
	"price_usd_units" bigint NOT NULL,
	"cost_usd_units" bigint NOT NULL,
	"route_id" uuid NOT NULL,
	"rule_id" uuid NOT NULL,
	"percent_bp" integer NOT NULL,
	"fixed_usd_units" bigint NOT NULL,
	"min_margin_usd_units" bigint NOT NULL,
	"cause" "price_change_cause" NOT NULL,
	"review_id" uuid,
	"created_at" timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
	CONSTRAINT "product_prices_price_check" CHECK ("product_prices"."price_usd_units" % 10000 = 0 and "product_prices"."cost_usd_units" > 0 and "product_prices"."price_usd_units" > "product_prices"."cost_usd_units")
);
--> statement-breakpoint
CREATE TABLE "product_routes" (
	"id" uuid PRIMARY KEY NOT NULL,
	"product_id" uuid NOT NULL,
	"supplier_id" uuid NOT NULL,
	"offer_id" uuid NOT NULL,
	"priority" integer DEFAULT 1 NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"field_map" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"archived_at" timestamp with time zone,
	CONSTRAINT "product_routes_priority_check" CHECK ("product_routes"."priority" between 1 and 9),
	CONSTRAINT "product_routes_field_map_check" CHECK (jsonb_typeof("product_routes"."field_map") = 'object')
);
--> statement-breakpoint
CREATE TABLE "supplier_balance_reads" (
	"id" uuid PRIMARY KEY NOT NULL,
	"supplier_id" uuid NOT NULL,
	"currency" "currency" NOT NULL,
	"amount_units" bigint NOT NULL,
	"created_at" timestamp with time zone DEFAULT clock_timestamp() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "supplier_calls" (
	"id" uuid PRIMARY KEY NOT NULL,
	"supplier_id" uuid NOT NULL,
	"operation" "supplier_call_operation" NOT NULL,
	"result" "supplier_call_result" NOT NULL,
	"latency_ms" integer NOT NULL,
	"supplier_code" text,
	"created_at" timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
	CONSTRAINT "supplier_calls_latency_check" CHECK ("supplier_calls"."latency_ms" >= 0),
	CONSTRAINT "supplier_calls_supplier_code_check" CHECK (char_length("supplier_calls"."supplier_code") <= 64)
);
--> statement-breakpoint
CREATE TABLE "supplier_cost_changes" (
	"id" uuid PRIMARY KEY NOT NULL,
	"offer_id" uuid NOT NULL,
	"from_usd_units" bigint,
	"to_usd_units" bigint,
	"sync_run_id" uuid,
	"admin_id" uuid,
	"created_at" timestamp with time zone DEFAULT clock_timestamp() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "supplier_credentials" (
	"id" uuid PRIMARY KEY NOT NULL,
	"supplier_id" uuid NOT NULL,
	"ciphertext" "bytea" NOT NULL,
	"hints" jsonb NOT NULL,
	"admin_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT clock_timestamp() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "supplier_health_changes" (
	"id" uuid PRIMARY KEY NOT NULL,
	"supplier_id" uuid NOT NULL,
	"state" "supplier_health_state" NOT NULL,
	"reason" text NOT NULL,
	"calls" integer,
	"success_bp" integer,
	"p90_ms" integer,
	"created_at" timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
	CONSTRAINT "supplier_health_changes_reason_check" CHECK (char_length("supplier_health_changes"."reason") between 1 and 200)
);
--> statement-breakpoint
CREATE TABLE "supplier_offers" (
	"id" uuid PRIMARY KEY NOT NULL,
	"supplier_id" uuid NOT NULL,
	"offer_id" text NOT NULL,
	"name" text NOT NULL,
	"group_name" text,
	"kind" "product_kind",
	"required_fields" text[],
	"cost_usd_units" bigint,
	"cost_raw" text,
	"in_stock" boolean NOT NULL,
	"cost_confirmed_at" timestamp with time zone,
	"last_seen_at" timestamp with time zone NOT NULL,
	"missing_since" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "supplier_offers_offer_id_check" CHECK (char_length("supplier_offers"."offer_id") between 1 and 128),
	CONSTRAINT "supplier_offers_name_check" CHECK (char_length("supplier_offers"."name") between 1 and 200),
	CONSTRAINT "supplier_offers_group_name_check" CHECK (char_length("supplier_offers"."group_name") between 1 and 200),
	CONSTRAINT "supplier_offers_cost_raw_check" CHECK (char_length("supplier_offers"."cost_raw") <= 64),
	CONSTRAINT "supplier_offers_cost_check" CHECK ("supplier_offers"."cost_usd_units" between 1 and 10000000000)
);
--> statement-breakpoint
CREATE TABLE "supplier_policy" (
	"id" uuid PRIMARY KEY NOT NULL,
	"price_review_threshold_bp" integer NOT NULL,
	"cost_stale_minutes" integer NOT NULL,
	"health_window_minutes" integer NOT NULL,
	"health_min_calls" integer NOT NULL,
	"degraded_success_bp" integer NOT NULL,
	"degraded_p90_ms" integer NOT NULL,
	"down_success_bp" integer NOT NULL,
	"down_consecutive_errors" integer NOT NULL,
	"probe_after_minutes" integer NOT NULL,
	"admin_id" uuid,
	"created_at" timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
	CONSTRAINT "supplier_policy_bounds_check" CHECK ("supplier_policy"."price_review_threshold_bp" between 100 and 5000
        and "supplier_policy"."cost_stale_minutes" between 30 and 1440
        and "supplier_policy"."health_window_minutes" between 5 and 240
        and "supplier_policy"."health_min_calls" between 1 and 100
        and "supplier_policy"."degraded_success_bp" between 1 and 10000
        and "supplier_policy"."degraded_p90_ms" between 1000 and 120000
        and "supplier_policy"."down_success_bp" between 0 and 9999
        and "supplier_policy"."down_success_bp" < "supplier_policy"."degraded_success_bp"
        and "supplier_policy"."down_consecutive_errors" between 1 and 20
        and "supplier_policy"."probe_after_minutes" between 1 and 120)
);
--> statement-breakpoint
CREATE TABLE "supplier_sync_runs" (
	"id" uuid PRIMARY KEY NOT NULL,
	"supplier_id" uuid NOT NULL,
	"trigger" "sync_run_trigger" NOT NULL,
	"status" "sync_run_status" DEFAULT 'running' NOT NULL,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone,
	"offers_seen" integer DEFAULT 0 NOT NULL,
	"offers_new" integer DEFAULT 0 NOT NULL,
	"costs_changed" integer DEFAULT 0 NOT NULL,
	"offers_missing" integer DEFAULT 0 NOT NULL,
	"reviews_opened" integer DEFAULT 0 NOT NULL,
	"products_repriced" integer DEFAULT 0 NOT NULL,
	"error_code" text,
	"error_message" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "supplier_sync_runs_finished_check" CHECK (("supplier_sync_runs"."status" = 'running') = ("supplier_sync_runs"."finished_at" is null)),
	CONSTRAINT "supplier_sync_runs_error_code_check" CHECK (char_length("supplier_sync_runs"."error_code") <= 64),
	CONSTRAINT "supplier_sync_runs_error_message_check" CHECK (char_length("supplier_sync_runs"."error_message") <= 500)
);
--> statement-breakpoint
CREATE TABLE "suppliers" (
	"id" uuid PRIMARY KEY NOT NULL,
	"code" "supplier_code" NOT NULL,
	"name_ar" text NOT NULL,
	"low_balance_usd_units" bigint DEFAULT 50000000 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "suppliers_code_unique" UNIQUE("code"),
	CONSTRAINT "suppliers_name_ar_check" CHECK (char_length("suppliers"."name_ar") between 1 and 40),
	CONSTRAINT "suppliers_low_balance_check" CHECK ("suppliers"."low_balance_usd_units" between 0 and 100000000000 and "suppliers"."low_balance_usd_units" % 10000 = 0)
);
--> statement-breakpoint
ALTER TABLE "price_reviews" ADD CONSTRAINT "price_reviews_product_id_catalog_products_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."catalog_products"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "price_reviews" ADD CONSTRAINT "price_reviews_route_id_product_routes_id_fk" FOREIGN KEY ("route_id") REFERENCES "public"."product_routes"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "product_prices" ADD CONSTRAINT "product_prices_product_id_catalog_products_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."catalog_products"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "product_prices" ADD CONSTRAINT "product_prices_route_id_product_routes_id_fk" FOREIGN KEY ("route_id") REFERENCES "public"."product_routes"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "product_prices" ADD CONSTRAINT "product_prices_rule_id_margin_rules_id_fk" FOREIGN KEY ("rule_id") REFERENCES "public"."margin_rules"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "product_prices" ADD CONSTRAINT "product_prices_review_id_price_reviews_id_fk" FOREIGN KEY ("review_id") REFERENCES "public"."price_reviews"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "product_routes" ADD CONSTRAINT "product_routes_product_id_catalog_products_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."catalog_products"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "product_routes" ADD CONSTRAINT "product_routes_supplier_id_suppliers_id_fk" FOREIGN KEY ("supplier_id") REFERENCES "public"."suppliers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "product_routes" ADD CONSTRAINT "product_routes_offer_id_supplier_offers_id_fk" FOREIGN KEY ("offer_id") REFERENCES "public"."supplier_offers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "supplier_balance_reads" ADD CONSTRAINT "supplier_balance_reads_supplier_id_suppliers_id_fk" FOREIGN KEY ("supplier_id") REFERENCES "public"."suppliers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "supplier_calls" ADD CONSTRAINT "supplier_calls_supplier_id_suppliers_id_fk" FOREIGN KEY ("supplier_id") REFERENCES "public"."suppliers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "supplier_cost_changes" ADD CONSTRAINT "supplier_cost_changes_offer_id_supplier_offers_id_fk" FOREIGN KEY ("offer_id") REFERENCES "public"."supplier_offers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "supplier_cost_changes" ADD CONSTRAINT "supplier_cost_changes_sync_run_id_supplier_sync_runs_id_fk" FOREIGN KEY ("sync_run_id") REFERENCES "public"."supplier_sync_runs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "supplier_credentials" ADD CONSTRAINT "supplier_credentials_supplier_id_suppliers_id_fk" FOREIGN KEY ("supplier_id") REFERENCES "public"."suppliers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "supplier_health_changes" ADD CONSTRAINT "supplier_health_changes_supplier_id_suppliers_id_fk" FOREIGN KEY ("supplier_id") REFERENCES "public"."suppliers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "supplier_offers" ADD CONSTRAINT "supplier_offers_supplier_id_suppliers_id_fk" FOREIGN KEY ("supplier_id") REFERENCES "public"."suppliers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "supplier_sync_runs" ADD CONSTRAINT "supplier_sync_runs_supplier_id_suppliers_id_fk" FOREIGN KEY ("supplier_id") REFERENCES "public"."suppliers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "price_reviews_open_idx" ON "price_reviews" USING btree ("product_id") WHERE "price_reviews"."status" = 'open';--> statement-breakpoint
CREATE INDEX "price_reviews_product_id_idx" ON "price_reviews" USING btree ("product_id");--> statement-breakpoint
CREATE INDEX "price_reviews_route_id_idx" ON "price_reviews" USING btree ("route_id");--> statement-breakpoint
CREATE INDEX "price_reviews_status_created_at_idx" ON "price_reviews" USING btree ("status","created_at");--> statement-breakpoint
CREATE INDEX "product_prices_product_id_created_at_idx" ON "product_prices" USING btree ("product_id","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "product_prices_route_id_idx" ON "product_prices" USING btree ("route_id");--> statement-breakpoint
CREATE INDEX "product_prices_rule_id_idx" ON "product_prices" USING btree ("rule_id");--> statement-breakpoint
CREATE INDEX "product_prices_review_id_idx" ON "product_prices" USING btree ("review_id");--> statement-breakpoint
CREATE UNIQUE INDEX "product_routes_product_id_supplier_id_live_idx" ON "product_routes" USING btree ("product_id","supplier_id") WHERE "product_routes"."archived_at" is null;--> statement-breakpoint
CREATE UNIQUE INDEX "product_routes_offer_id_live_idx" ON "product_routes" USING btree ("offer_id") WHERE "product_routes"."archived_at" is null;--> statement-breakpoint
CREATE INDEX "product_routes_offer_id_idx" ON "product_routes" USING btree ("offer_id");--> statement-breakpoint
CREATE INDEX "product_routes_supplier_id_idx" ON "product_routes" USING btree ("supplier_id");--> statement-breakpoint
CREATE INDEX "supplier_balance_reads_supplier_id_created_at_idx" ON "supplier_balance_reads" USING btree ("supplier_id","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "supplier_calls_supplier_id_created_at_idx" ON "supplier_calls" USING btree ("supplier_id","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "supplier_cost_changes_offer_id_created_at_idx" ON "supplier_cost_changes" USING btree ("offer_id","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "supplier_cost_changes_sync_run_id_idx" ON "supplier_cost_changes" USING btree ("sync_run_id");--> statement-breakpoint
CREATE INDEX "supplier_credentials_supplier_id_created_at_idx" ON "supplier_credentials" USING btree ("supplier_id","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "supplier_health_changes_supplier_id_created_at_idx" ON "supplier_health_changes" USING btree ("supplier_id","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE UNIQUE INDEX "supplier_offers_supplier_id_offer_id_idx" ON "supplier_offers" USING btree ("supplier_id","offer_id");--> statement-breakpoint
CREATE INDEX "supplier_offers_supplier_id_group_name_idx" ON "supplier_offers" USING btree ("supplier_id","group_name");--> statement-breakpoint
CREATE INDEX "supplier_offers_supplier_id_missing_since_idx" ON "supplier_offers" USING btree ("supplier_id","missing_since");--> statement-breakpoint
CREATE INDEX "supplier_policy_created_at_idx" ON "supplier_policy" USING btree ("created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE UNIQUE INDEX "supplier_sync_runs_running_idx" ON "supplier_sync_runs" USING btree ("supplier_id") WHERE "supplier_sync_runs"."status" = 'running';--> statement-breakpoint
CREATE INDEX "supplier_sync_runs_supplier_id_started_at_idx" ON "supplier_sync_runs" USING btree ("supplier_id","started_at" DESC NULLS LAST);