CREATE TABLE "merchant_pinned_games" (
	"id" uuid PRIMARY KEY NOT NULL,
	"customer_id" uuid NOT NULL,
	"game_id" uuid NOT NULL,
	"position" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "merchant_pinned_games_position_check" CHECK ("merchant_pinned_games"."position" between 0 and 19)
);
--> statement-breakpoint
ALTER TABLE "merchant_pinned_games" ADD CONSTRAINT "merchant_pinned_games_customer_id_customers_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "merchant_pinned_games" ADD CONSTRAINT "merchant_pinned_games_game_id_catalog_games_id_fk" FOREIGN KEY ("game_id") REFERENCES "public"."catalog_games"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "merchant_pinned_games_game_idx" ON "merchant_pinned_games" USING btree ("customer_id","game_id");--> statement-breakpoint
CREATE UNIQUE INDEX "merchant_pinned_games_position_idx" ON "merchant_pinned_games" USING btree ("customer_id","position");--> statement-breakpoint
CREATE INDEX "merchant_pinned_games_customer_id_idx" ON "merchant_pinned_games" USING btree ("customer_id");--> statement-breakpoint
CREATE INDEX "merchant_pinned_games_game_id_idx" ON "merchant_pinned_games" USING btree ("game_id");