CREATE TYPE "public"."order_cancel_reason" AS ENUM('expired', 'customer', 'price_rose', 'product_changed');--> statement-breakpoint
CREATE TYPE "public"."order_player_check" AS ENUM('valid', 'invalid_confirmed', 'unchecked_confirmed', 'none');--> statement-breakpoint
CREATE TYPE "public"."player_check_result" AS ENUM('valid', 'invalid');--> statement-breakpoint
ALTER TYPE "public"."email_template" ADD VALUE 'customer_order_cancelled';--> statement-breakpoint
ALTER TYPE "public"."notification_event" ADD VALUE 'order_paid';--> statement-breakpoint
ALTER TYPE "public"."notification_event" ADD VALUE 'order_cancelled';--> statement-breakpoint
ALTER TYPE "public"."telegram_message_kind" ADD VALUE 'validation_quota_reached';--> statement-breakpoint
CREATE TABLE "player_checks" (
	"id" uuid PRIMARY KEY NOT NULL,
	"game_id" uuid NOT NULL,
	"fields_hash" text NOT NULL,
	"result" "player_check_result" NOT NULL,
	"player_name" text,
	"supplier_id" uuid NOT NULL,
	"customer_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	CONSTRAINT "player_checks_fields_hash_check" CHECK ("player_checks"."fields_hash" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "player_checks_player_name_check" CHECK ("player_checks"."player_name" is null
        or ("player_checks"."result" = 'valid' and char_length("player_checks"."player_name") between 1 and 64)),
	CONSTRAINT "player_checks_expires_at_check" CHECK ("player_checks"."expires_at" > "player_checks"."created_at")
);
--> statement-breakpoint
ALTER TABLE "orders" ALTER COLUMN "purchase_journal_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "catalog_games" ADD COLUMN "search_terms" text[] DEFAULT '{}'::text[] NOT NULL;--> statement-breakpoint
ALTER TABLE "orders" ADD COLUMN "reserved_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "orders" ADD COLUMN "expires_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "orders" ADD COLUMN "cancel_reason" "order_cancel_reason";--> statement-breakpoint
ALTER TABLE "orders" ADD COLUMN "player_check" "order_player_check" DEFAULT 'none' NOT NULL;--> statement-breakpoint
ALTER TABLE "orders" ADD COLUMN "player_name" text;--> statement-breakpoint
ALTER TABLE "suppliers" ADD COLUMN "validation_daily_quota" integer DEFAULT 1000 NOT NULL;--> statement-breakpoint
ALTER TABLE "player_checks" ADD CONSTRAINT "player_checks_game_id_catalog_games_id_fk" FOREIGN KEY ("game_id") REFERENCES "public"."catalog_games"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "player_checks" ADD CONSTRAINT "player_checks_supplier_id_suppliers_id_fk" FOREIGN KEY ("supplier_id") REFERENCES "public"."suppliers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "player_checks" ADD CONSTRAINT "player_checks_customer_id_customers_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "player_checks_game_id_fields_hash_created_at_idx" ON "player_checks" USING btree ("game_id","fields_hash","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "player_checks_expires_at_idx" ON "player_checks" USING btree ("expires_at");--> statement-breakpoint
CREATE INDEX "player_checks_supplier_id_idx" ON "player_checks" USING btree ("supplier_id");--> statement-breakpoint
CREATE INDEX "player_checks_customer_id_idx" ON "player_checks" USING btree ("customer_id");--> statement-breakpoint
CREATE INDEX "orders_awaiting_customer_id_idx" ON "orders" USING btree ("customer_id") WHERE "orders"."status" = 'awaiting_balance';--> statement-breakpoint
CREATE INDEX "orders_awaiting_expires_at_idx" ON "orders" USING btree ("expires_at") WHERE "orders"."status" = 'awaiting_balance';--> statement-breakpoint
CREATE INDEX "supplier_calls_supplier_id_operation_created_at_idx" ON "supplier_calls" USING btree ("supplier_id","operation","created_at" DESC NULLS LAST);--> statement-breakpoint
ALTER TABLE "catalog_games" ADD CONSTRAINT "catalog_games_search_terms_check" CHECK (cardinality("catalog_games"."search_terms") <= 20 and array_position("catalog_games"."search_terms", null) is null);--> statement-breakpoint
ALTER TABLE "orders" ADD CONSTRAINT "orders_purchase_journal_check" CHECK (("orders"."purchase_journal_id" is not null) = ("orders"."paid_at" is not null)
        and ("orders"."purchase_journal_id" is not null
          or "orders"."status" = 'awaiting_balance'
          or ("orders"."status" = 'cancelled' and "orders"."paid_at" is null)));--> statement-breakpoint
ALTER TABLE "orders" ADD CONSTRAINT "orders_reservation_check" CHECK (("orders"."reserved_at" is null) = ("orders"."expires_at" is null)
        and ("orders"."status" <> 'awaiting_balance' or "orders"."reserved_at" is not null)
        and ("orders"."status" = 'cancelled') = ("orders"."cancel_reason" is not null));--> statement-breakpoint
ALTER TABLE "orders" ADD CONSTRAINT "orders_player_name_check" CHECK ("orders"."player_name" is null
        or ("orders"."player_check" = 'valid' and char_length("orders"."player_name") between 1 and 64));--> statement-breakpoint
ALTER TABLE "suppliers" ADD CONSTRAINT "suppliers_validation_daily_quota_check" CHECK ("suppliers"."validation_daily_quota" between 0 and 1000000);