CREATE TYPE "public"."merchant_alert_kind" AS ENUM('price_down', 'price_up', 'back_in_stock', 'out_of_stock');--> statement-breakpoint
CREATE TYPE "public"."sale_currency" AS ENUM('usd', 'syp');--> statement-breakpoint
CREATE TYPE "public"."sale_source" AS ENUM('product', 'markup', 'manual');--> statement-breakpoint
ALTER TYPE "public"."email_template" ADD VALUE 'customer_merchant_level_changed';--> statement-breakpoint
ALTER TYPE "public"."email_template" ADD VALUE 'customer_merchant_low_balance';--> statement-breakpoint
ALTER TYPE "public"."email_template" ADD VALUE 'customer_merchant_daily_digest';--> statement-breakpoint
ALTER TYPE "public"."notification_event" ADD VALUE 'merchant_level_changed';--> statement-breakpoint
ALTER TYPE "public"."notification_event" ADD VALUE 'merchant_watch_digest';--> statement-breakpoint
ALTER TYPE "public"."notification_event" ADD VALUE 'merchant_low_balance';--> statement-breakpoint
CREATE TABLE "merchant_alert_events" (
	"id" uuid PRIMARY KEY NOT NULL,
	"customer_id" uuid NOT NULL,
	"product_id" uuid NOT NULL,
	"kind" "merchant_alert_kind" NOT NULL,
	"old_price_usd_units" bigint,
	"new_price_usd_units" bigint,
	"created_at" timestamp with time zone DEFAULT clock_timestamp() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "merchant_alert_settings" (
	"customer_id" uuid PRIMARY KEY NOT NULL,
	"low_balance_usd_units" bigint,
	"daily_email" boolean DEFAULT false NOT NULL,
	"low_balance_alerted_at" timestamp with time zone,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "merchant_alert_settings_threshold_check" CHECK ("merchant_alert_settings"."low_balance_usd_units" is null or ("merchant_alert_settings"."low_balance_usd_units" between 1000000 and 10000000000
        and "merchant_alert_settings"."low_balance_usd_units" % 10000 = 0))
);
--> statement-breakpoint
CREATE TABLE "merchant_order_sales" (
	"order_id" uuid PRIMARY KEY NOT NULL,
	"customer_id" uuid NOT NULL,
	"currency" "sale_currency" NOT NULL,
	"unit_amount_units" bigint NOT NULL,
	"rate_id" uuid,
	"unit_usd_units" bigint NOT NULL,
	"source" "sale_source" NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "merchant_order_sales_amount_check" CHECK ("merchant_order_sales"."unit_amount_units" > 0 and "merchant_order_sales"."unit_usd_units" >= 0
        and "merchant_order_sales"."unit_usd_units" % 10000 = 0
        and ("merchant_order_sales"."currency" = 'usd' or "merchant_order_sales"."rate_id" is not null)
        and ("merchant_order_sales"."currency" <> 'usd' or "merchant_order_sales"."unit_usd_units" = "merchant_order_sales"."unit_amount_units"))
);
--> statement-breakpoint
CREATE TABLE "merchant_selling_prices" (
	"customer_id" uuid NOT NULL,
	"product_id" uuid NOT NULL,
	"currency" "sale_currency" NOT NULL,
	"amount_units" bigint NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "merchant_selling_prices_customer_id_product_id_pk" PRIMARY KEY("customer_id","product_id"),
	CONSTRAINT "merchant_selling_prices_amount_check" CHECK ("merchant_selling_prices"."amount_units" > 0 and (
        ("merchant_selling_prices"."currency" = 'usd' and "merchant_selling_prices"."amount_units" % 10000 = 0 and "merchant_selling_prices"."amount_units" <= 10000000000)
        or ("merchant_selling_prices"."currency" = 'syp' and "merchant_selling_prices"."amount_units" % 100 = 0)))
);
--> statement-breakpoint
CREATE TABLE "merchant_selling_settings" (
	"customer_id" uuid PRIMARY KEY NOT NULL,
	"markup_bp" integer,
	"syp_step_units" bigint,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "merchant_selling_settings_check" CHECK (("merchant_selling_settings"."markup_bp" is null or "merchant_selling_settings"."markup_bp" between 0 and 10000)
        and ("merchant_selling_settings"."syp_step_units" is null or "merchant_selling_settings"."syp_step_units" in (500, 1000, 5000, 10000, 50000, 100000)))
);
--> statement-breakpoint
CREATE TABLE "merchant_watch_states" (
	"customer_id" uuid NOT NULL,
	"product_id" uuid NOT NULL,
	"price_usd_units" bigint,
	"available" boolean NOT NULL,
	"told_at" timestamp with time zone NOT NULL,
	CONSTRAINT "merchant_watch_states_customer_id_product_id_pk" PRIMARY KEY("customer_id","product_id")
);
--> statement-breakpoint
CREATE TABLE "merchant_watches" (
	"id" uuid PRIMARY KEY NOT NULL,
	"customer_id" uuid NOT NULL,
	"game_id" uuid,
	"product_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "merchant_watches_target_check" CHECK (("merchant_watches"."game_id" is null) <> ("merchant_watches"."product_id" is null))
);
--> statement-breakpoint
CREATE TABLE "merchant_levels" (
	"id" uuid PRIMARY KEY NOT NULL,
	"name_ar" text NOT NULL,
	"monthly_threshold_usd_units" bigint NOT NULL,
	"price_list_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"archived_at" timestamp with time zone,
	CONSTRAINT "merchant_levels_check" CHECK (char_length("merchant_levels"."name_ar") between 2 and 30
        and "merchant_levels"."monthly_threshold_usd_units" >= 1000000
        and "merchant_levels"."monthly_threshold_usd_units" % 1000000 = 0)
);
--> statement-breakpoint
ALTER TABLE "merchant_profiles" ADD COLUMN "level_id" uuid;--> statement-breakpoint
ALTER TABLE "merchant_profiles" ADD COLUMN "level_changed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "merchant_alert_events" ADD CONSTRAINT "merchant_alert_events_customer_id_customers_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "merchant_alert_events" ADD CONSTRAINT "merchant_alert_events_product_id_catalog_products_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."catalog_products"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "merchant_alert_settings" ADD CONSTRAINT "merchant_alert_settings_customer_id_customers_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "merchant_order_sales" ADD CONSTRAINT "merchant_order_sales_order_id_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."orders"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "merchant_order_sales" ADD CONSTRAINT "merchant_order_sales_customer_id_customers_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "merchant_order_sales" ADD CONSTRAINT "merchant_order_sales_rate_id_exchange_rates_id_fk" FOREIGN KEY ("rate_id") REFERENCES "public"."exchange_rates"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "merchant_selling_prices" ADD CONSTRAINT "merchant_selling_prices_customer_id_customers_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "merchant_selling_prices" ADD CONSTRAINT "merchant_selling_prices_product_id_catalog_products_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."catalog_products"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "merchant_selling_settings" ADD CONSTRAINT "merchant_selling_settings_customer_id_customers_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "merchant_watch_states" ADD CONSTRAINT "merchant_watch_states_customer_id_customers_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "merchant_watch_states" ADD CONSTRAINT "merchant_watch_states_product_id_catalog_products_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."catalog_products"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "merchant_watches" ADD CONSTRAINT "merchant_watches_customer_id_customers_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "merchant_watches" ADD CONSTRAINT "merchant_watches_game_id_catalog_games_id_fk" FOREIGN KEY ("game_id") REFERENCES "public"."catalog_games"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "merchant_watches" ADD CONSTRAINT "merchant_watches_product_id_catalog_products_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."catalog_products"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "merchant_levels" ADD CONSTRAINT "merchant_levels_price_list_id_price_lists_id_fk" FOREIGN KEY ("price_list_id") REFERENCES "public"."price_lists"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "merchant_alert_events_customer_idx" ON "merchant_alert_events" USING btree ("customer_id","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "merchant_alert_events_product_id_idx" ON "merchant_alert_events" USING btree ("product_id");--> statement-breakpoint
CREATE INDEX "merchant_alert_events_created_at_idx" ON "merchant_alert_events" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "merchant_order_sales_customer_id_idx" ON "merchant_order_sales" USING btree ("customer_id","order_id");--> statement-breakpoint
CREATE INDEX "merchant_order_sales_rate_id_idx" ON "merchant_order_sales" USING btree ("rate_id");--> statement-breakpoint
CREATE INDEX "merchant_selling_prices_product_id_idx" ON "merchant_selling_prices" USING btree ("product_id");--> statement-breakpoint
CREATE INDEX "merchant_watch_states_product_id_idx" ON "merchant_watch_states" USING btree ("product_id");--> statement-breakpoint
CREATE UNIQUE INDEX "merchant_watches_game_idx" ON "merchant_watches" USING btree ("customer_id","game_id") WHERE "merchant_watches"."game_id" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "merchant_watches_product_idx" ON "merchant_watches" USING btree ("customer_id","product_id") WHERE "merchant_watches"."product_id" is not null;--> statement-breakpoint
CREATE INDEX "merchant_watches_customer_id_idx" ON "merchant_watches" USING btree ("customer_id");--> statement-breakpoint
CREATE INDEX "merchant_watches_game_id_idx" ON "merchant_watches" USING btree ("game_id");--> statement-breakpoint
CREATE INDEX "merchant_watches_product_id_idx" ON "merchant_watches" USING btree ("product_id");--> statement-breakpoint
CREATE UNIQUE INDEX "merchant_levels_name_idx" ON "merchant_levels" USING btree ("name_ar") WHERE "merchant_levels"."archived_at" is null;--> statement-breakpoint
CREATE UNIQUE INDEX "merchant_levels_threshold_idx" ON "merchant_levels" USING btree ("monthly_threshold_usd_units") WHERE "merchant_levels"."archived_at" is null;--> statement-breakpoint
CREATE INDEX "merchant_levels_price_list_id_idx" ON "merchant_levels" USING btree ("price_list_id");--> statement-breakpoint
ALTER TABLE "merchant_profiles" ADD CONSTRAINT "merchant_profiles_level_id_merchant_levels_id_fk" FOREIGN KEY ("level_id") REFERENCES "public"."merchant_levels"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "merchant_profiles_level_id_idx" ON "merchant_profiles" USING btree ("level_id");--> statement-breakpoint
CREATE INDEX "orders_customer_id_finished_at_idx" ON "orders" USING btree ("customer_id","finished_at") WHERE "orders"."finished_at" is not null;