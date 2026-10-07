CREATE TYPE "public"."adjustment_category" AS ENUM('compensation', 'correction', 'cash_refund', 'manual_deposit', 'test_funds');--> statement-breakpoint
CREATE TYPE "public"."adjustment_direction" AS ENUM('credit', 'debit');--> statement-breakpoint
CREATE TYPE "public"."manual_deposit_method" AS ENUM('sham_cash', 'usdt_trc20', 'usdt_bep20');--> statement-breakpoint
ALTER TYPE "public"."email_template" ADD VALUE 'customer_wallet_adjusted';--> statement-breakpoint
CREATE TABLE "wallet_adjustments" (
	"id" uuid PRIMARY KEY NOT NULL,
	"customer_id" uuid NOT NULL,
	"direction" "adjustment_direction" NOT NULL,
	"amount_usd_units" bigint NOT NULL,
	"category" "adjustment_category" NOT NULL,
	"customer_note" text,
	"reason" text NOT NULL,
	"deposit_method" "manual_deposit_method",
	"external_reference" text,
	"reverses_adjustment_id" uuid,
	"journal_id" uuid NOT NULL,
	"idempotency_key" uuid NOT NULL,
	"admin_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "wallet_adjustments_reverses_adjustment_id_unique" UNIQUE("reverses_adjustment_id"),
	CONSTRAINT "wallet_adjustments_journal_id_unique" UNIQUE("journal_id"),
	CONSTRAINT "wallet_adjustments_idempotency_key_unique" UNIQUE("idempotency_key"),
	CONSTRAINT "wallet_adjustments_amount_check" CHECK ("wallet_adjustments"."amount_usd_units" > 0 and "wallet_adjustments"."amount_usd_units" % 10000 = 0),
	CONSTRAINT "wallet_adjustments_reason_check" CHECK (char_length("wallet_adjustments"."reason") between 5 and 500),
	CONSTRAINT "wallet_adjustments_customer_note_check" CHECK (char_length("wallet_adjustments"."customer_note") between 1 and 200),
	CONSTRAINT "wallet_adjustments_external_reference_check" CHECK (char_length("wallet_adjustments"."external_reference") between 1 and 100),
	CONSTRAINT "wallet_adjustments_deposit_method_check" CHECK (("wallet_adjustments"."deposit_method" is not null) = ("wallet_adjustments"."category" = 'manual_deposit' and "wallet_adjustments"."reverses_adjustment_id" is null)),
	CONSTRAINT "wallet_adjustments_external_reference_method_check" CHECK (("wallet_adjustments"."external_reference" is not null) = ("wallet_adjustments"."deposit_method" is not null))
);
--> statement-breakpoint
ALTER TABLE "ledger_accounts" ADD COLUMN "customer_id" uuid;--> statement-breakpoint
ALTER TABLE "wallet_adjustments" ADD CONSTRAINT "wallet_adjustments_customer_id_customers_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wallet_adjustments" ADD CONSTRAINT "wallet_adjustments_reverses_adjustment_id_wallet_adjustments_id_fk" FOREIGN KEY ("reverses_adjustment_id") REFERENCES "public"."wallet_adjustments"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wallet_adjustments" ADD CONSTRAINT "wallet_adjustments_journal_id_ledger_journals_id_fk" FOREIGN KEY ("journal_id") REFERENCES "public"."ledger_journals"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "wallet_adjustments_customer_id_idx" ON "wallet_adjustments" USING btree ("customer_id","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "wallet_adjustments_admin_id_idx" ON "wallet_adjustments" USING btree ("admin_id");--> statement-breakpoint
CREATE UNIQUE INDEX "wallet_adjustments_external_reference_unique" ON "wallet_adjustments" USING btree ("deposit_method",upper("external_reference"));--> statement-breakpoint
ALTER TABLE "ledger_accounts" ADD CONSTRAINT "ledger_accounts_customer_id_customers_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ledger_accounts" ADD CONSTRAINT "ledger_accounts_customer_id_unique" UNIQUE("customer_id");--> statement-breakpoint
ALTER TABLE "ledger_accounts" ADD CONSTRAINT "ledger_accounts_customer_check" CHECK (("ledger_accounts"."customer_id" is not null) = ("ledger_accounts"."kind" = 'customer_wallet'));