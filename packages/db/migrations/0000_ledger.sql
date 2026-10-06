CREATE TYPE "public"."currency" AS ENUM('USD', 'SYP');--> statement-breakpoint
CREATE TYPE "public"."journal_kind" AS ENUM('deposit', 'purchase', 'refund', 'cost_of_goods', 'adjustment');--> statement-breakpoint
CREATE TYPE "public"."ledger_account_kind" AS ENUM('customer_wallet', 'sham_cash_receipts', 'usdt_receipts', 'supplier_prepaid', 'sales_revenue', 'cost_of_goods', 'refunds', 'adjustments');--> statement-breakpoint
CREATE TABLE "ledger_accounts" (
	"id" uuid PRIMARY KEY NOT NULL,
	"code" text NOT NULL,
	"kind" "ledger_account_kind" NOT NULL,
	"currency" "currency" NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"archived_at" timestamp with time zone,
	CONSTRAINT "ledger_accounts_code_unique" UNIQUE("code"),
	CONSTRAINT "ledger_accounts_id_currency_unique" UNIQUE("id","currency"),
	CONSTRAINT "ledger_accounts_code_check" CHECK (char_length("ledger_accounts"."code") between 1 and 200),
	CONSTRAINT "ledger_accounts_wallet_usd_check" CHECK ("ledger_accounts"."kind" <> 'customer_wallet' or "ledger_accounts"."currency" = 'USD')
);
--> statement-breakpoint
CREATE TABLE "ledger_journals" (
	"id" uuid PRIMARY KEY NOT NULL,
	"idempotency_key" text NOT NULL,
	"kind" "journal_kind" NOT NULL,
	"posting_count" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ledger_journals_idempotency_key_unique" UNIQUE("idempotency_key"),
	CONSTRAINT "ledger_journals_idempotency_key_check" CHECK (char_length("ledger_journals"."idempotency_key") between 1 and 200),
	CONSTRAINT "ledger_journals_posting_count_check" CHECK ("ledger_journals"."posting_count" >= 2)
);
--> statement-breakpoint
CREATE TABLE "ledger_postings" (
	"id" uuid PRIMARY KEY NOT NULL,
	"journal_id" uuid NOT NULL,
	"account_id" uuid NOT NULL,
	"currency" "currency" NOT NULL,
	"amount_units" bigint NOT NULL,
	CONSTRAINT "ledger_postings_amount_check" CHECK ("ledger_postings"."amount_units" <> 0)
);
--> statement-breakpoint
ALTER TABLE "ledger_postings" ADD CONSTRAINT "ledger_postings_journal_id_ledger_journals_id_fk" FOREIGN KEY ("journal_id") REFERENCES "public"."ledger_journals"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ledger_postings" ADD CONSTRAINT "ledger_postings_account_currency_fk" FOREIGN KEY ("account_id","currency") REFERENCES "public"."ledger_accounts"("id","currency") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "ledger_postings_journal_id_idx" ON "ledger_postings" USING btree ("journal_id");--> statement-breakpoint
CREATE INDEX "ledger_postings_account_id_idx" ON "ledger_postings" USING btree ("account_id","currency");