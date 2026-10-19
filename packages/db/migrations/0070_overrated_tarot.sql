ALTER TYPE "public"."webhook_event_result" ADD VALUE 'ignored';--> statement-breakpoint
ALTER TYPE "public"."telegram_message_kind" ADD VALUE 'supplier_subscription';--> statement-breakpoint
ALTER TABLE "supplier_offers" DROP CONSTRAINT "supplier_offers_unsupported_reason_check";--> statement-breakpoint
ALTER TABLE "supplier_categories" ADD COLUMN "note" text;--> statement-breakpoint
ALTER TABLE "supplier_categories" ADD COLUMN "offers_read_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "suppliers" ADD COLUMN "account_plan" text;--> statement-breakpoint
ALTER TABLE "suppliers" ADD COLUMN "account_plan_expires_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "suppliers" ADD COLUMN "account_active" boolean;--> statement-breakpoint
ALTER TABLE "suppliers" ADD COLUMN "account_auto_renew" boolean;--> statement-breakpoint
ALTER TABLE "suppliers" ADD COLUMN "account_checked_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "suppliers" ADD COLUMN "plan_expiry_alerted_for" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "supplier_categories" ADD CONSTRAINT "supplier_categories_note_check" CHECK (char_length("supplier_categories"."note") between 1 and 1000);--> statement-breakpoint
ALTER TABLE "supplier_offers" ADD CONSTRAINT "supplier_offers_unsupported_reason_check" CHECK ("supplier_offers"."unsupported_reason" in ('fields_unsupported', 'manual_delivery'));--> statement-breakpoint
ALTER TABLE "suppliers" ADD CONSTRAINT "suppliers_account_plan_check" CHECK (char_length("suppliers"."account_plan") between 1 and 32);--> statement-breakpoint
ALTER TABLE "suppliers" ADD CONSTRAINT "suppliers_account_checked_check" CHECK (("suppliers"."account_plan" is null) = ("suppliers"."account_checked_at" is null) and ("suppliers"."account_plan" is null) = ("suppliers"."account_active" is null));