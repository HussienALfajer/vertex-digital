CREATE TYPE "public"."admin_order_purpose" AS ENUM('walk_in', 'on_behalf', 'gift', 'compensation');--> statement-breakpoint
CREATE TYPE "public"."order_payer" AS ENUM('customer', 'owner');--> statement-breakpoint
CREATE TYPE "public"."order_placer" AS ENUM('customer', 'admin');--> statement-breakpoint
ALTER TYPE "public"."email_template" ADD VALUE 'customer_order_placed_for_you';--> statement-breakpoint
ALTER TYPE "public"."notification_event" ADD VALUE 'order_placed_for_you';--> statement-breakpoint
ALTER TYPE "public"."telegram_message_kind" ADD VALUE 'admin_order_placed';--> statement-breakpoint
ALTER TYPE "public"."ledger_account_kind" ADD VALUE 'owner_drawings';--> statement-breakpoint
ALTER TABLE "order_policy" DROP CONSTRAINT "order_policy_bounds_check";--> statement-breakpoint
ALTER TABLE "orders" ALTER COLUMN "customer_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "player_checks" ALTER COLUMN "customer_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "order_policy" ADD COLUMN "owner_daily_cap_usd_units" bigint DEFAULT 100000000 NOT NULL;--> statement-breakpoint
ALTER TABLE "orders" ADD COLUMN "placed_by" "order_placer" DEFAULT 'customer' NOT NULL;--> statement-breakpoint
ALTER TABLE "orders" ADD COLUMN "payer" "order_payer" DEFAULT 'customer' NOT NULL;--> statement-breakpoint
ALTER TABLE "orders" ADD COLUMN "admin_purpose" "admin_order_purpose";--> statement-breakpoint
ALTER TABLE "orders" ADD COLUMN "admin_id" uuid;--> statement-breakpoint
ALTER TABLE "orders" ADD COLUMN "admin_reason" text;--> statement-breakpoint
ALTER TABLE "orders" ADD COLUMN "customer_note" text;--> statement-breakpoint
ALTER TABLE "player_checks" ADD COLUMN "admin_id" uuid;--> statement-breakpoint
CREATE INDEX "orders_owner_paid_at_idx" ON "orders" USING btree ("payer","paid_at") WHERE "orders"."payer" = 'owner';--> statement-breakpoint
CREATE INDEX "orders_admin_created_at_idx" ON "orders" USING btree ("placed_by","created_at" DESC NULLS LAST) WHERE "orders"."placed_by" = 'admin';--> statement-breakpoint
ALTER TABLE "order_policy" ADD CONSTRAINT "order_policy_bounds_check" CHECK ("order_policy"."first_poll_seconds" between 15 and 600
        and "order_policy"."fast_poll_seconds" between 15 and 600
        and "order_policy"."fast_poll_minutes" between 1 and 60
        and "order_policy"."slow_poll_seconds" between 60 and 3600
        and "order_policy"."hard_limit_minutes" between 5 and 240
        and "order_policy"."review_poll_minutes" between 5 and 240
        and "order_policy"."review_poll_hours" between 1 and 72
        and "order_policy"."manual_reminder_minutes" between 5 and 240
        and "order_policy"."owner_daily_cap_usd_units" between 0 and 10000000000
        and "order_policy"."owner_daily_cap_usd_units" % 10000 = 0);--> statement-breakpoint
ALTER TABLE "orders" ADD CONSTRAINT "orders_admin_check" CHECK (("orders"."placed_by" = 'admin') = ("orders"."admin_purpose" is not null)
        and ("orders"."placed_by" = 'admin') = ("orders"."admin_id" is not null)
        and ("orders"."placed_by" = 'admin') = ("orders"."admin_reason" is not null)
        and ("orders"."customer_id" is null) = coalesce("orders"."admin_purpose" = 'walk_in', false)
        and ("orders"."payer" = 'owner')
          = coalesce("orders"."admin_purpose" in ('walk_in', 'gift', 'compensation'), false)
        and ("orders"."customer_note" is null or "orders"."admin_purpose" in ('gift', 'compensation'))
        and ("orders"."placed_by" = 'customer'
          or ("orders"."checkout_id" is null and "orders"."reserved_at" is null and not "orders"."is_gift"))
        and ("orders"."customer_id" is not null or not "orders"."is_test")
        and char_length("orders"."admin_reason") between 5 and 500
        and char_length("orders"."customer_note") between 1 and 300);--> statement-breakpoint
ALTER TABLE "player_checks" ADD CONSTRAINT "player_checks_requester_check" CHECK (("player_checks"."customer_id" is null) <> ("player_checks"."admin_id" is null));