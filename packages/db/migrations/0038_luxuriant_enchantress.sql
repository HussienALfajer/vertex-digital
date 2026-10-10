CREATE TYPE "public"."attempt_kind" AS ENUM('routed', 'admin_fulfil');--> statement-breakpoint
ALTER TYPE "public"."stored_file_kind" ADD VALUE 'delivery_proof';--> statement-breakpoint
ALTER TABLE "fulfilment_attempts" DROP CONSTRAINT "fulfilment_attempts_unit_cost_check";--> statement-breakpoint
ALTER TABLE "fulfilment_attempts" DROP CONSTRAINT "fulfilment_attempts_resolved_check";--> statement-breakpoint
ALTER TABLE "fulfilment_attempts" DROP CONSTRAINT "fulfilment_attempts_text_check";--> statement-breakpoint
ALTER TABLE "fulfilment_attempts" ALTER COLUMN "route_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "fulfilment_attempts" ALTER COLUMN "offer_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "fulfilment_attempts" ALTER COLUMN "supplier_offer_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "fulfilment_attempts" ADD COLUMN "kind" "attempt_kind" DEFAULT 'routed' NOT NULL;--> statement-breakpoint
ALTER TABLE "fulfilment_attempts" ADD COLUMN "chosen_by_admin" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "fulfilment_attempts" ADD COLUMN "proof_file_id" uuid;--> statement-breakpoint
ALTER TABLE "fulfilment_attempts" ADD COLUMN "delivery_reference" text;--> statement-breakpoint
ALTER TABLE "fulfilment_attempts" ADD CONSTRAINT "fulfilment_attempts_proof_file_id_stored_files_id_fk" FOREIGN KEY ("proof_file_id") REFERENCES "public"."stored_files"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fulfilment_attempts" ADD CONSTRAINT "fulfilment_attempts_proof_file_id_unique" UNIQUE("proof_file_id");--> statement-breakpoint
ALTER TABLE "fulfilment_attempts" ADD CONSTRAINT "fulfilment_attempts_kind_check" CHECK (case "fulfilment_attempts"."kind"
        when 'routed' then "fulfilment_attempts"."route_id" is not null and "fulfilment_attempts"."offer_id" is not null
          and "fulfilment_attempts"."supplier_offer_id" is not null
        else "fulfilment_attempts"."route_id" is null and "fulfilment_attempts"."offer_id" is null and "fulfilment_attempts"."supplier_offer_id" is null
          and "fulfilment_attempts"."status" = 'delivered' and "fulfilment_attempts"."resolved_by" = 'admin'
          and "fulfilment_attempts"."proof_file_id" is not null and not "fulfilment_attempts"."chosen_by_admin"
        end);--> statement-breakpoint
ALTER TABLE "fulfilment_attempts" ADD CONSTRAINT "fulfilment_attempts_unit_cost_check" CHECK ("fulfilment_attempts"."unit_cost_usd_units" >= 0
        and ("fulfilment_attempts"."kind" = 'admin_fulfil' or "fulfilment_attempts"."unit_cost_usd_units" > 0 or "fulfilment_attempts"."proof_file_id" is not null));--> statement-breakpoint
ALTER TABLE "fulfilment_attempts" ADD CONSTRAINT "fulfilment_attempts_resolved_check" CHECK (("fulfilment_attempts"."status" in ('delivered', 'failed')) = ("fulfilment_attempts"."resolved_at" is not null)
        and ("fulfilment_attempts"."resolved_at" is null) = ("fulfilment_attempts"."resolved_by" is null)
        and ("fulfilment_attempts"."cost_journal_id" is not null) = ("fulfilment_attempts"."status" = 'delivered' and "fulfilment_attempts"."unit_cost_usd_units" > 0)
        and (not "fulfilment_attempts"."input_rejected" or "fulfilment_attempts"."status" = 'failed')
        and ("fulfilment_attempts"."resolved_by" = 'admin') = ("fulfilment_attempts"."admin_reason" is not null));--> statement-breakpoint
ALTER TABLE "fulfilment_attempts" ADD CONSTRAINT "fulfilment_attempts_text_check" CHECK (char_length("fulfilment_attempts"."supplier_offer_id") between 1 and 128
        and char_length("fulfilment_attempts"."supplier_order_id") between 1 and 128
        and char_length("fulfilment_attempts"."failure_reason") between 1 and 200
        and char_length("fulfilment_attempts"."supplier_error_code") between 1 and 64
        and char_length("fulfilment_attempts"."admin_reason") between 5 and 500
        and char_length("fulfilment_attempts"."delivery_reference") between 1 and 200);