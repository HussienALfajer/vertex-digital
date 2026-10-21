CREATE TYPE "public"."quick_link_event" AS ENUM('open', 'order');--> statement-breakpoint
CREATE TABLE "quick_link_events" (
	"id" uuid PRIMARY KEY NOT NULL,
	"product_id" uuid NOT NULL,
	"campaign" text,
	"kind" "quick_link_event" NOT NULL,
	"order_id" uuid,
	"created_at" timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
	CONSTRAINT "quick_link_events_order_id_unique" UNIQUE("order_id"),
	CONSTRAINT "quick_link_events_campaign_check" CHECK ("quick_link_events"."campaign" ~ '^[a-z0-9_-]{1,32}$'),
	CONSTRAINT "quick_link_events_order_check" CHECK (("quick_link_events"."kind" = 'order') = ("quick_link_events"."order_id" is not null))
);
--> statement-breakpoint
ALTER TABLE "catalog_games" ADD COLUMN "best_value_enabled" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "catalog_products" ADD COLUMN "quick_code" text DEFAULT catalog_quick_code() NOT NULL;--> statement-breakpoint
ALTER TABLE "saved_players" ADD COLUMN "quick_buy_hidden" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "quick_link_events" ADD CONSTRAINT "quick_link_events_product_id_catalog_products_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."catalog_products"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "quick_link_events" ADD CONSTRAINT "quick_link_events_order_id_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."orders"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "quick_link_events_product_id_created_at_idx" ON "quick_link_events" USING btree ("product_id","created_at");--> statement-breakpoint
CREATE INDEX "quick_link_events_created_at_idx" ON "quick_link_events" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "orders_customer_id_game_id_paid_at_idx" ON "orders" USING btree ("customer_id","game_id","paid_at" DESC NULLS LAST) WHERE "orders"."paid_at" is not null;--> statement-breakpoint
ALTER TABLE "catalog_products" ADD CONSTRAINT "catalog_products_quick_code_unique" UNIQUE("quick_code");--> statement-breakpoint
ALTER TABLE "catalog_products" ADD CONSTRAINT "catalog_products_quick_code_check" CHECK ("catalog_products"."quick_code" ~ '^[2-9A-HJKMNP-Z]{6}$');