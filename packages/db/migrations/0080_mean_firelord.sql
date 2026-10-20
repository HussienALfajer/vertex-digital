CREATE TYPE "public"."governorate" AS ENUM('damascus', 'rif_dimashq', 'aleppo', 'homs', 'hama', 'latakia', 'tartus', 'idlib', 'deir_ez_zor', 'raqqa', 'hasakah', 'daraa', 'as_suwayda', 'quneitra', 'outside_syria');--> statement-breakpoint
CREATE TYPE "public"."heard_from" AS ENUM('friend_or_shop', 'facebook', 'instagram', 'telegram', 'whatsapp', 'search', 'other');--> statement-breakpoint
CREATE TYPE "public"."merchant_activity" AS ENUM('phone_shop', 'gaming_lounge', 'services_shop', 'wholesale_distributor', 'online_store', 'other');--> statement-breakpoint
CREATE TYPE "public"."merchant_application_event" AS ENUM('submitted', 'info_requested', 'resubmitted', 'approved', 'rejected', 'expired', 'withdrawn');--> statement-breakpoint
CREATE TYPE "public"."merchant_application_status" AS ENUM('under_review', 'info_requested', 'approved', 'rejected', 'expired', 'withdrawn');--> statement-breakpoint
CREATE TYPE "public"."monthly_volume" AS ENUM('under_200', '200_500', '500_2000', '2000_5000', 'over_5000');--> statement-breakpoint
CREATE TYPE "public"."product_interest" AS ENUM('game_topups', 'gift_cards', 'chat_apps');--> statement-breakpoint
CREATE TYPE "public"."sales_channel" AS ENUM('shop_counter', 'whatsapp_telegram', 'social_pages', 'online_store');--> statement-breakpoint
CREATE TYPE "public"."years_in_business" AS ENUM('under_1', '1_3', 'over_3');--> statement-breakpoint
ALTER TYPE "public"."content_page" ADD VALUE 'merchant_terms';--> statement-breakpoint
ALTER TYPE "public"."stored_file_kind" ADD VALUE 'merchant_shop_photo';--> statement-breakpoint
ALTER TYPE "public"."email_template" ADD VALUE 'customer_merchant_info_requested';--> statement-breakpoint
ALTER TYPE "public"."email_template" ADD VALUE 'customer_merchant_approved';--> statement-breakpoint
ALTER TYPE "public"."email_template" ADD VALUE 'customer_merchant_rejected';--> statement-breakpoint
ALTER TYPE "public"."email_template" ADD VALUE 'customer_merchant_revoked';--> statement-breakpoint
ALTER TYPE "public"."notification_event" ADD VALUE 'merchant_info_requested';--> statement-breakpoint
ALTER TYPE "public"."notification_event" ADD VALUE 'merchant_approved';--> statement-breakpoint
ALTER TYPE "public"."notification_event" ADD VALUE 'merchant_rejected';--> statement-breakpoint
ALTER TYPE "public"."notification_event" ADD VALUE 'merchant_application_expired';--> statement-breakpoint
ALTER TYPE "public"."notification_event" ADD VALUE 'merchant_revoked';--> statement-breakpoint
ALTER TYPE "public"."telegram_message_kind" ADD VALUE 'merchant_application';--> statement-breakpoint
CREATE TABLE "merchant_application_events" (
	"id" uuid PRIMARY KEY NOT NULL,
	"application_id" uuid NOT NULL,
	"event" "merchant_application_event" NOT NULL,
	"message" text,
	"created_at" timestamp with time zone DEFAULT clock_timestamp() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "merchant_applications" (
	"id" uuid PRIMARY KEY NOT NULL,
	"customer_id" uuid NOT NULL,
	"status" "merchant_application_status" DEFAULT 'under_review' NOT NULL,
	"trade_name" text NOT NULL,
	"activity" "merchant_activity" NOT NULL,
	"activity_other" text,
	"years_in_business" "years_in_business" NOT NULL,
	"governorate" "governorate" NOT NULL,
	"city" text NOT NULL,
	"street_address" text NOT NULL,
	"whatsapp" text NOT NULL,
	"telegram_username" text,
	"monthly_volume" "monthly_volume" NOT NULL,
	"product_interests" "product_interest"[] NOT NULL,
	"sales_channels" "sales_channel"[] NOT NULL,
	"shop_photo_file_id" uuid,
	"shop_link" text,
	"terms_version_id" uuid NOT NULL,
	"heard_from" "heard_from",
	"idempotency_key" text NOT NULL,
	"admin_message" text,
	"approved_price_list_id" uuid,
	"submitted_at" timestamp with time zone DEFAULT now() NOT NULL,
	"info_requested_at" timestamp with time zone,
	"decided_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "merchant_applications_idempotency_key_unique" UNIQUE("idempotency_key"),
	CONSTRAINT "merchant_applications_text_check" CHECK (char_length("merchant_applications"."trade_name") between 2 and 80
        and char_length("merchant_applications"."city") between 2 and 60
        and char_length("merchant_applications"."street_address") between 5 and 160
        and ("merchant_applications"."activity_other" is null or char_length("merchant_applications"."activity_other") between 2 and 80)
        and ("merchant_applications"."shop_link" is null or (char_length("merchant_applications"."shop_link") <= 300 and "merchant_applications"."shop_link" like 'https://%'))
        and ("merchant_applications"."admin_message" is null or char_length("merchant_applications"."admin_message") between 5 and 500)),
	CONSTRAINT "merchant_applications_activity_other_check" CHECK (("merchant_applications"."activity" = 'other') = ("merchant_applications"."activity_other" is not null)),
	CONSTRAINT "merchant_applications_telegram_check" CHECK ("merchant_applications"."telegram_username" is null or "merchant_applications"."telegram_username" ~ '^[A-Za-z0-9_]{5,32}$'),
	CONSTRAINT "merchant_applications_choices_check" CHECK (cardinality("merchant_applications"."product_interests") between 1 and 3
        and cardinality("merchant_applications"."sales_channels") between 1 and 4),
	CONSTRAINT "merchant_applications_approved_check" CHECK (("merchant_applications"."status" = 'approved') = ("merchant_applications"."approved_price_list_id" is not null))
);
--> statement-breakpoint
CREATE TABLE "merchant_profiles" (
	"customer_id" uuid PRIMARY KEY NOT NULL,
	"trade_name" text NOT NULL,
	"governorate" "governorate" NOT NULL,
	"city" text NOT NULL,
	"application_id" uuid,
	"terms_version_id" uuid,
	"granted_at" timestamp with time zone NOT NULL,
	"revoked_at" timestamp with time zone,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "merchant_profiles_text_check" CHECK (char_length("merchant_profiles"."trade_name") between 2 and 80 and char_length("merchant_profiles"."city") between 2 and 60)
);
--> statement-breakpoint
CREATE TABLE "merchant_settings" (
	"id" uuid PRIMARY KEY NOT NULL,
	"per_deposit_usd_units" bigint NOT NULL,
	"daily_deposit_usd_units" bigint NOT NULL,
	"orders_per_ten_minutes" integer NOT NULL,
	"reapply_wait_days" integer NOT NULL,
	"info_expiry_days" integer NOT NULL,
	"admin_id" uuid,
	"created_at" timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
	CONSTRAINT "merchant_settings_bounds_check" CHECK ("merchant_settings"."per_deposit_usd_units" > 0 and "merchant_settings"."per_deposit_usd_units" % 10000 = 0
        and "merchant_settings"."daily_deposit_usd_units" > 0 and "merchant_settings"."daily_deposit_usd_units" % 10000 = 0
        and "merchant_settings"."daily_deposit_usd_units" <= 100000000000
        and "merchant_settings"."per_deposit_usd_units" <= "merchant_settings"."daily_deposit_usd_units"
        and "merchant_settings"."orders_per_ten_minutes" between 10 and 500
        and "merchant_settings"."reapply_wait_days" between 0 and 365
        and "merchant_settings"."info_expiry_days" between 1 and 60)
);
--> statement-breakpoint
CREATE TABLE "merchant_shop_photos" (
	"file_id" uuid PRIMARY KEY NOT NULL,
	"customer_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT clock_timestamp() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "merchant_application_events" ADD CONSTRAINT "merchant_application_events_application_id_merchant_applications_id_fk" FOREIGN KEY ("application_id") REFERENCES "public"."merchant_applications"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "merchant_applications" ADD CONSTRAINT "merchant_applications_customer_id_customers_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "merchant_applications" ADD CONSTRAINT "merchant_applications_shop_photo_file_id_merchant_shop_photos_file_id_fk" FOREIGN KEY ("shop_photo_file_id") REFERENCES "public"."merchant_shop_photos"("file_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "merchant_applications" ADD CONSTRAINT "merchant_applications_terms_version_id_content_page_versions_id_fk" FOREIGN KEY ("terms_version_id") REFERENCES "public"."content_page_versions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "merchant_applications" ADD CONSTRAINT "merchant_applications_approved_price_list_id_price_lists_id_fk" FOREIGN KEY ("approved_price_list_id") REFERENCES "public"."price_lists"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "merchant_profiles" ADD CONSTRAINT "merchant_profiles_customer_id_customers_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "merchant_profiles" ADD CONSTRAINT "merchant_profiles_application_id_merchant_applications_id_fk" FOREIGN KEY ("application_id") REFERENCES "public"."merchant_applications"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "merchant_profiles" ADD CONSTRAINT "merchant_profiles_terms_version_id_content_page_versions_id_fk" FOREIGN KEY ("terms_version_id") REFERENCES "public"."content_page_versions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "merchant_shop_photos" ADD CONSTRAINT "merchant_shop_photos_file_id_stored_files_id_fk" FOREIGN KEY ("file_id") REFERENCES "public"."stored_files"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "merchant_shop_photos" ADD CONSTRAINT "merchant_shop_photos_customer_id_customers_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "merchant_application_events_application_idx" ON "merchant_application_events" USING btree ("application_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "merchant_applications_open_idx" ON "merchant_applications" USING btree ("customer_id") WHERE "merchant_applications"."status" in ('under_review', 'info_requested');--> statement-breakpoint
CREATE INDEX "merchant_applications_status_submitted_idx" ON "merchant_applications" USING btree ("status","submitted_at");--> statement-breakpoint
CREATE INDEX "merchant_applications_customer_idx" ON "merchant_applications" USING btree ("customer_id","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE UNIQUE INDEX "merchant_applications_shop_photo_idx" ON "merchant_applications" USING btree ("shop_photo_file_id");--> statement-breakpoint
CREATE INDEX "merchant_applications_terms_version_id_idx" ON "merchant_applications" USING btree ("terms_version_id");--> statement-breakpoint
CREATE INDEX "merchant_applications_approved_price_list_id_idx" ON "merchant_applications" USING btree ("approved_price_list_id");--> statement-breakpoint
CREATE INDEX "merchant_profiles_application_id_idx" ON "merchant_profiles" USING btree ("application_id");--> statement-breakpoint
CREATE INDEX "merchant_profiles_terms_version_id_idx" ON "merchant_profiles" USING btree ("terms_version_id");--> statement-breakpoint
CREATE INDEX "merchant_settings_created_at_idx" ON "merchant_settings" USING btree ("created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "merchant_settings_admin_id_idx" ON "merchant_settings" USING btree ("admin_id");--> statement-breakpoint
CREATE INDEX "merchant_shop_photos_customer_id_idx" ON "merchant_shop_photos" USING btree ("customer_id","created_at" DESC NULLS LAST);