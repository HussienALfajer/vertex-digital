CREATE TYPE "public"."catalog_status" AS ENUM('active', 'paused');--> statement-breakpoint
CREATE TYPE "public"."input_field_type" AS ENUM('digits', 'text', 'select', 'phone');--> statement-breakpoint
CREATE TYPE "public"."product_kind" AS ENUM('direct', 'code');--> statement-breakpoint
CREATE TYPE "public"."margin_scope" AS ENUM('global', 'category', 'game', 'product');--> statement-breakpoint
ALTER TYPE "public"."stored_file_kind" ADD VALUE 'catalog_image';--> statement-breakpoint
CREATE TABLE "catalog_categories" (
	"id" uuid PRIMARY KEY NOT NULL,
	"slug" text NOT NULL,
	"name_ar" text NOT NULL,
	"sort_order" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"archived_at" timestamp with time zone,
	CONSTRAINT "catalog_categories_slug_unique" UNIQUE("slug"),
	CONSTRAINT "catalog_categories_slug_check" CHECK ("catalog_categories"."slug" ~ '^[a-z0-9]+(-[a-z0-9]+)*$' and char_length("catalog_categories"."slug") between 2 and 48),
	CONSTRAINT "catalog_categories_name_ar_check" CHECK (char_length("catalog_categories"."name_ar") between 1 and 40)
);
--> statement-breakpoint
CREATE TABLE "catalog_games" (
	"id" uuid PRIMARY KEY NOT NULL,
	"category_id" uuid NOT NULL,
	"slug" text NOT NULL,
	"name_ar" text NOT NULL,
	"name_en" text NOT NULL,
	"status" "catalog_status" DEFAULT 'paused' NOT NULL,
	"cover_file_id" uuid,
	"id_guide_file_id" uuid,
	"accent_color" text,
	"region_notes_ar" text,
	"sort_order" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"archived_at" timestamp with time zone,
	CONSTRAINT "catalog_games_slug_unique" UNIQUE("slug"),
	CONSTRAINT "catalog_games_slug_check" CHECK ("catalog_games"."slug" ~ '^[a-z0-9]+(-[a-z0-9]+)*$' and char_length("catalog_games"."slug") between 2 and 48),
	CONSTRAINT "catalog_games_name_ar_check" CHECK (char_length("catalog_games"."name_ar") between 1 and 60),
	CONSTRAINT "catalog_games_name_en_check" CHECK (char_length("catalog_games"."name_en") between 1 and 60),
	CONSTRAINT "catalog_games_accent_color_check" CHECK ("catalog_games"."accent_color" ~ '^#[0-9A-F]{6}$'),
	CONSTRAINT "catalog_games_region_notes_ar_check" CHECK (char_length("catalog_games"."region_notes_ar") between 1 and 500)
);
--> statement-breakpoint
CREATE TABLE "catalog_input_fields" (
	"id" uuid PRIMARY KEY NOT NULL,
	"game_id" uuid NOT NULL,
	"key" text NOT NULL,
	"label_ar" text NOT NULL,
	"help_ar" text,
	"type" "input_field_type" NOT NULL,
	"required" boolean NOT NULL,
	"min_length" integer,
	"max_length" integer,
	"options" jsonb,
	"sort_order" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"archived_at" timestamp with time zone,
	CONSTRAINT "catalog_input_fields_key_check" CHECK ("catalog_input_fields"."key" ~ '^[a-z][a-z0-9_]{1,31}$'),
	CONSTRAINT "catalog_input_fields_label_ar_check" CHECK (char_length("catalog_input_fields"."label_ar") between 1 and 40),
	CONSTRAINT "catalog_input_fields_help_ar_check" CHECK (char_length("catalog_input_fields"."help_ar") between 1 and 200),
	CONSTRAINT "catalog_input_fields_bounds_check" CHECK (case "catalog_input_fields"."type"
        when 'digits' then coalesce("catalog_input_fields"."min_length" between 1 and 32, true)
          and coalesce("catalog_input_fields"."max_length" between 1 and 32, true)
        when 'text' then coalesce("catalog_input_fields"."min_length" between 1 and 64, true)
          and coalesce("catalog_input_fields"."max_length" between 1 and 64, true)
        else "catalog_input_fields"."min_length" is null and "catalog_input_fields"."max_length" is null
      end and coalesce("catalog_input_fields"."min_length" <= "catalog_input_fields"."max_length", true)),
	CONSTRAINT "catalog_input_fields_options_check" CHECK (case "catalog_input_fields"."type"
        when 'select' then jsonb_typeof("catalog_input_fields"."options") = 'array'
          and jsonb_array_length("catalog_input_fields"."options") between 2 and 50
        else "catalog_input_fields"."options" is null
      end)
);
--> statement-breakpoint
CREATE TABLE "catalog_products" (
	"id" uuid PRIMARY KEY NOT NULL,
	"game_id" uuid NOT NULL,
	"kind" "product_kind" NOT NULL,
	"name_ar" text NOT NULL,
	"game_amount" integer,
	"official_price_usd_units" bigint,
	"max_quantity" integer NOT NULL,
	"region_ar" text,
	"redemption_ar" text,
	"status" "catalog_status" DEFAULT 'active' NOT NULL,
	"sort_order" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"archived_at" timestamp with time zone,
	CONSTRAINT "catalog_products_name_ar_check" CHECK (char_length("catalog_products"."name_ar") between 1 and 60),
	CONSTRAINT "catalog_products_game_amount_check" CHECK ("catalog_products"."game_amount" > 0),
	CONSTRAINT "catalog_products_official_price_check" CHECK ("catalog_products"."official_price_usd_units" > 0 and "catalog_products"."official_price_usd_units" % 10000 = 0),
	CONSTRAINT "catalog_products_max_quantity_check" CHECK ("catalog_products"."max_quantity" between 1 and 50),
	CONSTRAINT "catalog_products_region_ar_check" CHECK (char_length("catalog_products"."region_ar") between 1 and 64),
	CONSTRAINT "catalog_products_redemption_ar_check" CHECK (char_length("catalog_products"."redemption_ar") between 1 and 2000),
	CONSTRAINT "catalog_products_code_text_check" CHECK ("catalog_products"."kind" = 'code' or ("catalog_products"."region_ar" is null and "catalog_products"."redemption_ar" is null))
);
--> statement-breakpoint
CREATE TABLE "margin_rules" (
	"id" uuid PRIMARY KEY NOT NULL,
	"scope" "margin_scope" NOT NULL,
	"target_id" uuid,
	"percent_bp" integer NOT NULL,
	"fixed_usd_units" bigint NOT NULL,
	"min_margin_usd_units" bigint NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"archived_at" timestamp with time zone,
	CONSTRAINT "margin_rules_target_check" CHECK (("margin_rules"."scope" = 'global') = ("margin_rules"."target_id" is null)),
	CONSTRAINT "margin_rules_percent_bp_check" CHECK ("margin_rules"."percent_bp" between 0 and 10000),
	CONSTRAINT "margin_rules_fixed_check" CHECK ("margin_rules"."fixed_usd_units" between 0 and 50000000 and "margin_rules"."fixed_usd_units" % 10000 = 0),
	CONSTRAINT "margin_rules_min_margin_check" CHECK ("margin_rules"."min_margin_usd_units" between 10000 and 50000000 and "margin_rules"."min_margin_usd_units" % 10000 = 0)
);
--> statement-breakpoint
ALTER TABLE "catalog_games" ADD CONSTRAINT "catalog_games_category_id_catalog_categories_id_fk" FOREIGN KEY ("category_id") REFERENCES "public"."catalog_categories"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "catalog_games" ADD CONSTRAINT "catalog_games_cover_file_id_stored_files_id_fk" FOREIGN KEY ("cover_file_id") REFERENCES "public"."stored_files"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "catalog_games" ADD CONSTRAINT "catalog_games_id_guide_file_id_stored_files_id_fk" FOREIGN KEY ("id_guide_file_id") REFERENCES "public"."stored_files"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "catalog_input_fields" ADD CONSTRAINT "catalog_input_fields_game_id_catalog_games_id_fk" FOREIGN KEY ("game_id") REFERENCES "public"."catalog_games"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "catalog_products" ADD CONSTRAINT "catalog_products_game_id_catalog_games_id_fk" FOREIGN KEY ("game_id") REFERENCES "public"."catalog_games"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "catalog_categories_name_ar_live_idx" ON "catalog_categories" USING btree ("name_ar") WHERE "catalog_categories"."archived_at" is null;--> statement-breakpoint
CREATE INDEX "catalog_games_category_id_sort_order_idx" ON "catalog_games" USING btree ("category_id","sort_order");--> statement-breakpoint
CREATE INDEX "catalog_games_cover_file_id_idx" ON "catalog_games" USING btree ("cover_file_id");--> statement-breakpoint
CREATE INDEX "catalog_games_id_guide_file_id_idx" ON "catalog_games" USING btree ("id_guide_file_id");--> statement-breakpoint
CREATE UNIQUE INDEX "catalog_games_name_ar_live_idx" ON "catalog_games" USING btree ("name_ar") WHERE "catalog_games"."archived_at" is null;--> statement-breakpoint
CREATE UNIQUE INDEX "catalog_input_fields_game_id_key_idx" ON "catalog_input_fields" USING btree ("game_id","key");--> statement-breakpoint
CREATE INDEX "catalog_input_fields_game_id_sort_order_idx" ON "catalog_input_fields" USING btree ("game_id","sort_order");--> statement-breakpoint
CREATE INDEX "catalog_products_game_id_sort_order_idx" ON "catalog_products" USING btree ("game_id","sort_order");--> statement-breakpoint
CREATE UNIQUE INDEX "catalog_products_game_id_name_ar_live_idx" ON "catalog_products" USING btree ("game_id","name_ar") WHERE "catalog_products"."archived_at" is null;--> statement-breakpoint
CREATE UNIQUE INDEX "margin_rules_scope_target_id_live_idx" ON "margin_rules" USING btree ("scope","target_id") WHERE "margin_rules"."archived_at" is null;--> statement-breakpoint
CREATE UNIQUE INDEX "margin_rules_global_live_idx" ON "margin_rules" USING btree ((true)) WHERE "margin_rules"."scope" = 'global' and "margin_rules"."archived_at" is null;--> statement-breakpoint
CREATE INDEX "margin_rules_target_id_idx" ON "margin_rules" USING btree ("target_id");