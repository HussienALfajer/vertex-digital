ALTER TYPE "public"."notification_event" ADD VALUE 'merchant_early_access' BEFORE 'product_available';--> statement-breakpoint
ALTER TYPE "public"."telegram_message_kind" ADD VALUE 'ticket_overdue';--> statement-breakpoint
ALTER TABLE "catalog_games" ADD COLUMN "early_access_until" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "catalog_products" ADD COLUMN "early_access_until" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "merchant_settings" ADD COLUMN "direct_contact_whatsapp" text;--> statement-breakpoint
ALTER TABLE "merchant_settings" ADD COLUMN "direct_contact_telegram" text;--> statement-breakpoint
CREATE INDEX "catalog_games_early_access_until_idx" ON "catalog_games" USING btree ("early_access_until") WHERE "catalog_games"."early_access_until" is not null;--> statement-breakpoint
CREATE INDEX "catalog_products_early_access_until_idx" ON "catalog_products" USING btree ("early_access_until") WHERE "catalog_products"."early_access_until" is not null;--> statement-breakpoint
ALTER TABLE "merchant_settings" ADD CONSTRAINT "merchant_settings_direct_contact_check" CHECK ("merchant_settings"."direct_contact_whatsapp" ~ '^[+][1-9][0-9]{6,14}$'
        and "merchant_settings"."direct_contact_telegram" ~ '^[A-Za-z0-9_]{5,32}$');