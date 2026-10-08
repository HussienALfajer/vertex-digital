CREATE TYPE "public"."payment_method" AS ENUM('sham_cash', 'usdt_trc20', 'usdt_bep20');--> statement-breakpoint
CREATE TABLE "exchange_rates" (
	"id" uuid PRIMARY KEY NOT NULL,
	"syp_per_usd" numeric(12, 4) NOT NULL,
	"display_step_syp_units" bigint NOT NULL,
	"admin_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "exchange_rates_rate_check" CHECK ("exchange_rates"."syp_per_usd" > 0),
	CONSTRAINT "exchange_rates_display_step_check" CHECK ("exchange_rates"."display_step_syp_units" between 100 and 5000 and "exchange_rates"."display_step_syp_units" % 100 = 0)
);
--> statement-breakpoint
CREATE TABLE "payment_references" (
	"id" uuid PRIMARY KEY NOT NULL,
	"method" "payment_method" NOT NULL,
	"reference" text NOT NULL,
	"wallet_adjustment_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "payment_references_wallet_adjustment_id_unique" UNIQUE("wallet_adjustment_id"),
	CONSTRAINT "payment_references_method_reference_unique" UNIQUE("method","reference"),
	CONSTRAINT "payment_references_reference_check" CHECK (char_length("payment_references"."reference") between 1 and 100 and "payment_references"."reference" = upper(btrim("payment_references"."reference"))),
	CONSTRAINT "payment_references_owner_check" CHECK (num_nonnulls("payment_references"."wallet_adjustment_id") = 1)
);
--> statement-breakpoint
ALTER TABLE "payment_references" ADD CONSTRAINT "payment_references_wallet_adjustment_id_wallet_adjustments_id_fk" FOREIGN KEY ("wallet_adjustment_id") REFERENCES "public"."wallet_adjustments"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "exchange_rates_created_at_idx" ON "exchange_rates" USING btree ("created_at" DESC NULLS LAST);