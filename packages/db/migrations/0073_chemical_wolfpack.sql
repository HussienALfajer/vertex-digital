ALTER TYPE "public"."input_field_type" ADD VALUE 'hoyoverse_uid';--> statement-breakpoint
ALTER TYPE "public"."input_field_type" ADD VALUE 'supercell_tag';--> statement-breakpoint
CREATE TABLE "game_player_checks" (
	"game_id" uuid PRIMARY KEY NOT NULL,
	"supplier_id" uuid NOT NULL,
	"category_id" text NOT NULL,
	"field_map" jsonb NOT NULL,
	"option_map" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"allowed_regions" text[] DEFAULT '{}'::text[] NOT NULL,
	"enabled" boolean NOT NULL,
	"admin_id" uuid NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "game_player_checks_category_id_check" CHECK (char_length("game_player_checks"."category_id") between 1 and 128),
	CONSTRAINT "game_player_checks_maps_check" CHECK (jsonb_typeof("game_player_checks"."field_map") = 'object' and jsonb_typeof("game_player_checks"."option_map") = 'object'),
	CONSTRAINT "game_player_checks_allowed_regions_check" CHECK (coalesce(array_length("game_player_checks"."allowed_regions", 1), 0) <= 20
        and array_position("game_player_checks"."allowed_regions", null) is null)
);
--> statement-breakpoint
ALTER TABLE "orders" ADD COLUMN "player_region" text;--> statement-breakpoint
ALTER TABLE "player_checks" ADD COLUMN "region" text;--> statement-breakpoint
ALTER TABLE "game_player_checks" ADD CONSTRAINT "game_player_checks_game_id_catalog_games_id_fk" FOREIGN KEY ("game_id") REFERENCES "public"."catalog_games"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "game_player_checks" ADD CONSTRAINT "game_player_checks_supplier_id_suppliers_id_fk" FOREIGN KEY ("supplier_id") REFERENCES "public"."suppliers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "game_player_checks_supplier_id_idx" ON "game_player_checks" USING btree ("supplier_id");--> statement-breakpoint
ALTER TABLE "orders" ADD CONSTRAINT "orders_player_region_check" CHECK ("orders"."player_region" is null
        or ("orders"."player_check" = 'valid' and char_length("orders"."player_region") between 1 and 16));--> statement-breakpoint
ALTER TABLE "player_checks" ADD CONSTRAINT "player_checks_region_check" CHECK ("player_checks"."region" is null
        or ("player_checks"."result" = 'valid' and char_length("player_checks"."region") between 1 and 16));