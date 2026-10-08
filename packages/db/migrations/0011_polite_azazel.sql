CREATE TYPE "public"."deposit_flag_code" AS ENUM('receipt_reused', 'receipt_similar', 'new_account_large', 'velocity', 'shared_phone', 'amount_mismatch', 'reference_missing', 'reference_different');--> statement-breakpoint
CREATE TYPE "public"."deposit_method" AS ENUM('sham_cash');--> statement-breakpoint
CREATE TYPE "public"."deposit_reference_check" AS ENUM('matches', 'missing', 'different');--> statement-breakpoint
CREATE TYPE "public"."deposit_reject_reason" AS ENUM('not_received', 'receipt_invalid', 'receipt_used', 'reference_other_customer', 'wrong_account', 'other');--> statement-breakpoint
CREATE TYPE "public"."deposit_status" AS ENUM('pending', 'submitted', 'credited', 'rejected', 'expired', 'cancelled');--> statement-breakpoint
CREATE TYPE "public"."stored_file_kind" AS ENUM('deposit_receipt', 'sham_cash_qr');--> statement-breakpoint
ALTER TYPE "public"."email_template" ADD VALUE 'customer_deposit_credited';--> statement-breakpoint
ALTER TYPE "public"."email_template" ADD VALUE 'customer_deposit_rejected';--> statement-breakpoint
ALTER TYPE "public"."email_template" ADD VALUE 'customer_deposit_receipt_requested';--> statement-breakpoint
ALTER TYPE "public"."ledger_account_kind" ADD VALUE 'currency_exchange';--> statement-breakpoint
CREATE TABLE "deposit_flags" (
	"id" uuid PRIMARY KEY NOT NULL,
	"deposit_id" uuid NOT NULL,
	"code" "deposit_flag_code" NOT NULL,
	"receipt_id" uuid,
	"details" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "deposit_flags_once_unique" UNIQUE NULLS NOT DISTINCT("deposit_id","code","receipt_id")
);
--> statement-breakpoint
CREATE TABLE "deposit_receipts" (
	"id" uuid PRIMARY KEY NOT NULL,
	"deposit_id" uuid NOT NULL,
	"file_id" uuid NOT NULL,
	"original_sha256" "bytea" NOT NULL,
	"perceptual_hash" bigint NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "deposit_receipts_file_id_unique" UNIQUE("file_id"),
	CONSTRAINT "deposit_receipts_sha256_check" CHECK (octet_length("deposit_receipts"."original_sha256") = 32)
);
--> statement-breakpoint
CREATE TABLE "deposit_settings" (
	"id" uuid PRIMARY KEY NOT NULL,
	"sham_cash_account_name" text NOT NULL,
	"sham_cash_account_number" text NOT NULL,
	"syp_enabled" boolean NOT NULL,
	"usd_enabled" boolean NOT NULL,
	"syp_qr_file_id" uuid,
	"usd_qr_file_id" uuid,
	"min_deposit_usd_units" bigint NOT NULL,
	"new_account_per_deposit_usd_units" bigint NOT NULL,
	"new_account_daily_usd_units" bigint NOT NULL,
	"established_per_deposit_usd_units" bigint NOT NULL,
	"established_daily_usd_units" bigint NOT NULL,
	"review_hours_start" time NOT NULL,
	"review_hours_end" time NOT NULL,
	"review_target_minutes" integer NOT NULL,
	"flag_new_account_usd_units" bigint NOT NULL,
	"flag_velocity_count" integer NOT NULL,
	"admin_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "deposit_settings_account_check" CHECK (char_length("deposit_settings"."sham_cash_account_name") between 1 and 100 and char_length("deposit_settings"."sham_cash_account_number") between 1 and 64),
	CONSTRAINT "deposit_settings_qr_check" CHECK ((not "deposit_settings"."syp_enabled" or "deposit_settings"."syp_qr_file_id" is not null) and (not "deposit_settings"."usd_enabled" or "deposit_settings"."usd_qr_file_id" is not null)),
	CONSTRAINT "deposit_settings_limits_check" CHECK ("deposit_settings"."min_deposit_usd_units" > 0 and "deposit_settings"."min_deposit_usd_units" % 10000 = 0 and "deposit_settings"."new_account_per_deposit_usd_units" > 0 and "deposit_settings"."new_account_per_deposit_usd_units" % 10000 = 0
        and "deposit_settings"."new_account_daily_usd_units" > 0 and "deposit_settings"."new_account_daily_usd_units" % 10000 = 0 and "deposit_settings"."established_per_deposit_usd_units" > 0 and "deposit_settings"."established_per_deposit_usd_units" % 10000 = 0
        and "deposit_settings"."established_daily_usd_units" > 0 and "deposit_settings"."established_daily_usd_units" % 10000 = 0 and "deposit_settings"."flag_new_account_usd_units" > 0 and "deposit_settings"."flag_new_account_usd_units" % 10000 = 0
        and "deposit_settings"."min_deposit_usd_units" <= "deposit_settings"."new_account_per_deposit_usd_units"
        and "deposit_settings"."new_account_per_deposit_usd_units" <= "deposit_settings"."new_account_daily_usd_units"
        and "deposit_settings"."min_deposit_usd_units" <= "deposit_settings"."established_per_deposit_usd_units"
        and "deposit_settings"."established_per_deposit_usd_units" <= "deposit_settings"."established_daily_usd_units"),
	CONSTRAINT "deposit_settings_hours_check" CHECK ("deposit_settings"."review_hours_start" < "deposit_settings"."review_hours_end" and "deposit_settings"."review_target_minutes" between 1 and 1440),
	CONSTRAINT "deposit_settings_velocity_check" CHECK ("deposit_settings"."flag_velocity_count" between 1 and 50)
);
--> statement-breakpoint
CREATE TABLE "deposits" (
	"id" uuid PRIMARY KEY NOT NULL,
	"customer_id" uuid NOT NULL,
	"method" "deposit_method" NOT NULL,
	"status" "deposit_status" DEFAULT 'pending' NOT NULL,
	"reference_code" text NOT NULL,
	"currency" "currency" NOT NULL,
	"declared_amount_units" bigint NOT NULL,
	"declared_usd_units" bigint NOT NULL,
	"rate_id" uuid,
	"rate" numeric(12, 4),
	"quote_expires_at" timestamp with time zone,
	"rate_fixed_at" timestamp with time zone,
	"expires_at" timestamp with time zone NOT NULL,
	"receipt_requested_at" timestamp with time zone,
	"receipt_request_count" smallint DEFAULT 0 NOT NULL,
	"receipt_request_note" text,
	"submitted_at" timestamp with time zone,
	"decided_at" timestamp with time zone,
	"transaction_number" text,
	"received_currency" "currency",
	"received_amount_units" bigint,
	"credited_usd_units" bigint,
	"credit_rate_id" uuid,
	"credit_rate" numeric(12, 4),
	"reference_check" "deposit_reference_check",
	"journal_id" uuid,
	"reject_reason" "deposit_reject_reason",
	"customer_note" text,
	"idempotency_key" uuid NOT NULL,
	"decision_idempotency_key" uuid,
	"admin_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "deposits_reference_code_unique" UNIQUE("reference_code"),
	CONSTRAINT "deposits_journal_id_unique" UNIQUE("journal_id"),
	CONSTRAINT "deposits_idempotency_key_unique" UNIQUE("idempotency_key"),
	CONSTRAINT "deposits_decision_idempotency_key_unique" UNIQUE("decision_idempotency_key"),
	CONSTRAINT "deposits_reference_code_check" CHECK ("deposits"."reference_code" ~ '^VD-[23456789ABCDEFGHJKMNPQRSTUVWXYZ]{5}$'),
	CONSTRAINT "deposits_declared_check" CHECK ("deposits"."declared_amount_units" > 0
        and "deposits"."declared_amount_units" % (case "deposits"."currency" when 'SYP' then 100 else 10000 end) = 0
        and "deposits"."declared_usd_units" >= 0 and "deposits"."declared_usd_units" % 10000 = 0),
	CONSTRAINT "deposits_quote_check" CHECK (num_nonnulls("deposits"."rate_id", "deposits"."rate", "deposits"."quote_expires_at") = case "deposits"."currency" when 'SYP' then 3 else 0 end
        and ("deposits"."rate" is null or "deposits"."rate" > 0)
        and ("deposits"."rate_fixed_at" is null or "deposits"."currency" = 'SYP')),
	CONSTRAINT "deposits_receipt_request_check" CHECK ("deposits"."receipt_request_count" between 0 and 1
        and ("deposits"."receipt_requested_at" is not null) = ("deposits"."receipt_request_count" = 1)
        and ("deposits"."receipt_request_note" is null or ("deposits"."receipt_requested_at" is not null and char_length("deposits"."receipt_request_note") between 1 and 300))),
	CONSTRAINT "deposits_submitted_check" CHECK ("deposits"."status" not in ('submitted', 'credited', 'rejected') or "deposits"."submitted_at" is not null),
	CONSTRAINT "deposits_decided_check" CHECK (("deposits"."status" in ('credited', 'rejected')) = ("deposits"."decided_at" is not null)
        and ("deposits"."status" in ('credited', 'rejected')) = ("deposits"."admin_id" is not null)
        and ("deposits"."status" in ('credited', 'rejected')) = ("deposits"."decision_idempotency_key" is not null)),
	CONSTRAINT "deposits_credit_check" CHECK (num_nonnulls("deposits"."transaction_number", "deposits"."received_currency", "deposits"."received_amount_units", "deposits"."credited_usd_units", "deposits"."reference_check", "deposits"."journal_id")
          = case when "deposits"."status" = 'credited' then 6 else 0 end
        and num_nonnulls("deposits"."credit_rate_id", "deposits"."credit_rate")
          = case when "deposits"."status" = 'credited' and "deposits"."received_currency" = 'SYP' then 2 else 0 end
        and ("deposits"."transaction_number" is null or char_length("deposits"."transaction_number") between 1 and 64)
        and ("deposits"."received_amount_units" is null or "deposits"."received_amount_units" > 0)
        and ("deposits"."credited_usd_units" is null or ("deposits"."credited_usd_units" > 0 and "deposits"."credited_usd_units" % 10000 = 0))),
	CONSTRAINT "deposits_rejection_check" CHECK (("deposits"."reject_reason" is not null) = ("deposits"."status" = 'rejected')
        and ("deposits"."customer_note" is null or ("deposits"."status" = 'rejected' and char_length("deposits"."customer_note") between 1 and 300))
        and ("deposits"."reject_reason" <> 'other' or "deposits"."customer_note" is not null))
);
--> statement-breakpoint
CREATE TABLE "stored_files" (
	"id" uuid PRIMARY KEY NOT NULL,
	"kind" "stored_file_kind" NOT NULL,
	"storage_key" text NOT NULL,
	"content_type" text NOT NULL,
	"byte_size" integer NOT NULL,
	"width" integer NOT NULL,
	"height" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "stored_files_storage_key_unique" UNIQUE("storage_key"),
	CONSTRAINT "stored_files_storage_key_check" CHECK ("stored_files"."storage_key" ~ '^[a-z_]+/[0-9a-f]{2}/[0-9a-f-]{36}\.(webp|png)$'),
	CONSTRAINT "stored_files_content_type_check" CHECK ("stored_files"."content_type" in ('image/webp', 'image/png')),
	CONSTRAINT "stored_files_size_check" CHECK ("stored_files"."byte_size" > 0 and "stored_files"."width" > 0 and "stored_files"."height" > 0)
);
--> statement-breakpoint
ALTER TABLE "payment_references" DROP CONSTRAINT "payment_references_owner_check";--> statement-breakpoint
ALTER TABLE "payment_references" ADD COLUMN "deposit_id" uuid;--> statement-breakpoint
ALTER TABLE "deposit_flags" ADD CONSTRAINT "deposit_flags_deposit_id_deposits_id_fk" FOREIGN KEY ("deposit_id") REFERENCES "public"."deposits"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "deposit_flags" ADD CONSTRAINT "deposit_flags_receipt_id_deposit_receipts_id_fk" FOREIGN KEY ("receipt_id") REFERENCES "public"."deposit_receipts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "deposit_receipts" ADD CONSTRAINT "deposit_receipts_deposit_id_deposits_id_fk" FOREIGN KEY ("deposit_id") REFERENCES "public"."deposits"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "deposit_receipts" ADD CONSTRAINT "deposit_receipts_file_id_stored_files_id_fk" FOREIGN KEY ("file_id") REFERENCES "public"."stored_files"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "deposit_settings" ADD CONSTRAINT "deposit_settings_syp_qr_file_id_stored_files_id_fk" FOREIGN KEY ("syp_qr_file_id") REFERENCES "public"."stored_files"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "deposit_settings" ADD CONSTRAINT "deposit_settings_usd_qr_file_id_stored_files_id_fk" FOREIGN KEY ("usd_qr_file_id") REFERENCES "public"."stored_files"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "deposits" ADD CONSTRAINT "deposits_customer_id_customers_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "deposits" ADD CONSTRAINT "deposits_rate_id_exchange_rates_id_fk" FOREIGN KEY ("rate_id") REFERENCES "public"."exchange_rates"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "deposits" ADD CONSTRAINT "deposits_credit_rate_id_exchange_rates_id_fk" FOREIGN KEY ("credit_rate_id") REFERENCES "public"."exchange_rates"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "deposits" ADD CONSTRAINT "deposits_journal_id_ledger_journals_id_fk" FOREIGN KEY ("journal_id") REFERENCES "public"."ledger_journals"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "deposit_flags_receipt_id_idx" ON "deposit_flags" USING btree ("receipt_id");--> statement-breakpoint
CREATE INDEX "deposit_receipts_deposit_id_idx" ON "deposit_receipts" USING btree ("deposit_id","created_at");--> statement-breakpoint
CREATE INDEX "deposit_receipts_original_sha256_idx" ON "deposit_receipts" USING btree ("original_sha256");--> statement-breakpoint
CREATE INDEX "deposit_settings_created_at_idx" ON "deposit_settings" USING btree ("created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "deposit_settings_syp_qr_file_id_idx" ON "deposit_settings" USING btree ("syp_qr_file_id");--> statement-breakpoint
CREATE INDEX "deposit_settings_usd_qr_file_id_idx" ON "deposit_settings" USING btree ("usd_qr_file_id");--> statement-breakpoint
CREATE INDEX "deposits_customer_id_idx" ON "deposits" USING btree ("customer_id","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE UNIQUE INDEX "deposits_one_pending_unique" ON "deposits" USING btree ("customer_id") WHERE "deposits"."status" = 'pending';--> statement-breakpoint
CREATE INDEX "deposits_queue_idx" ON "deposits" USING btree ("status","submitted_at");--> statement-breakpoint
CREATE INDEX "deposits_expiry_idx" ON "deposits" USING btree ("status","expires_at");--> statement-breakpoint
CREATE INDEX "deposits_rate_id_idx" ON "deposits" USING btree ("rate_id");--> statement-breakpoint
CREATE INDEX "deposits_credit_rate_id_idx" ON "deposits" USING btree ("credit_rate_id");--> statement-breakpoint
CREATE INDEX "deposits_admin_id_idx" ON "deposits" USING btree ("admin_id");--> statement-breakpoint
ALTER TABLE "payment_references" ADD CONSTRAINT "payment_references_deposit_id_deposits_id_fk" FOREIGN KEY ("deposit_id") REFERENCES "public"."deposits"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payment_references" ADD CONSTRAINT "payment_references_deposit_id_unique" UNIQUE("deposit_id");--> statement-breakpoint
ALTER TABLE "payment_references" ADD CONSTRAINT "payment_references_owner_check" CHECK (num_nonnulls("payment_references"."wallet_adjustment_id", "payment_references"."deposit_id") = 1);