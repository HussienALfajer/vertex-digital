CREATE TYPE "public"."stock_level" AS ENUM('ok', 'low', 'out', 'unlimited');--> statement-breakpoint
ALTER TYPE "public"."supplier_call_operation" ADD VALUE 'list_categories';--> statement-breakpoint
ALTER TYPE "public"."supplier_call_operation" ADD VALUE 'list_transactions';--> statement-breakpoint
ALTER TYPE "public"."supplier_call_operation" ADD VALUE 'list_orders';--> statement-breakpoint
ALTER TYPE "public"."supplier_call_operation" ADD VALUE 'platform_status';--> statement-breakpoint
ALTER TYPE "public"."supplier_call_operation" ADD VALUE 'fetch_image';--> statement-breakpoint
ALTER TYPE "public"."telegram_message_kind" ADD VALUE 'supplier_stock_low';--> statement-breakpoint
CREATE TABLE "supplier_categories" (
	"id" uuid PRIMARY KEY NOT NULL,
	"supplier_id" uuid NOT NULL,
	"category_id" text NOT NULL,
	"parent_category_id" text,
	"name" text NOT NULL,
	"kind" "product_kind",
	"product_count" integer,
	"in_stock_count" integer,
	"image_url" text,
	"last_seen_at" timestamp with time zone NOT NULL,
	"missing_since" timestamp with time zone,
	"game_id" uuid,
	"linked_at" timestamp with time zone,
	"ignored_at" timestamp with time zone,
	"state_admin_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "supplier_categories_category_id_check" CHECK (char_length("supplier_categories"."category_id") between 1 and 64),
	CONSTRAINT "supplier_categories_parent_category_id_check" CHECK (char_length("supplier_categories"."parent_category_id") between 1 and 64),
	CONSTRAINT "supplier_categories_name_check" CHECK (char_length("supplier_categories"."name") between 1 and 200),
	CONSTRAINT "supplier_categories_counts_check" CHECK ("supplier_categories"."product_count" >= 0 and "supplier_categories"."in_stock_count" >= 0),
	CONSTRAINT "supplier_categories_image_url_check" CHECK (char_length("supplier_categories"."image_url") <= 500 and "supplier_categories"."image_url" like 'https://%'),
	CONSTRAINT "supplier_categories_linked_check" CHECK (("supplier_categories"."game_id" is null) = ("supplier_categories"."linked_at" is null))
);
--> statement-breakpoint
ALTER TABLE "supplier_offers" ADD COLUMN "category_id" text;--> statement-breakpoint
ALTER TABLE "supplier_offers" ADD COLUMN "stock" integer;--> statement-breakpoint
ALTER TABLE "supplier_offers" ADD COLUMN "original_cost_usd_units" bigint;--> statement-breakpoint
ALTER TABLE "supplier_offers" ADD COLUMN "field_specs" jsonb;--> statement-breakpoint
ALTER TABLE "supplier_offers" ADD COLUMN "unsupported_reason" text;--> statement-breakpoint
ALTER TABLE "supplier_offers" ADD COLUMN "ignored_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "supplier_offers" ADD COLUMN "ignored_admin_id" uuid;--> statement-breakpoint
ALTER TABLE "supplier_offers" ADD COLUMN "stock_alert" "stock_level";--> statement-breakpoint
ALTER TABLE "supplier_policy" ADD COLUMN "low_stock_units" integer DEFAULT 10 NOT NULL;--> statement-breakpoint
ALTER TABLE "supplier_sync_runs" ADD COLUMN "categories_skipped" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "supplier_categories" ADD CONSTRAINT "supplier_categories_supplier_id_suppliers_id_fk" FOREIGN KEY ("supplier_id") REFERENCES "public"."suppliers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "supplier_categories" ADD CONSTRAINT "supplier_categories_game_id_catalog_games_id_fk" FOREIGN KEY ("game_id") REFERENCES "public"."catalog_games"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "supplier_categories_supplier_id_category_id_idx" ON "supplier_categories" USING btree ("supplier_id","category_id");--> statement-breakpoint
CREATE INDEX "supplier_categories_supplier_id_parent_category_id_idx" ON "supplier_categories" USING btree ("supplier_id","parent_category_id");--> statement-breakpoint
CREATE INDEX "supplier_categories_game_id_idx" ON "supplier_categories" USING btree ("game_id");--> statement-breakpoint
CREATE INDEX "supplier_categories_supplier_id_missing_since_idx" ON "supplier_categories" USING btree ("supplier_id","missing_since");--> statement-breakpoint
CREATE INDEX "supplier_offers_supplier_id_category_id_idx" ON "supplier_offers" USING btree ("supplier_id","category_id");--> statement-breakpoint
ALTER TABLE "supplier_offers" ADD CONSTRAINT "supplier_offers_category_id_check" CHECK (char_length("supplier_offers"."category_id") between 1 and 64);--> statement-breakpoint
ALTER TABLE "supplier_offers" ADD CONSTRAINT "supplier_offers_stock_check" CHECK ("supplier_offers"."stock" >= 0);--> statement-breakpoint
ALTER TABLE "supplier_offers" ADD CONSTRAINT "supplier_offers_original_cost_check" CHECK ("supplier_offers"."original_cost_usd_units" between 1 and 10000000000);--> statement-breakpoint
ALTER TABLE "supplier_offers" ADD CONSTRAINT "supplier_offers_field_specs_check" CHECK (jsonb_typeof("supplier_offers"."field_specs") = 'array' and jsonb_array_length("supplier_offers"."field_specs") <= 10);--> statement-breakpoint
ALTER TABLE "supplier_offers" ADD CONSTRAINT "supplier_offers_unsupported_reason_check" CHECK ("supplier_offers"."unsupported_reason" in ('fields_unsupported'));--> statement-breakpoint
ALTER TABLE "supplier_offers" ADD CONSTRAINT "supplier_offers_ignored_check" CHECK (("supplier_offers"."ignored_at" is null) = ("supplier_offers"."ignored_admin_id" is null));--> statement-breakpoint
ALTER TABLE "supplier_policy" ADD CONSTRAINT "supplier_policy_low_stock_check" CHECK ("supplier_policy"."low_stock_units" between 1 and 1000);