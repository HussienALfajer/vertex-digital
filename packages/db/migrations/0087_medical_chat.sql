CREATE TYPE "public"."checkout_source" AS ENUM('cart', 'bulk');--> statement-breakpoint
CREATE TYPE "public"."code_release_purpose" AS ENUM('reveal', 'print', 'copy', 'export');--> statement-breakpoint
ALTER TYPE "public"."stored_file_kind" ADD VALUE 'merchant_logo';--> statement-breakpoint
CREATE TABLE "merchant_receipt_settings" (
	"customer_id" uuid PRIMARY KEY NOT NULL,
	"show_whatsapp" boolean DEFAULT false NOT NULL,
	"whatsapp" text,
	"logo_file_id" uuid,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "merchant_receipt_settings_whatsapp_check" CHECK (("merchant_receipt_settings"."whatsapp" is null or "merchant_receipt_settings"."whatsapp" ~ '^[+][1-9][0-9]{6,14}$')
        and (not "merchant_receipt_settings"."show_whatsapp" or "merchant_receipt_settings"."whatsapp" is not null))
);
--> statement-breakpoint
ALTER TABLE "merchant_settings" DROP CONSTRAINT "merchant_settings_bounds_check";--> statement-breakpoint
ALTER TABLE "checkouts" DROP CONSTRAINT "checkouts_line_count_check";--> statement-breakpoint
ALTER TABLE "orders" DROP CONSTRAINT "orders_checkout_check";--> statement-breakpoint
ALTER TABLE "merchant_settings" ADD COLUMN "player_checks_per_hour" integer DEFAULT 100 NOT NULL;--> statement-breakpoint
ALTER TABLE "merchant_settings" ADD COLUMN "player_checks_per_day" integer DEFAULT 300 NOT NULL;--> statement-breakpoint
ALTER TABLE "checkouts" ADD COLUMN "source" "checkout_source" DEFAULT 'cart' NOT NULL;--> statement-breakpoint
ALTER TABLE "order_code_reveals" ADD COLUMN "purpose" "code_release_purpose" DEFAULT 'reveal' NOT NULL;--> statement-breakpoint
ALTER TABLE "order_code_reveals" ADD COLUMN "release_id" uuid;--> statement-breakpoint
ALTER TABLE "order_share_links" ADD COLUMN "branded" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "orders" ADD COLUMN "verification_code" text DEFAULT order_verification_code() NOT NULL;--> statement-breakpoint
ALTER TABLE "merchant_receipt_settings" ADD CONSTRAINT "merchant_receipt_settings_customer_id_customers_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "merchant_receipt_settings" ADD CONSTRAINT "merchant_receipt_settings_logo_file_id_stored_files_id_fk" FOREIGN KEY ("logo_file_id") REFERENCES "public"."stored_files"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "merchant_receipt_settings_logo_file_id_idx" ON "merchant_receipt_settings" USING btree ("logo_file_id");--> statement-breakpoint
ALTER TABLE "orders" ADD CONSTRAINT "orders_verification_code_unique" UNIQUE("verification_code");--> statement-breakpoint
ALTER TABLE "merchant_settings" ADD CONSTRAINT "merchant_settings_bounds_check" CHECK ("merchant_settings"."per_deposit_usd_units" > 0 and "merchant_settings"."per_deposit_usd_units" % 10000 = 0
        and "merchant_settings"."daily_deposit_usd_units" > 0 and "merchant_settings"."daily_deposit_usd_units" % 10000 = 0
        and "merchant_settings"."daily_deposit_usd_units" <= 100000000000
        and "merchant_settings"."per_deposit_usd_units" <= "merchant_settings"."daily_deposit_usd_units"
        and "merchant_settings"."orders_per_ten_minutes" between 10 and 500
        and "merchant_settings"."reapply_wait_days" between 0 and 365
        and "merchant_settings"."info_expiry_days" between 1 and 60
        and "merchant_settings"."player_checks_per_hour" between 10 and 1000
        and "merchant_settings"."player_checks_per_day" between 30 and 5000);--> statement-breakpoint
ALTER TABLE "checkouts" ADD CONSTRAINT "checkouts_line_count_check" CHECK ("checkouts"."line_count" between 1 and 50);--> statement-breakpoint
ALTER TABLE "orders" ADD CONSTRAINT "orders_checkout_check" CHECK (("orders"."checkout_id" is null) = ("orders"."checkout_line" is null)
        and "orders"."checkout_line" between 1 and 50
        and ("orders"."checkout_id" is null or "orders"."reserved_at" is null));