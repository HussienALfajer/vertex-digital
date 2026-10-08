CREATE TYPE "public"."deposit_decider" AS ENUM('admin', 'system');--> statement-breakpoint
CREATE TYPE "public"."usdt_check_error" AS ENUM('not_found', 'tx_failed', 'not_to_store', 'wrong_token');--> statement-breakpoint
CREATE TYPE "public"."usdt_check_status" AS ENUM('awaiting_transfer', 'searching', 'confirming', 'review', 'done');--> statement-breakpoint
CREATE TYPE "public"."usdt_transfer_source" AS ENUM('scan', 'txid');--> statement-breakpoint
CREATE TYPE "public"."usdt_txid_source" AS ENUM('customer', 'scan');--> statement-breakpoint
ALTER TYPE "public"."deposit_flag_code" ADD VALUE 'wrong_network';--> statement-breakpoint
ALTER TYPE "public"."deposit_flag_code" ADD VALUE 'sent_before_deposit';--> statement-breakpoint
ALTER TYPE "public"."deposit_method" ADD VALUE 'usdt_trc20';--> statement-breakpoint
ALTER TYPE "public"."deposit_method" ADD VALUE 'usdt_bep20';--> statement-breakpoint
ALTER TYPE "public"."deposit_reject_reason" ADD VALUE 'wrong_network' BEFORE 'other';--> statement-breakpoint
ALTER TYPE "public"."deposit_reject_reason" ADD VALUE 'transfer_other_customer' BEFORE 'other';--> statement-breakpoint
ALTER TYPE "public"."ledger_account_kind" ADD VALUE 'deposit_rounding';--> statement-breakpoint
CREATE TABLE "usdt_deposits" (
	"deposit_id" uuid PRIMARY KEY NOT NULL,
	"method" "payment_method" NOT NULL,
	"receiving_address" text NOT NULL,
	"tail_units" bigint NOT NULL,
	"pay_amount_units" bigint NOT NULL,
	"deposit_open" boolean DEFAULT true NOT NULL,
	"check_status" "usdt_check_status" DEFAULT 'awaiting_transfer' NOT NULL,
	"check_error" "usdt_check_error",
	"txid" text,
	"txid_source" "usdt_txid_source",
	"txid_submissions" smallint DEFAULT 0 NOT NULL,
	"search_started_at" timestamp with time zone,
	"confirmations" integer,
	"transfer_id" uuid,
	"last_checked_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "usdt_deposits_transfer_id_unique" UNIQUE("transfer_id"),
	CONSTRAINT "usdt_deposits_method_check" CHECK ("usdt_deposits"."method" in ('usdt_trc20', 'usdt_bep20')),
	CONSTRAINT "usdt_deposits_amount_check" CHECK ("usdt_deposits"."tail_units" between 100 and 9900 and "usdt_deposits"."tail_units" % 100 = 0
        and "usdt_deposits"."pay_amount_units" > "usdt_deposits"."tail_units"
        and ("usdt_deposits"."pay_amount_units" - "usdt_deposits"."tail_units") % 10000 = 0),
	CONSTRAINT "usdt_deposits_txid_check" CHECK (("usdt_deposits"."txid" is null or "usdt_deposits"."txid" ~ '^[0-9a-f]{64}$')
        and ("usdt_deposits"."txid" is null) = ("usdt_deposits"."txid_source" is null)
        and "usdt_deposits"."txid_submissions" between 0 and 5
        and ("usdt_deposits"."confirmations" is null or "usdt_deposits"."confirmations" >= 0)),
	CONSTRAINT "usdt_deposits_check_error_check" CHECK ("usdt_deposits"."check_error" is null or "usdt_deposits"."check_status" = 'awaiting_transfer'),
	CONSTRAINT "usdt_deposits_transfer_check" CHECK ("usdt_deposits"."transfer_id" is null or "usdt_deposits"."check_status" in ('confirming', 'review', 'done'))
);
--> statement-breakpoint
CREATE TABLE "usdt_scan_cursors" (
	"method" "payment_method" PRIMARY KEY NOT NULL,
	"cursor" text NOT NULL,
	"last_success_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "usdt_scan_cursors_method_check" CHECK ("usdt_scan_cursors"."method" in ('usdt_trc20', 'usdt_bep20'))
);
--> statement-breakpoint
CREATE TABLE "usdt_transfers" (
	"id" uuid PRIMARY KEY NOT NULL,
	"method" "payment_method" NOT NULL,
	"txid" text NOT NULL,
	"from_address" text NOT NULL,
	"to_address" text NOT NULL,
	"raw_amount" numeric(78, 0) NOT NULL,
	"amount_units" bigint NOT NULL,
	"block_number" bigint NOT NULL,
	"block_time" timestamp with time zone NOT NULL,
	"source" "usdt_transfer_source" NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "usdt_transfers_txid_unique" UNIQUE("method","txid"),
	CONSTRAINT "usdt_transfers_method_check" CHECK ("usdt_transfers"."method" in ('usdt_trc20', 'usdt_bep20')),
	CONSTRAINT "usdt_transfers_txid_check" CHECK ("usdt_transfers"."txid" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "usdt_transfers_amount_check" CHECK ("usdt_transfers"."raw_amount" > 0 and "usdt_transfers"."amount_units" >= 1000000 and "usdt_transfers"."block_number" >= 0)
);
--> statement-breakpoint
ALTER TABLE "deposit_settings" ADD COLUMN "usdt_trc20_enabled" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "deposit_settings" ADD COLUMN "usdt_bep20_enabled" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "deposit_settings" ADD COLUMN "usdt_min_deposit_usd_units" bigint DEFAULT 5000000 NOT NULL;--> statement-breakpoint
ALTER TABLE "deposits" ADD COLUMN "decided_by" "deposit_decider";--> statement-breakpoint
ALTER TABLE "usdt_deposits" ADD CONSTRAINT "usdt_deposits_deposit_id_deposits_id_fk" FOREIGN KEY ("deposit_id") REFERENCES "public"."deposits"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "usdt_deposits" ADD CONSTRAINT "usdt_deposits_transfer_id_usdt_transfers_id_fk" FOREIGN KEY ("transfer_id") REFERENCES "public"."usdt_transfers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "usdt_deposits_open_amount_unique" ON "usdt_deposits" USING btree ("method","pay_amount_units") WHERE "usdt_deposits"."deposit_open";--> statement-breakpoint
CREATE INDEX "usdt_deposits_amount_idx" ON "usdt_deposits" USING btree ("method","pay_amount_units");--> statement-breakpoint
CREATE INDEX "usdt_deposits_check_status_idx" ON "usdt_deposits" USING btree ("check_status");--> statement-breakpoint
CREATE INDEX "usdt_transfers_block_time_idx" ON "usdt_transfers" USING btree ("method","block_time" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "usdt_transfers_amount_idx" ON "usdt_transfers" USING btree ("method","amount_units");--> statement-breakpoint
ALTER TABLE "deposit_settings" ADD CONSTRAINT "deposit_settings_usdt_min_check" CHECK ("deposit_settings"."usdt_min_deposit_usd_units" > 0 and "deposit_settings"."usdt_min_deposit_usd_units" % 10000 = 0);