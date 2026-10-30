ALTER TYPE "public"."email_template" ADD VALUE 'customer_merchant_tier_reminder';--> statement-breakpoint
ALTER TYPE "public"."notification_event" ADD VALUE 'merchant_tier_reminder' BEFORE 'product_available';--> statement-breakpoint
ALTER TABLE "merchant_receipt_settings" ADD COLUMN "welcome_text" text;--> statement-breakpoint
ALTER TABLE "merchant_profiles" ADD COLUMN "celebrate_pending" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "merchant_profiles" ADD COLUMN "certificate_code" text DEFAULT order_verification_code() NOT NULL;--> statement-breakpoint
ALTER TABLE "merchant_profiles" ADD COLUMN "certificate_reissued_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "merchant_profiles" ADD CONSTRAINT "merchant_profiles_certificate_code_unique" UNIQUE("certificate_code");--> statement-breakpoint
ALTER TABLE "merchant_receipt_settings" ADD CONSTRAINT "merchant_receipt_settings_welcome_text_check" CHECK ("merchant_receipt_settings"."welcome_text" is null or char_length("merchant_receipt_settings"."welcome_text") between 2 and 60);