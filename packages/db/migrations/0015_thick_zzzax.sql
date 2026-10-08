ALTER TABLE "deposits" DROP CONSTRAINT "deposits_decided_check";--> statement-breakpoint
ALTER TABLE "deposits" DROP CONSTRAINT "deposits_credit_check";--> statement-breakpoint
ALTER TABLE "deposits" ADD CONSTRAINT "deposits_method_check" CHECK ("deposits"."method" = 'sham_cash' or "deposits"."currency" = 'USD');--> statement-breakpoint
ALTER TABLE "deposits" ADD CONSTRAINT "deposits_decided_check" CHECK (("deposits"."status" in ('credited', 'rejected')) = ("deposits"."decided_at" is not null)
        and ("deposits"."status" in ('credited', 'rejected')) = ("deposits"."decided_by" is not null)
        and coalesce("deposits"."decided_by" = 'admin', false) = ("deposits"."admin_id" is not null)
        and coalesce("deposits"."decided_by" = 'admin', false) = ("deposits"."decision_idempotency_key" is not null));--> statement-breakpoint
ALTER TABLE "deposits" ADD CONSTRAINT "deposits_credit_check" CHECK (num_nonnulls("deposits"."transaction_number", "deposits"."received_currency", "deposits"."received_amount_units", "deposits"."credited_usd_units", "deposits"."journal_id")
          = case when "deposits"."status" = 'credited' then 5 else 0 end
        and ("deposits"."reference_check" is not null) = ("deposits"."status" = 'credited' and "deposits"."method" = 'sham_cash')
        and num_nonnulls("deposits"."credit_rate_id", "deposits"."credit_rate")
          = case when "deposits"."status" = 'credited' and "deposits"."received_currency" = 'SYP' then 2 else 0 end
        and ("deposits"."transaction_number" is null or char_length("deposits"."transaction_number") between 1 and 64)
        and ("deposits"."received_amount_units" is null or "deposits"."received_amount_units" > 0)
        and ("deposits"."credited_usd_units" is null or ("deposits"."credited_usd_units" > 0 and "deposits"."credited_usd_units" % 10000 = 0)));