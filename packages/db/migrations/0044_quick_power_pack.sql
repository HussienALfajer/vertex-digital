CREATE TYPE "public"."reconciliation_check" AS ENUM('journal_balance', 'ledger_total', 'wallet_non_negative', 'account_journal_kinds', 'attempt_cost', 'order_purchase', 'order_refund', 'deposit_credit', 'manual_journals', 'supplier_balance', 'usdt_balance', 'sham_cash_count', 'count_stale', 'order_conflicts');--> statement-breakpoint
CREATE TYPE "public"."reconciliation_result_status" AS ENUM('ok', 'mismatch', 'warning', 'skipped');--> statement-breakpoint
CREATE TYPE "public"."reconciliation_run_status" AS ENUM('running', 'finished', 'failed');--> statement-breakpoint
CREATE TYPE "public"."reconciliation_run_trigger" AS ENUM('schedule', 'manual', 'count');--> statement-breakpoint
CREATE TYPE "public"."outside_category" AS ENUM('owner', 'unclaimed_receipt', 'return_to_sender', 'other');--> statement-breakpoint
CREATE TYPE "public"."treasury_movement_kind" AS ENUM('transfer', 'supplier_correction');--> statement-breakpoint
ALTER TYPE "public"."journal_kind" ADD VALUE 'treasury';--> statement-breakpoint
ALTER TYPE "public"."ledger_account_kind" ADD VALUE 'outside_funds';--> statement-breakpoint
ALTER TYPE "public"."ledger_account_kind" ADD VALUE 'transfer_fees';--> statement-breakpoint
ALTER TYPE "public"."ledger_account_kind" ADD VALUE 'supplier_corrections';--> statement-breakpoint
CREATE TABLE "reconciliation_explanations" (
	"id" uuid PRIMARY KEY NOT NULL,
	"result_id" uuid NOT NULL,
	"note" text NOT NULL,
	"admin_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
	CONSTRAINT "reconciliation_explanations_result_id_unique" UNIQUE("result_id"),
	CONSTRAINT "reconciliation_explanations_note_check" CHECK (char_length("reconciliation_explanations"."note") between 5 and 500)
);
--> statement-breakpoint
CREATE TABLE "reconciliation_results" (
	"id" uuid PRIMARY KEY NOT NULL,
	"run_id" uuid NOT NULL,
	"check" "reconciliation_check" NOT NULL,
	"subject" text NOT NULL,
	"status" "reconciliation_result_status" NOT NULL,
	"currency" "currency",
	"books_units" bigint,
	"actual_units" bigint,
	"difference_units" bigint,
	"allowed_low_units" bigint,
	"allowed_high_units" bigint,
	"offending_count" integer DEFAULT 0 NOT NULL,
	"details" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
	CONSTRAINT "reconciliation_results_run_check_subject_unique" UNIQUE("run_id","check","subject"),
	CONSTRAINT "reconciliation_results_subject_check" CHECK (char_length("reconciliation_results"."subject") between 1 and 100),
	CONSTRAINT "reconciliation_results_offending_check" CHECK ("reconciliation_results"."offending_count" >= 0),
	CONSTRAINT "reconciliation_results_range_check" CHECK ("reconciliation_results"."allowed_low_units" is null or "reconciliation_results"."allowed_high_units" is null or "reconciliation_results"."allowed_low_units" <= "reconciliation_results"."allowed_high_units")
);
--> statement-breakpoint
CREATE TABLE "reconciliation_runs" (
	"id" uuid PRIMARY KEY NOT NULL,
	"trigger" "reconciliation_run_trigger" NOT NULL,
	"business_date" date,
	"status" "reconciliation_run_status" DEFAULT 'running' NOT NULL,
	"started_at" timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
	"finished_at" timestamp with time zone,
	"snapshot_position" bigint,
	"mismatch_count" integer DEFAULT 0 NOT NULL,
	"warning_count" integer DEFAULT 0 NOT NULL,
	"recheck_at" timestamp with time zone,
	"failure" text,
	"admin_id" uuid,
	"alerted_at" timestamp with time zone,
	"idempotency_key" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "reconciliation_runs_idempotency_key_unique" UNIQUE("idempotency_key"),
	CONSTRAINT "reconciliation_runs_business_date_check" CHECK (("reconciliation_runs"."business_date" is not null) = ("reconciliation_runs"."trigger" = 'schedule')),
	CONSTRAINT "reconciliation_runs_admin_check" CHECK (("reconciliation_runs"."admin_id" is not null) = ("reconciliation_runs"."trigger" <> 'schedule')),
	CONSTRAINT "reconciliation_runs_idempotency_key_check" CHECK (("reconciliation_runs"."idempotency_key" is not null) = ("reconciliation_runs"."trigger" = 'count')),
	CONSTRAINT "reconciliation_runs_finished_check" CHECK (("reconciliation_runs"."status" = 'running') = ("reconciliation_runs"."finished_at" is null)),
	CONSTRAINT "reconciliation_runs_counts_check" CHECK ("reconciliation_runs"."mismatch_count" >= 0 and "reconciliation_runs"."warning_count" >= 0),
	CONSTRAINT "reconciliation_runs_failure_check" CHECK (char_length("reconciliation_runs"."failure") <= 500)
);
--> statement-breakpoint
CREATE TABLE "reconciliation_settings" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tolerance_usd_units" bigint NOT NULL,
	"count_stale_days" integer NOT NULL,
	"admin_id" uuid,
	"created_at" timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
	CONSTRAINT "reconciliation_settings_bounds_check" CHECK ("reconciliation_settings"."tolerance_usd_units" between 0 and 100000000
        and "reconciliation_settings"."tolerance_usd_units" % 10000 = 0
        and "reconciliation_settings"."count_stale_days" between 1 and 60)
);
--> statement-breakpoint
CREATE TABLE "treasury_movements" (
	"id" uuid PRIMARY KEY NOT NULL,
	"kind" "treasury_movement_kind" NOT NULL,
	"from_account_id" uuid NOT NULL,
	"sent_units" bigint NOT NULL,
	"sent_currency" "currency" NOT NULL,
	"to_account_id" uuid NOT NULL,
	"received_units" bigint NOT NULL,
	"received_currency" "currency" NOT NULL,
	"rate" numeric(16, 4),
	"outside_category" "outside_category",
	"opening_balance" boolean DEFAULT false NOT NULL,
	"order_id" uuid,
	"external_reference" text,
	"reason" text NOT NULL,
	"reverses_movement_id" uuid,
	"journal_id" uuid NOT NULL,
	"idempotency_key" uuid NOT NULL,
	"admin_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "treasury_movements_reverses_movement_id_unique" UNIQUE("reverses_movement_id"),
	CONSTRAINT "treasury_movements_journal_id_unique" UNIQUE("journal_id"),
	CONSTRAINT "treasury_movements_idempotency_key_unique" UNIQUE("idempotency_key"),
	CONSTRAINT "treasury_movements_accounts_check" CHECK ("treasury_movements"."from_account_id" <> "treasury_movements"."to_account_id"),
	CONSTRAINT "treasury_movements_amounts_check" CHECK ("treasury_movements"."sent_units" > 0 and "treasury_movements"."received_units" > 0),
	CONSTRAINT "treasury_movements_rate_check" CHECK (("treasury_movements"."rate" is null) = ("treasury_movements"."sent_currency" = "treasury_movements"."received_currency")),
	CONSTRAINT "treasury_movements_same_currency_check" CHECK ("treasury_movements"."sent_currency" <> "treasury_movements"."received_currency" or "treasury_movements"."received_units" <= "treasury_movements"."sent_units"),
	CONSTRAINT "treasury_movements_correction_check" CHECK ("treasury_movements"."kind" = 'transfer' or ("treasury_movements"."sent_units" = "treasury_movements"."received_units" and "treasury_movements"."sent_currency" = 'USD' and "treasury_movements"."received_currency" = 'USD' and not "treasury_movements"."opening_balance")),
	CONSTRAINT "treasury_movements_order_check" CHECK ("treasury_movements"."order_id" is null or "treasury_movements"."kind" = 'supplier_correction'),
	CONSTRAINT "treasury_movements_opening_check" CHECK (not "treasury_movements"."opening_balance" or ("treasury_movements"."outside_category" = 'owner' and "treasury_movements"."reverses_movement_id" is null)),
	CONSTRAINT "treasury_movements_reason_check" CHECK (char_length("treasury_movements"."reason") between 5 and 500),
	CONSTRAINT "treasury_movements_external_reference_check" CHECK (char_length("treasury_movements"."external_reference") between 1 and 100)
);
--> statement-breakpoint
ALTER TABLE "reconciliation_explanations" ADD CONSTRAINT "reconciliation_explanations_result_id_reconciliation_results_id_fk" FOREIGN KEY ("result_id") REFERENCES "public"."reconciliation_results"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reconciliation_results" ADD CONSTRAINT "reconciliation_results_run_id_reconciliation_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."reconciliation_runs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "treasury_movements" ADD CONSTRAINT "treasury_movements_order_id_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."orders"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "treasury_movements" ADD CONSTRAINT "treasury_movements_reverses_movement_id_treasury_movements_id_fk" FOREIGN KEY ("reverses_movement_id") REFERENCES "public"."treasury_movements"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "treasury_movements" ADD CONSTRAINT "treasury_movements_journal_id_ledger_journals_id_fk" FOREIGN KEY ("journal_id") REFERENCES "public"."ledger_journals"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "treasury_movements" ADD CONSTRAINT "treasury_movements_from_account_fk" FOREIGN KEY ("from_account_id","sent_currency") REFERENCES "public"."ledger_accounts"("id","currency") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "treasury_movements" ADD CONSTRAINT "treasury_movements_to_account_fk" FOREIGN KEY ("to_account_id","received_currency") REFERENCES "public"."ledger_accounts"("id","currency") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "reconciliation_explanations_admin_id_idx" ON "reconciliation_explanations" USING btree ("admin_id");--> statement-breakpoint
CREATE INDEX "reconciliation_results_check_subject_idx" ON "reconciliation_results" USING btree ("check","subject","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE UNIQUE INDEX "reconciliation_runs_business_date_unique" ON "reconciliation_runs" USING btree ("business_date") WHERE "reconciliation_runs"."business_date" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "reconciliation_runs_running_idx" ON "reconciliation_runs" USING btree ("status") WHERE "reconciliation_runs"."status" = 'running';--> statement-breakpoint
CREATE INDEX "reconciliation_runs_trigger_started_at_idx" ON "reconciliation_runs" USING btree ("trigger","started_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "reconciliation_runs_started_at_idx" ON "reconciliation_runs" USING btree ("started_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "reconciliation_runs_admin_id_idx" ON "reconciliation_runs" USING btree ("admin_id");--> statement-breakpoint
CREATE INDEX "reconciliation_settings_created_at_idx" ON "reconciliation_settings" USING btree ("created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "reconciliation_settings_admin_id_idx" ON "reconciliation_settings" USING btree ("admin_id");--> statement-breakpoint
CREATE INDEX "treasury_movements_created_at_idx" ON "treasury_movements" USING btree ("created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "treasury_movements_from_account_id_idx" ON "treasury_movements" USING btree ("from_account_id","sent_currency");--> statement-breakpoint
CREATE INDEX "treasury_movements_to_account_id_idx" ON "treasury_movements" USING btree ("to_account_id","received_currency");--> statement-breakpoint
CREATE INDEX "treasury_movements_order_id_idx" ON "treasury_movements" USING btree ("order_id");--> statement-breakpoint
CREATE INDEX "treasury_movements_admin_id_idx" ON "treasury_movements" USING btree ("admin_id");--> statement-breakpoint
CREATE UNIQUE INDEX "treasury_movements_external_reference_unique" ON "treasury_movements" USING btree ("from_account_id",upper("external_reference")) WHERE "treasury_movements"."external_reference" is not null and "treasury_movements"."reverses_movement_id" is null;--> statement-breakpoint
CREATE INDEX "deposits_status_decided_at_idx" ON "deposits" USING btree ("status","decided_at");--> statement-breakpoint
CREATE INDEX "fulfilment_attempts_resolved_at_idx" ON "fulfilment_attempts" USING btree ("resolved_at");