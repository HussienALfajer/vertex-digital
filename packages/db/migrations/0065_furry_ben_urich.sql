ALTER TYPE "public"."reconciliation_check" ADD VALUE 'supplier_charges' BEFORE 'count_stale';--> statement-breakpoint
ALTER TYPE "public"."supplier_call_operation" ADD VALUE 'get_offer';--> statement-breakpoint
ALTER TYPE "public"."supplier_call_operation" ADD VALUE 'test_connection';--> statement-breakpoint
ALTER TYPE "public"."telegram_message_kind" ADD VALUE 'supplier_charge_mismatch';--> statement-breakpoint
ALTER TABLE "fulfilment_attempts" ADD COLUMN "charged_usd_units" bigint;--> statement-breakpoint
ALTER TABLE "fulfilment_attempts" ADD COLUMN "cost_checked_usd_units" bigint;--> statement-breakpoint
ALTER TABLE "supplier_calls" ADD COLUMN "failure_kind" text;--> statement-breakpoint
ALTER TABLE "supplier_calls" ADD COLUMN "http_status" integer;--> statement-breakpoint
ALTER TABLE "supplier_cost_changes" ADD COLUMN "attempt_id" uuid;--> statement-breakpoint
ALTER TABLE "supplier_offers" ADD COLUMN "discount_bp" integer;--> statement-breakpoint
ALTER TABLE "supplier_policy" ADD COLUMN "recover_success_bp" integer DEFAULT 9500 NOT NULL;--> statement-breakpoint
ALTER TABLE "supplier_policy" ADD COLUMN "recover_minutes" integer DEFAULT 5 NOT NULL;--> statement-breakpoint
ALTER TABLE "supplier_sync_runs" ADD COLUMN "offers_read" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "supplier_sync_runs" ADD COLUMN "platform_status" text;--> statement-breakpoint
ALTER TABLE "supplier_sync_runs" ADD COLUMN "catalog_updated_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "supplier_cost_changes" ADD CONSTRAINT "supplier_cost_changes_attempt_id_fulfilment_attempts_id_fk" FOREIGN KEY ("attempt_id") REFERENCES "public"."fulfilment_attempts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "supplier_cost_changes_attempt_id_idx" ON "supplier_cost_changes" USING btree ("attempt_id");--> statement-breakpoint
ALTER TABLE "fulfilment_attempts" ADD CONSTRAINT "fulfilment_attempts_charged_check" CHECK ("fulfilment_attempts"."charged_usd_units" between 0 and 1000000000000);--> statement-breakpoint
ALTER TABLE "fulfilment_attempts" ADD CONSTRAINT "fulfilment_attempts_cost_checked_check" CHECK ("fulfilment_attempts"."cost_checked_usd_units" between 1 and 10000000000);--> statement-breakpoint
ALTER TABLE "supplier_calls" ADD CONSTRAINT "supplier_calls_failure_kind_check" CHECK ("supplier_calls"."failure_kind" in ('timeout', 'dns', 'connect', 'tls', 'rate_limited', 'http_5xx', 'http_4xx', 'unreadable', 'redirect', 'other'));--> statement-breakpoint
ALTER TABLE "supplier_calls" ADD CONSTRAINT "supplier_calls_http_status_check" CHECK ("supplier_calls"."http_status" between 100 and 599);--> statement-breakpoint
ALTER TABLE "supplier_offers" ADD CONSTRAINT "supplier_offers_discount_check" CHECK ("supplier_offers"."discount_bp" between 1 and 10000);--> statement-breakpoint
ALTER TABLE "supplier_policy" ADD CONSTRAINT "supplier_policy_recover_check" CHECK ("supplier_policy"."recover_success_bp" between "supplier_policy"."degraded_success_bp" and 10000
        and "supplier_policy"."recover_minutes" between 1 and 60);--> statement-breakpoint
ALTER TABLE "supplier_sync_runs" ADD CONSTRAINT "supplier_sync_runs_platform_status_check" CHECK (char_length("supplier_sync_runs"."platform_status") between 1 and 64);