CREATE TYPE "public"."merchant_level_source" AS ENUM('earned', 'granted');--> statement-breakpoint
CREATE TYPE "public"."merchant_tier_change_source" AS ENUM('earned', 'granted', 'grant_ended', 'revoked', 'tiers_changed');--> statement-breakpoint
CREATE TYPE "public"."merchant_tier" AS ENUM('bronze', 'silver', 'gold', 'diamond');--> statement-breakpoint
CREATE TYPE "public"."merchant_tier_grant_end_reason" AS ENUM('expired', 'ended_by_admin', 'merchant_revoked', 'tier_archived');--> statement-breakpoint
ALTER TYPE "public"."price_source" ADD VALUE 'parent_cap';--> statement-breakpoint
ALTER TYPE "public"."telegram_message_kind" ADD VALUE 'merchant_tier_changed';--> statement-breakpoint
ALTER TYPE "public"."telegram_message_kind" ADD VALUE 'merchant_tier_grant_ending';--> statement-breakpoint
CREATE TABLE "merchant_tier_changes" (
	"id" uuid PRIMARY KEY NOT NULL,
	"customer_id" uuid NOT NULL,
	"from_tier" "merchant_tier" NOT NULL,
	"to_tier" "merchant_tier" NOT NULL,
	"source" "merchant_tier_change_source" NOT NULL,
	"created_at" timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
	CONSTRAINT "merchant_tier_changes_check" CHECK ("merchant_tier_changes"."from_tier" <> "merchant_tier_changes"."to_tier")
);
--> statement-breakpoint
CREATE TABLE "merchant_tier_grants" (
	"id" uuid PRIMARY KEY NOT NULL,
	"customer_id" uuid NOT NULL,
	"tier" "merchant_tier" NOT NULL,
	"starts_at" timestamp with time zone NOT NULL,
	"ends_at" timestamp with time zone NOT NULL,
	"reason" text NOT NULL,
	"admin_id" uuid NOT NULL,
	"ended_at" timestamp with time zone,
	"end_reason" "merchant_tier_grant_end_reason",
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "merchant_tier_grants_check" CHECK ("merchant_tier_grants"."tier" <> 'bronze'
        and "merchant_tier_grants"."ends_at" > "merchant_tier_grants"."starts_at"
        and "merchant_tier_grants"."ends_at" <= "merchant_tier_grants"."starts_at" + interval '91 days'
        and char_length("merchant_tier_grants"."reason") between 5 and 500
        and ("merchant_tier_grants"."ended_at" is null) = ("merchant_tier_grants"."end_reason" is null))
);
--> statement-breakpoint
CREATE TABLE "merchant_tier_months" (
	"customer_id" uuid NOT NULL,
	"month" date NOT NULL,
	"net_purchases_usd_units" bigint NOT NULL,
	"earned_tier" "merchant_tier" NOT NULL,
	"held_tier" "merchant_tier" NOT NULL,
	"held_source" "merchant_level_source" NOT NULL,
	"created_at" timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
	CONSTRAINT "merchant_tier_months_customer_id_month_pk" PRIMARY KEY("customer_id","month"),
	CONSTRAINT "merchant_tier_months_check" CHECK (extract(day from "merchant_tier_months"."month") = 1)
);
--> statement-breakpoint
CREATE TABLE "merchant_tier_settings" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tier" "merchant_tier" NOT NULL,
	"per_deposit_usd_units" bigint NOT NULL,
	"daily_deposit_usd_units" bigint NOT NULL,
	"player_checks_per_hour" integer NOT NULL,
	"player_checks_per_day" integer NOT NULL,
	"bulk_lines_max" integer NOT NULL,
	"order_units_max" integer NOT NULL,
	"deposit_priority" boolean NOT NULL,
	"support_priority" boolean NOT NULL,
	"support_reply_minutes" integer,
	"direct_contact" boolean NOT NULL,
	"early_access" boolean NOT NULL,
	"fast_alerts" boolean NOT NULL,
	"receipt_welcome" boolean NOT NULL,
	"receipt_large_logo" boolean NOT NULL,
	"admin_id" uuid,
	"created_at" timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
	CONSTRAINT "merchant_tier_settings_bounds_check" CHECK ("merchant_tier_settings"."per_deposit_usd_units" > 0 and "merchant_tier_settings"."per_deposit_usd_units" % 10000 = 0
        and "merchant_tier_settings"."daily_deposit_usd_units" > 0 and "merchant_tier_settings"."daily_deposit_usd_units" % 10000 = 0
        and "merchant_tier_settings"."daily_deposit_usd_units" <= 100000000000
        and "merchant_tier_settings"."per_deposit_usd_units" <= "merchant_tier_settings"."daily_deposit_usd_units"
        and "merchant_tier_settings"."player_checks_per_hour" between 10 and 1000
        and "merchant_tier_settings"."player_checks_per_day" between 30 and 5000
        and "merchant_tier_settings"."player_checks_per_hour" <= "merchant_tier_settings"."player_checks_per_day"
        and "merchant_tier_settings"."bulk_lines_max" between 10 and 100
        and "merchant_tier_settings"."order_units_max" between 1 and 100
        and ("merchant_tier_settings"."support_reply_minutes" is null or "merchant_tier_settings"."support_reply_minutes" between 15 and 1440))
);
--> statement-breakpoint
ALTER TABLE "checkouts" DROP CONSTRAINT "checkouts_line_count_check";--> statement-breakpoint
ALTER TABLE "fulfilment_attempts" DROP CONSTRAINT "fulfilment_attempts_quantity_check";--> statement-breakpoint
ALTER TABLE "order_codes" DROP CONSTRAINT "order_codes_position_check";--> statement-breakpoint
ALTER TABLE "orders" DROP CONSTRAINT "orders_quantity_check";--> statement-breakpoint
ALTER TABLE "orders" DROP CONSTRAINT "orders_checkout_check";--> statement-breakpoint
ALTER TABLE "merchant_levels" ADD COLUMN "tier" "merchant_tier";--> statement-breakpoint
ALTER TABLE "merchant_profiles" ADD COLUMN "earned_level_id" uuid;--> statement-breakpoint
ALTER TABLE "merchant_profiles" ADD COLUMN "level_source" "merchant_level_source";--> statement-breakpoint
ALTER TABLE "merchant_tier_changes" ADD CONSTRAINT "merchant_tier_changes_customer_id_customers_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "merchant_tier_grants" ADD CONSTRAINT "merchant_tier_grants_customer_id_customers_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "merchant_tier_months" ADD CONSTRAINT "merchant_tier_months_customer_id_customers_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "merchant_tier_changes_created_at_idx" ON "merchant_tier_changes" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "merchant_tier_changes_customer_idx" ON "merchant_tier_changes" USING btree ("customer_id","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE UNIQUE INDEX "merchant_tier_grants_open_idx" ON "merchant_tier_grants" USING btree ("customer_id") WHERE "merchant_tier_grants"."ended_at" is null;--> statement-breakpoint
CREATE INDEX "merchant_tier_grants_customer_idx" ON "merchant_tier_grants" USING btree ("customer_id","starts_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "merchant_tier_grants_end_idx" ON "merchant_tier_grants" USING btree ("ended_at","ends_at");--> statement-breakpoint
CREATE INDEX "merchant_tier_grants_admin_id_idx" ON "merchant_tier_grants" USING btree ("admin_id");--> statement-breakpoint
CREATE INDEX "merchant_tier_settings_tier_idx" ON "merchant_tier_settings" USING btree ("tier","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "merchant_tier_settings_admin_id_idx" ON "merchant_tier_settings" USING btree ("admin_id");--> statement-breakpoint
ALTER TABLE "merchant_profiles" ADD CONSTRAINT "merchant_profiles_earned_level_id_merchant_levels_id_fk" FOREIGN KEY ("earned_level_id") REFERENCES "public"."merchant_levels"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "merchant_levels_tier_idx" ON "merchant_levels" USING btree ("tier") WHERE "merchant_levels"."archived_at" is null;--> statement-breakpoint
CREATE INDEX "merchant_profiles_earned_level_id_idx" ON "merchant_profiles" USING btree ("earned_level_id");--> statement-breakpoint
ALTER TABLE "checkouts" ADD CONSTRAINT "checkouts_line_count_check" CHECK ("checkouts"."line_count" between 1 and 100);--> statement-breakpoint
ALTER TABLE "fulfilment_attempts" ADD CONSTRAINT "fulfilment_attempts_quantity_check" CHECK ("fulfilment_attempts"."quantity" between 1 and 100);--> statement-breakpoint
ALTER TABLE "order_codes" ADD CONSTRAINT "order_codes_position_check" CHECK ("order_codes"."position" between 1 and 100);--> statement-breakpoint
ALTER TABLE "orders" ADD CONSTRAINT "orders_quantity_check" CHECK ("orders"."quantity" between 1 and 100);--> statement-breakpoint
ALTER TABLE "orders" ADD CONSTRAINT "orders_checkout_check" CHECK (("orders"."checkout_id" is null) = ("orders"."checkout_line" is null)
        and "orders"."checkout_line" between 1 and 100
        and ("orders"."checkout_id" is null or "orders"."reserved_at" is null));
