CREATE TYPE "public"."shop_customer_origin" AS ENUM('merchant', 'self');--> statement-breakpoint
CREATE TYPE "public"."shop_rate_mode" AS ENUM('store', 'own');--> statement-breakpoint
CREATE TYPE "public"."shop_return_request_status" AS ENUM('pending', 'confirmed', 'declined', 'expired', 'cancelled');--> statement-breakpoint
CREATE TYPE "public"."shop_settlement_target" AS ENUM('merchant', 'cash_refund');--> statement-breakpoint
CREATE TYPE "public"."shop_status" AS ENUM('requested', 'active', 'suspended', 'closed', 'rejected');--> statement-breakpoint
CREATE TYPE "public"."shop_suspend_reason" AS ENUM('review', 'complaints', 'payments', 'other');--> statement-breakpoint
CREATE TYPE "public"."shop_transfer_cause" AS ENUM('transfer', 'return');--> statement-breakpoint
CREATE TYPE "public"."shop_transfer_currency" AS ENUM('usd', 'syp');--> statement-breakpoint
CREATE TYPE "public"."shop_transfer_direction" AS ENUM('to_customer', 'to_merchant');--> statement-breakpoint
ALTER TYPE "public"."audit_actor_kind" ADD VALUE 'shop_customer';--> statement-breakpoint
ALTER TYPE "public"."email_template" ADD VALUE 'customer_merchant_shop_transfer';--> statement-breakpoint
ALTER TYPE "public"."email_template" ADD VALUE 'shop_customer_invitation';--> statement-breakpoint
ALTER TYPE "public"."email_template" ADD VALUE 'shop_customer_verify_email';--> statement-breakpoint
ALTER TYPE "public"."email_template" ADD VALUE 'shop_customer_reset_password';--> statement-breakpoint
ALTER TYPE "public"."email_template" ADD VALUE 'shop_customer_transfer_received';--> statement-breakpoint
ALTER TYPE "public"."email_template" ADD VALUE 'shop_customer_return_requested';--> statement-breakpoint
ALTER TYPE "public"."email_template" ADD VALUE 'shop_customer_return_done';--> statement-breakpoint
ALTER TYPE "public"."email_template" ADD VALUE 'shop_customer_settled';--> statement-breakpoint
ALTER TYPE "public"."notification_event" ADD VALUE 'merchant_shop_changed';--> statement-breakpoint
ALTER TYPE "public"."notification_event" ADD VALUE 'merchant_shop_return_ended';--> statement-breakpoint
ALTER TYPE "public"."telegram_message_kind" ADD VALUE 'shop_requested';--> statement-breakpoint
ALTER TYPE "public"."telegram_message_kind" ADD VALUE 'shop_closed_with_balance';--> statement-breakpoint
ALTER TYPE "public"."journal_kind" ADD VALUE 'shop_transfer';--> statement-breakpoint
ALTER TYPE "public"."journal_kind" ADD VALUE 'shop_margin';--> statement-breakpoint
ALTER TYPE "public"."ledger_account_kind" ADD VALUE 'shop_customer_wallet';--> statement-breakpoint
ALTER TYPE "public"."ledger_account_kind" ADD VALUE 'shop_margin_held';--> statement-breakpoint
CREATE TABLE "merchant_shop_hidden_games" (
	"shop_id" uuid NOT NULL,
	"game_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "merchant_shop_hidden_games_shop_id_game_id_pk" PRIMARY KEY("shop_id","game_id")
);
--> statement-breakpoint
CREATE TABLE "merchant_shop_rates" (
	"id" uuid PRIMARY KEY NOT NULL,
	"shop_id" uuid NOT NULL,
	"rate_syp_per_usd" numeric(12, 4) NOT NULL,
	"store_rate_id" uuid,
	"confirmed_far" boolean NOT NULL,
	"created_at" timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
	CONSTRAINT "merchant_shop_rates_rate_check" CHECK ("merchant_shop_rates"."rate_syp_per_usd" > 0)
);
--> statement-breakpoint
CREATE TABLE "merchant_shop_slugs" (
	"slug" text PRIMARY KEY NOT NULL,
	"shop_id" uuid NOT NULL,
	"merchant_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "merchant_shops" (
	"id" uuid PRIMARY KEY NOT NULL,
	"merchant_id" uuid NOT NULL,
	"slug" text NOT NULL,
	"status" "shop_status" DEFAULT 'requested' NOT NULL,
	"display_name" text NOT NULL,
	"brand_color" text NOT NULL,
	"announcement" text,
	"rate_mode" "shop_rate_mode" DEFAULT 'store' NOT NULL,
	"customer_balance_cap_usd_units" bigint DEFAULT 200000000 NOT NULL,
	"daily_transfer_cap_usd_units" bigint DEFAULT 1000000000 NOT NULL,
	"customer_limit" integer DEFAULT 2000 NOT NULL,
	"price_list_id_at_close" uuid,
	"reject_reason" text,
	"suspend_reason" "shop_suspend_reason",
	"suspend_note" text,
	"requested_at" timestamp with time zone DEFAULT now() NOT NULL,
	"decided_at" timestamp with time zone,
	"closed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"archived_at" timestamp with time zone,
	CONSTRAINT "merchant_shops_slug_check" CHECK (char_length("merchant_shops"."slug") between 3 and 30 and "merchant_shops"."slug" ~ '^[a-z0-9]([a-z0-9-]*[a-z0-9])?$'),
	CONSTRAINT "merchant_shops_brand_color_check" CHECK ("merchant_shops"."brand_color" ~ '^#[0-9a-f]{6}$'),
	CONSTRAINT "merchant_shops_display_name_check" CHECK (char_length("merchant_shops"."display_name") between 1 and 100),
	CONSTRAINT "merchant_shops_announcement_check" CHECK ("merchant_shops"."announcement" is null or char_length("merchant_shops"."announcement") between 1 and 200),
	CONSTRAINT "merchant_shops_limits_check" CHECK ("merchant_shops"."customer_balance_cap_usd_units" > 0 and "merchant_shops"."customer_balance_cap_usd_units" % 10000 = 0
        and "merchant_shops"."daily_transfer_cap_usd_units" > 0 and "merchant_shops"."daily_transfer_cap_usd_units" % 10000 = 0
        and "merchant_shops"."customer_limit" > 0),
	CONSTRAINT "merchant_shops_reasons_check" CHECK (("merchant_shops"."status" <> 'rejected' or "merchant_shops"."reject_reason" is not null)
        and ("merchant_shops"."status" <> 'suspended' or ("merchant_shops"."suspend_reason" is not null and "merchant_shops"."suspend_note" is not null))
        and ("merchant_shops"."status" <> 'closed' or "merchant_shops"."closed_at" is not null)
        and ("merchant_shops"."status" = 'requested' or "merchant_shops"."decided_at" is not null))
);
--> statement-breakpoint
CREATE TABLE "shop_customer_accounts" (
	"id" uuid PRIMARY KEY NOT NULL,
	"user_id" uuid NOT NULL,
	"account_id" text NOT NULL,
	"provider_id" text NOT NULL,
	"access_token" text,
	"refresh_token" text,
	"id_token" text,
	"access_token_expires_at" timestamp with time zone,
	"refresh_token_expires_at" timestamp with time zone,
	"scope" text,
	"password" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "shop_customer_sessions" (
	"id" uuid PRIMARY KEY NOT NULL,
	"user_id" uuid NOT NULL,
	"shop_id" uuid NOT NULL,
	"token" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"ip_address" text,
	"user_agent" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "shop_customer_sessions_token_unique" UNIQUE("token")
);
--> statement-breakpoint
CREATE TABLE "shop_customer_verifications" (
	"id" uuid PRIMARY KEY NOT NULL,
	"identifier" text NOT NULL,
	"value" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "shop_customers" (
	"id" uuid PRIMARY KEY NOT NULL,
	"shop_id" uuid NOT NULL,
	"name" text NOT NULL,
	"email" text NOT NULL,
	"email_verified" boolean DEFAULT false NOT NULL,
	"image" text,
	"phone" text NOT NULL,
	"created_by" "shop_customer_origin" NOT NULL,
	"frozen_at" timestamp with time zone,
	"frozen_reason" text,
	"terms_version_id" uuid,
	"privacy_version_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"archived_at" timestamp with time zone,
	CONSTRAINT "shop_customers_id_shop_unique" UNIQUE("id","shop_id"),
	CONSTRAINT "shop_customers_email_check" CHECK ("shop_customers"."email" = lower("shop_customers"."email")),
	CONSTRAINT "shop_customers_name_check" CHECK (char_length("shop_customers"."name") between 1 and 60),
	CONSTRAINT "shop_customers_frozen_check" CHECK (("shop_customers"."frozen_at" is null) = ("shop_customers"."frozen_reason" is null))
);
--> statement-breakpoint
CREATE TABLE "shop_return_requests" (
	"id" uuid PRIMARY KEY NOT NULL,
	"shop_id" uuid NOT NULL,
	"shop_customer_id" uuid NOT NULL,
	"amount_usd_units" bigint NOT NULL,
	"status" "shop_return_request_status" DEFAULT 'pending' NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"decided_at" timestamp with time zone,
	"idempotency_key" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "shop_return_requests_idempotency_key_unique" UNIQUE("idempotency_key"),
	CONSTRAINT "shop_return_requests_amount_check" CHECK ("shop_return_requests"."amount_usd_units" > 0 and "shop_return_requests"."amount_usd_units" % 10000 = 0),
	CONSTRAINT "shop_return_requests_decided_check" CHECK (("shop_return_requests"."status" = 'pending') = ("shop_return_requests"."decided_at" is null))
);
--> statement-breakpoint
CREATE TABLE "shop_settlements" (
	"id" uuid PRIMARY KEY NOT NULL,
	"shop_id" uuid NOT NULL,
	"shop_customer_id" uuid NOT NULL,
	"target" "shop_settlement_target" NOT NULL,
	"amount_usd_units" bigint NOT NULL,
	"journal_id" uuid NOT NULL,
	"idempotency_key" uuid NOT NULL,
	"admin_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
	CONSTRAINT "shop_settlements_journal_id_unique" UNIQUE("journal_id"),
	CONSTRAINT "shop_settlements_idempotency_key_unique" UNIQUE("idempotency_key"),
	CONSTRAINT "shop_settlements_amount_check" CHECK ("shop_settlements"."amount_usd_units" > 0 and "shop_settlements"."amount_usd_units" % 10000 = 0)
);
--> statement-breakpoint
CREATE TABLE "shop_transfers" (
	"id" uuid PRIMARY KEY NOT NULL,
	"shop_id" uuid NOT NULL,
	"shop_customer_id" uuid NOT NULL,
	"cause" "shop_transfer_cause" NOT NULL,
	"direction" "shop_transfer_direction" NOT NULL,
	"amount_usd_units" bigint NOT NULL,
	"entered_currency" "shop_transfer_currency" NOT NULL,
	"entered_amount_units" bigint NOT NULL,
	"rate_syp_per_usd" numeric(12, 4),
	"journal_id" uuid NOT NULL,
	"return_request_id" uuid,
	"idempotency_key" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
	CONSTRAINT "shop_transfers_journal_id_unique" UNIQUE("journal_id"),
	CONSTRAINT "shop_transfers_return_request_id_unique" UNIQUE("return_request_id"),
	CONSTRAINT "shop_transfers_idempotency_key_unique" UNIQUE("idempotency_key"),
	CONSTRAINT "shop_transfers_amount_check" CHECK ("shop_transfers"."amount_usd_units" > 0 and "shop_transfers"."amount_usd_units" % 10000 = 0 and "shop_transfers"."entered_amount_units" > 0),
	CONSTRAINT "shop_transfers_cause_check" CHECK (case "shop_transfers"."cause"
        when 'transfer' then "shop_transfers"."direction" = 'to_customer' and "shop_transfers"."return_request_id" is null
        else "shop_transfers"."direction" = 'to_merchant' and "shop_transfers"."return_request_id" is not null
      end),
	CONSTRAINT "shop_transfers_entered_check" CHECK (case "shop_transfers"."entered_currency"
        when 'syp' then "shop_transfers"."rate_syp_per_usd" > 0 and "shop_transfers"."entered_amount_units" % 100 = 0
        else "shop_transfers"."rate_syp_per_usd" is null and "shop_transfers"."entered_amount_units" = "shop_transfers"."amount_usd_units"
      end)
);
--> statement-breakpoint
ALTER TABLE "ledger_accounts" ADD COLUMN "shop_customer_id" uuid;--> statement-breakpoint
ALTER TABLE "merchant_shop_hidden_games" ADD CONSTRAINT "merchant_shop_hidden_games_shop_id_merchant_shops_id_fk" FOREIGN KEY ("shop_id") REFERENCES "public"."merchant_shops"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "merchant_shop_hidden_games" ADD CONSTRAINT "merchant_shop_hidden_games_game_id_catalog_games_id_fk" FOREIGN KEY ("game_id") REFERENCES "public"."catalog_games"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "merchant_shop_rates" ADD CONSTRAINT "merchant_shop_rates_shop_id_merchant_shops_id_fk" FOREIGN KEY ("shop_id") REFERENCES "public"."merchant_shops"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "merchant_shop_rates" ADD CONSTRAINT "merchant_shop_rates_store_rate_id_exchange_rates_id_fk" FOREIGN KEY ("store_rate_id") REFERENCES "public"."exchange_rates"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "merchant_shop_slugs" ADD CONSTRAINT "merchant_shop_slugs_shop_id_merchant_shops_id_fk" FOREIGN KEY ("shop_id") REFERENCES "public"."merchant_shops"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "merchant_shop_slugs" ADD CONSTRAINT "merchant_shop_slugs_merchant_id_customers_id_fk" FOREIGN KEY ("merchant_id") REFERENCES "public"."customers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "merchant_shops" ADD CONSTRAINT "merchant_shops_merchant_id_customers_id_fk" FOREIGN KEY ("merchant_id") REFERENCES "public"."customers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "merchant_shops" ADD CONSTRAINT "merchant_shops_price_list_id_at_close_price_lists_id_fk" FOREIGN KEY ("price_list_id_at_close") REFERENCES "public"."price_lists"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shop_customer_accounts" ADD CONSTRAINT "shop_customer_accounts_user_id_shop_customers_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."shop_customers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shop_customer_sessions" ADD CONSTRAINT "shop_customer_sessions_user_shop_fk" FOREIGN KEY ("user_id","shop_id") REFERENCES "public"."shop_customers"("id","shop_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shop_customers" ADD CONSTRAINT "shop_customers_shop_id_merchant_shops_id_fk" FOREIGN KEY ("shop_id") REFERENCES "public"."merchant_shops"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shop_customers" ADD CONSTRAINT "shop_customers_terms_version_id_content_page_versions_id_fk" FOREIGN KEY ("terms_version_id") REFERENCES "public"."content_page_versions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shop_customers" ADD CONSTRAINT "shop_customers_privacy_version_id_content_page_versions_id_fk" FOREIGN KEY ("privacy_version_id") REFERENCES "public"."content_page_versions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shop_return_requests" ADD CONSTRAINT "shop_return_requests_shop_id_merchant_shops_id_fk" FOREIGN KEY ("shop_id") REFERENCES "public"."merchant_shops"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shop_return_requests" ADD CONSTRAINT "shop_return_requests_shop_customer_id_shop_customers_id_fk" FOREIGN KEY ("shop_customer_id") REFERENCES "public"."shop_customers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shop_settlements" ADD CONSTRAINT "shop_settlements_shop_id_merchant_shops_id_fk" FOREIGN KEY ("shop_id") REFERENCES "public"."merchant_shops"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shop_settlements" ADD CONSTRAINT "shop_settlements_shop_customer_id_shop_customers_id_fk" FOREIGN KEY ("shop_customer_id") REFERENCES "public"."shop_customers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shop_settlements" ADD CONSTRAINT "shop_settlements_journal_id_ledger_journals_id_fk" FOREIGN KEY ("journal_id") REFERENCES "public"."ledger_journals"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shop_transfers" ADD CONSTRAINT "shop_transfers_shop_id_merchant_shops_id_fk" FOREIGN KEY ("shop_id") REFERENCES "public"."merchant_shops"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shop_transfers" ADD CONSTRAINT "shop_transfers_shop_customer_id_shop_customers_id_fk" FOREIGN KEY ("shop_customer_id") REFERENCES "public"."shop_customers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shop_transfers" ADD CONSTRAINT "shop_transfers_journal_id_ledger_journals_id_fk" FOREIGN KEY ("journal_id") REFERENCES "public"."ledger_journals"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shop_transfers" ADD CONSTRAINT "shop_transfers_return_request_id_shop_return_requests_id_fk" FOREIGN KEY ("return_request_id") REFERENCES "public"."shop_return_requests"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "merchant_shop_hidden_games_game_id_idx" ON "merchant_shop_hidden_games" USING btree ("game_id");--> statement-breakpoint
CREATE INDEX "merchant_shop_rates_shop_idx" ON "merchant_shop_rates" USING btree ("shop_id","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "merchant_shop_rates_store_rate_id_idx" ON "merchant_shop_rates" USING btree ("store_rate_id");--> statement-breakpoint
CREATE INDEX "merchant_shop_slugs_shop_id_idx" ON "merchant_shop_slugs" USING btree ("shop_id");--> statement-breakpoint
CREATE INDEX "merchant_shop_slugs_merchant_id_idx" ON "merchant_shop_slugs" USING btree ("merchant_id");--> statement-breakpoint
CREATE INDEX "merchant_shops_merchant_id_idx" ON "merchant_shops" USING btree ("merchant_id");--> statement-breakpoint
CREATE UNIQUE INDEX "merchant_shops_live_merchant_idx" ON "merchant_shops" USING btree ("merchant_id") WHERE status in ('requested', 'active', 'suspended');--> statement-breakpoint
CREATE UNIQUE INDEX "merchant_shops_live_slug_idx" ON "merchant_shops" USING btree ("slug") WHERE status in ('requested', 'active', 'suspended');--> statement-breakpoint
CREATE INDEX "merchant_shops_slug_idx" ON "merchant_shops" USING btree ("slug");--> statement-breakpoint
CREATE INDEX "merchant_shops_status_idx" ON "merchant_shops" USING btree ("status","requested_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "merchant_shops_price_list_id_at_close_idx" ON "merchant_shops" USING btree ("price_list_id_at_close");--> statement-breakpoint
CREATE INDEX "shop_customer_accounts_user_id_idx" ON "shop_customer_accounts" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "shop_customer_sessions_user_shop_idx" ON "shop_customer_sessions" USING btree ("user_id","shop_id");--> statement-breakpoint
CREATE INDEX "shop_customer_sessions_shop_id_idx" ON "shop_customer_sessions" USING btree ("shop_id");--> statement-breakpoint
CREATE UNIQUE INDEX "shop_customer_verifications_identifier_idx" ON "shop_customer_verifications" USING btree ("identifier");--> statement-breakpoint
CREATE INDEX "shop_customer_verifications_expires_at_idx" ON "shop_customer_verifications" USING btree ("expires_at");--> statement-breakpoint
CREATE UNIQUE INDEX "shop_customers_shop_email_idx" ON "shop_customers" USING btree ("shop_id","email");--> statement-breakpoint
CREATE INDEX "shop_customers_shop_created_idx" ON "shop_customers" USING btree ("shop_id","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "shop_customers_email_idx" ON "shop_customers" USING btree ("email");--> statement-breakpoint
CREATE INDEX "shop_customers_terms_version_id_idx" ON "shop_customers" USING btree ("terms_version_id");--> statement-breakpoint
CREATE INDEX "shop_customers_privacy_version_id_idx" ON "shop_customers" USING btree ("privacy_version_id");--> statement-breakpoint
CREATE UNIQUE INDEX "shop_return_requests_pending_idx" ON "shop_return_requests" USING btree ("shop_customer_id") WHERE status = 'pending';--> statement-breakpoint
CREATE INDEX "shop_return_requests_customer_idx" ON "shop_return_requests" USING btree ("shop_customer_id","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "shop_return_requests_shop_id_idx" ON "shop_return_requests" USING btree ("shop_id");--> statement-breakpoint
CREATE INDEX "shop_return_requests_due_idx" ON "shop_return_requests" USING btree ("expires_at") WHERE status = 'pending';--> statement-breakpoint
CREATE INDEX "shop_settlements_customer_idx" ON "shop_settlements" USING btree ("shop_customer_id","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "shop_settlements_shop_id_idx" ON "shop_settlements" USING btree ("shop_id");--> statement-breakpoint
CREATE INDEX "shop_transfers_shop_day_idx" ON "shop_transfers" USING btree ("shop_id","direction","created_at");--> statement-breakpoint
CREATE INDEX "shop_transfers_customer_idx" ON "shop_transfers" USING btree ("shop_customer_id","created_at" DESC NULLS LAST);--> statement-breakpoint
ALTER TABLE "ledger_accounts" ADD CONSTRAINT "ledger_accounts_shop_customer_id_shop_customers_id_fk" FOREIGN KEY ("shop_customer_id") REFERENCES "public"."shop_customers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ledger_accounts" ADD CONSTRAINT "ledger_accounts_shop_customer_id_unique" UNIQUE("shop_customer_id");--> statement-breakpoint
ALTER TABLE "ledger_accounts" ADD CONSTRAINT "ledger_accounts_shop_customer_check" CHECK (("ledger_accounts"."shop_customer_id" is not null) = ("ledger_accounts"."kind"::text = 'shop_customer_wallet'));--> statement-breakpoint
ALTER TABLE "ledger_accounts" ADD CONSTRAINT "ledger_accounts_shop_wallet_usd_check" CHECK ("ledger_accounts"."kind"::text not in ('shop_customer_wallet', 'shop_margin_held') or "ledger_accounts"."currency" = 'USD');