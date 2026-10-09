CREATE TYPE "public"."receipt_player_display" AS ENUM('masked', 'full');--> statement-breakpoint
CREATE TYPE "public"."share_kind" AS ENUM('gift', 'receipt');--> statement-breakpoint
CREATE TYPE "public"."share_revoker" AS ENUM('customer', 'admin');--> statement-breakpoint
ALTER TYPE "public"."email_template" ADD VALUE 'customer_checkout_finished';--> statement-breakpoint
ALTER TYPE "public"."notification_event" ADD VALUE 'checkout_finished';--> statement-breakpoint
CREATE TABLE "checkouts" (
	"id" uuid PRIMARY KEY NOT NULL,
	"customer_id" uuid NOT NULL,
	"is_test" boolean NOT NULL,
	"idempotency_key" uuid NOT NULL,
	"request_hash" text NOT NULL,
	"line_count" integer NOT NULL,
	"total_usd_units" bigint NOT NULL,
	"display_rate_id" uuid,
	"total_syp_units" bigint,
	"purchase_journal_id" uuid NOT NULL,
	"finished_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "checkouts_idempotency_key_unique" UNIQUE("idempotency_key"),
	CONSTRAINT "checkouts_purchase_journal_id_unique" UNIQUE("purchase_journal_id"),
	CONSTRAINT "checkouts_line_count_check" CHECK ("checkouts"."line_count" between 1 and 10),
	CONSTRAINT "checkouts_total_check" CHECK ("checkouts"."total_usd_units" > 0 and "checkouts"."total_usd_units" % 10000 = 0),
	CONSTRAINT "checkouts_syp_check" CHECK (("checkouts"."display_rate_id" is null) = ("checkouts"."total_syp_units" is null) and "checkouts"."total_syp_units" >= 0),
	CONSTRAINT "checkouts_request_hash_check" CHECK ("checkouts"."request_hash" ~ '^[0-9a-f]{64}$')
);
--> statement-breakpoint
CREATE TABLE "order_share_links" (
	"id" uuid PRIMARY KEY NOT NULL,
	"order_id" uuid NOT NULL,
	"kind" "share_kind" NOT NULL,
	"token" text NOT NULL,
	"show_price" boolean NOT NULL,
	"player_display" "receipt_player_display" DEFAULT 'masked' NOT NULL,
	"revoked_at" timestamp with time zone,
	"revoked_by" "share_revoker",
	"revoke_reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "order_share_links_token_unique" UNIQUE("token"),
	CONSTRAINT "order_share_links_token_check" CHECK ("order_share_links"."token" ~ '^[A-Za-z0-9_-]{22}$'),
	CONSTRAINT "order_share_links_gift_check" CHECK ("order_share_links"."kind" = 'receipt' or (not "order_share_links"."show_price" and "order_share_links"."player_display" = 'masked')),
	CONSTRAINT "order_share_links_revoked_check" CHECK (("order_share_links"."revoked_at" is null) = ("order_share_links"."revoked_by" is null)
        and ("order_share_links"."revoked_by" = 'admin') = ("order_share_links"."revoke_reason" is not null)
        and char_length("order_share_links"."revoke_reason") between 5 and 500)
);
--> statement-breakpoint
CREATE TABLE "saved_players" (
	"id" uuid PRIMARY KEY NOT NULL,
	"customer_id" uuid NOT NULL,
	"game_id" uuid NOT NULL,
	"label" text NOT NULL,
	"fields" jsonb NOT NULL,
	"fields_hash" text NOT NULL,
	"player_name" text,
	"name_checked_at" timestamp with time zone,
	"rejected_at" timestamp with time zone,
	"last_used_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "saved_players_label_check" CHECK (char_length("saved_players"."label") between 1 and 30),
	CONSTRAINT "saved_players_fields_check" CHECK (jsonb_typeof("saved_players"."fields") = 'object'),
	CONSTRAINT "saved_players_fields_hash_check" CHECK ("saved_players"."fields_hash" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "saved_players_player_name_check" CHECK (("saved_players"."player_name" is null) = ("saved_players"."name_checked_at" is null)
        and char_length("saved_players"."player_name") between 1 and 64)
);
--> statement-breakpoint
ALTER TABLE "orders" DROP CONSTRAINT "orders_purchase_journal_id_unique";--> statement-breakpoint
ALTER TABLE "orders" ADD COLUMN "checkout_id" uuid;--> statement-breakpoint
ALTER TABLE "orders" ADD COLUMN "checkout_line" integer;--> statement-breakpoint
ALTER TABLE "orders" ADD COLUMN "is_gift" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "orders" ADD COLUMN "gift_sender_name" text;--> statement-breakpoint
ALTER TABLE "orders" ADD COLUMN "gift_message" text;--> statement-breakpoint
ALTER TABLE "checkouts" ADD CONSTRAINT "checkouts_customer_id_customers_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "checkouts" ADD CONSTRAINT "checkouts_display_rate_id_exchange_rates_id_fk" FOREIGN KEY ("display_rate_id") REFERENCES "public"."exchange_rates"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "checkouts" ADD CONSTRAINT "checkouts_purchase_journal_id_ledger_journals_id_fk" FOREIGN KEY ("purchase_journal_id") REFERENCES "public"."ledger_journals"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "order_share_links" ADD CONSTRAINT "order_share_links_order_id_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."orders"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "saved_players" ADD CONSTRAINT "saved_players_customer_id_customers_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "saved_players" ADD CONSTRAINT "saved_players_game_id_catalog_games_id_fk" FOREIGN KEY ("game_id") REFERENCES "public"."catalog_games"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "checkouts_customer_id_created_at_idx" ON "checkouts" USING btree ("customer_id","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "checkouts_display_rate_id_idx" ON "checkouts" USING btree ("display_rate_id");--> statement-breakpoint
CREATE UNIQUE INDEX "order_share_links_live_idx" ON "order_share_links" USING btree ("order_id","kind") WHERE "order_share_links"."revoked_at" is null;--> statement-breakpoint
CREATE INDEX "order_share_links_order_id_idx" ON "order_share_links" USING btree ("order_id");--> statement-breakpoint
CREATE UNIQUE INDEX "saved_players_customer_id_game_id_fields_hash_idx" ON "saved_players" USING btree ("customer_id","game_id","fields_hash");--> statement-breakpoint
CREATE INDEX "saved_players_customer_id_game_id_last_used_at_idx" ON "saved_players" USING btree ("customer_id","game_id","last_used_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "saved_players_game_id_idx" ON "saved_players" USING btree ("game_id");--> statement-breakpoint
ALTER TABLE "orders" ADD CONSTRAINT "orders_checkout_id_checkouts_id_fk" FOREIGN KEY ("checkout_id") REFERENCES "public"."checkouts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "orders_purchase_journal_id_single_idx" ON "orders" USING btree ("purchase_journal_id") WHERE "orders"."checkout_id" is null;--> statement-breakpoint
CREATE INDEX "orders_purchase_journal_id_idx" ON "orders" USING btree ("purchase_journal_id");--> statement-breakpoint
CREATE UNIQUE INDEX "orders_checkout_id_checkout_line_idx" ON "orders" USING btree ("checkout_id","checkout_line");--> statement-breakpoint
ALTER TABLE "orders" ADD CONSTRAINT "orders_checkout_check" CHECK (("orders"."checkout_id" is null) = ("orders"."checkout_line" is null)
        and "orders"."checkout_line" between 1 and 10
        and ("orders"."checkout_id" is null or "orders"."reserved_at" is null));--> statement-breakpoint
ALTER TABLE "orders" ADD CONSTRAINT "orders_gift_check" CHECK (("orders"."is_gift" or ("orders"."gift_sender_name" is null and "orders"."gift_message" is null))
        and (not "orders"."is_gift" or "orders"."kind" = 'direct')
        and char_length("orders"."gift_sender_name") between 1 and 30
        and char_length("orders"."gift_message") between 1 and 140);