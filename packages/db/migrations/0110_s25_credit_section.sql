-- S25 PR 1 (spec docs/specs/S25-zddk-supplier-and-syrian-credit.md, ADR 0039): the supplier
-- jneedcontur as data, the `amount` product kind, the recipient number types, the section's
-- service classes, the cash hold and the credit policy. Written by hand (`generate --custom`) so
-- the checks compare `kind` as text: a value added with `ALTER TYPE ... ADD VALUE` cannot be read
-- before the transaction commits, and drizzle applies pending migrations in one transaction.
CREATE TYPE "public"."service_class" AS ENUM('none', 'credit', 'cash');--> statement-breakpoint
CREATE TYPE "public"."cash_hold_state" AS ENUM('held', 'approved', 'rejected', 'expired');--> statement-breakpoint
ALTER TYPE "public"."input_field_type" ADD VALUE 'syriatel_number';--> statement-breakpoint
ALTER TYPE "public"."input_field_type" ADD VALUE 'mtn_number';--> statement-breakpoint
ALTER TYPE "public"."product_kind" ADD VALUE 'amount';--> statement-breakpoint
ALTER TYPE "public"."order_cancel_reason" ADD VALUE 'limit_reached';--> statement-breakpoint
ALTER TYPE "public"."refund_reason" ADD VALUE 'cash_rejected';--> statement-breakpoint
ALTER TYPE "public"."store_switch" ADD VALUE 'jneedcontur_paused' BEFORE 'manual_paused';--> statement-breakpoint
CREATE TABLE "credit_policy" (
	"id" uuid PRIMARY KEY NOT NULL,
	"retail_daily_usd_units" bigint NOT NULL,
	"merchant_daily_usd_units" bigint NOT NULL,
	"recipient_daily_orders_retail" integer NOT NULL,
	"recipient_daily_orders_merchant" integer NOT NULL,
	"recipient_accounts_alert" integer NOT NULL,
	"recipient_alert_days" integer NOT NULL,
	"cash_retail_daily_usd_units" bigint NOT NULL,
	"cash_merchant_daily_usd_units" bigint NOT NULL,
	"cash_retail_approval_above_usd_units" bigint NOT NULL,
	"cash_merchant_approval_above_usd_units" bigint NOT NULL,
	"cash_balance_age_hours" integer NOT NULL,
	"cash_hold_hours" integer NOT NULL,
	"cash_telegram_ceiling_usd_units" bigint NOT NULL,
	"admin_id" uuid,
	"created_at" timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
	CONSTRAINT "credit_policy_bounds_check" CHECK ("credit_policy"."retail_daily_usd_units" between 0 and 100000000000 and "credit_policy"."retail_daily_usd_units" % 10000 = 0
        and "credit_policy"."merchant_daily_usd_units" between 0 and 100000000000 and "credit_policy"."merchant_daily_usd_units" % 10000 = 0
        and "credit_policy"."cash_retail_daily_usd_units" between 0 and 100000000000 and "credit_policy"."cash_retail_daily_usd_units" % 10000 = 0
        and "credit_policy"."cash_merchant_daily_usd_units" between 0 and 100000000000 and "credit_policy"."cash_merchant_daily_usd_units" % 10000 = 0
        and "credit_policy"."cash_retail_approval_above_usd_units" between 0 and 100000000000 and "credit_policy"."cash_retail_approval_above_usd_units" % 10000 = 0
        and "credit_policy"."cash_merchant_approval_above_usd_units" between 0 and 100000000000 and "credit_policy"."cash_merchant_approval_above_usd_units" % 10000 = 0
        and "credit_policy"."cash_telegram_ceiling_usd_units" between 0 and 100000000000 and "credit_policy"."cash_telegram_ceiling_usd_units" % 10000 = 0
        and "credit_policy"."recipient_daily_orders_retail" between 0 and 1000
        and "credit_policy"."recipient_daily_orders_merchant" between 0 and 1000
        and "credit_policy"."recipient_accounts_alert" between 0 and 1000
        and "credit_policy"."recipient_alert_days" between 1 and 90
        and "credit_policy"."cash_balance_age_hours" between 0 and 720
        and "credit_policy"."cash_hold_hours" between 0 and 720)
);
--> statement-breakpoint
ALTER TABLE "catalog_products" DROP CONSTRAINT "catalog_products_max_quantity_check";--> statement-breakpoint
ALTER TABLE "fulfilment_attempts" DROP CONSTRAINT "fulfilment_attempts_quantity_check";--> statement-breakpoint
ALTER TABLE "orders" DROP CONSTRAINT "orders_quantity_check";--> statement-breakpoint
ALTER TABLE "supplier_offers" DROP CONSTRAINT "supplier_offers_unsupported_reason_check";--> statement-breakpoint
ALTER TABLE "catalog_games" ADD COLUMN "service_class" "service_class" DEFAULT 'none' NOT NULL;--> statement-breakpoint
ALTER TABLE "catalog_products" ADD COLUMN "min_quantity" integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "catalog_products" ADD COLUMN "amount_unit_ar" text;--> statement-breakpoint
ALTER TABLE "catalog_products" ADD COLUMN "amount_step" integer;--> statement-breakpoint
ALTER TABLE "orders" ADD COLUMN "recipient" text;--> statement-breakpoint
ALTER TABLE "orders" ADD COLUMN "cash_hold" "cash_hold_state";--> statement-breakpoint
ALTER TABLE "orders" ADD COLUMN "cash_hold_decided_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "orders" ADD COLUMN "cash_hold_admin_id" uuid;--> statement-breakpoint
CREATE INDEX "credit_policy_created_at_idx" ON "credit_policy" USING btree ("created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "orders_recipient_created_at_idx" ON "orders" USING btree ("recipient","created_at") WHERE "orders"."recipient" is not null;--> statement-breakpoint
CREATE INDEX "orders_cash_held_paid_at_idx" ON "orders" USING btree ("paid_at") WHERE "orders"."cash_hold" = 'held';--> statement-breakpoint
ALTER TABLE "catalog_products" ADD CONSTRAINT "catalog_products_amount_check" CHECK (case "catalog_products"."kind"::text
        when 'amount' then "catalog_products"."amount_step" = 100
          and char_length("catalog_products"."amount_unit_ar") between 1 and 16
        else "catalog_products"."amount_step" is null and "catalog_products"."amount_unit_ar" is null and "catalog_products"."min_quantity" = 1
      end);--> statement-breakpoint
ALTER TABLE "catalog_products" ADD CONSTRAINT "catalog_products_max_quantity_check" CHECK ("catalog_products"."max_quantity" between 1 and case "catalog_products"."kind"::text when 'amount' then 1000 else 50 end
        and "catalog_products"."min_quantity" between 1 and "catalog_products"."max_quantity");--> statement-breakpoint
ALTER TABLE "fulfilment_attempts" ADD CONSTRAINT "fulfilment_attempts_quantity_check" CHECK ("fulfilment_attempts"."quantity" between 1 and 1000);--> statement-breakpoint
ALTER TABLE "orders" ADD CONSTRAINT "orders_cash_hold_check" CHECK (char_length("orders"."recipient") between 1 and 32
        and ("orders"."cash_hold" is null or "orders"."recipient" is not null)
        and ("orders"."cash_hold_decided_at" is null) = coalesce("orders"."cash_hold" = 'held', true)
        and ("orders"."cash_hold_admin_id" is null or "orders"."cash_hold" in ('approved', 'rejected')));--> statement-breakpoint
ALTER TABLE "orders" ADD CONSTRAINT "orders_quantity_check" CHECK ("orders"."quantity" between 1 and case "orders"."kind"::text when 'amount' then 1000 else 100 end);--> statement-breakpoint
ALTER TABLE "supplier_offers" ADD CONSTRAINT "supplier_offers_unsupported_reason_check" CHECK ("supplier_offers"."unsupported_reason" in ('fields_unsupported', 'manual_delivery', 'cost_precision'));--> statement-breakpoint

-- The jneedcontur supplier row (ZD1–ZD2), fixed id so every database holds the same row. Its code
-- is used in this transaction, so `supplier_code` is recreated on the new list of values, as 0069
-- did; only `suppliers.code` uses the type. No player checks (quota 0) and a $10 low-balance alert.
ALTER TABLE "suppliers" ALTER COLUMN "code" SET DATA TYPE text;
--> statement-breakpoint
DROP TYPE "public"."supplier_code";
--> statement-breakpoint
CREATE TYPE "public"."supplier_code" AS ENUM('wdgzone', 'fazercards', 'jneedcontur', 'manual', 'fake');
--> statement-breakpoint
ALTER TABLE "suppliers" ALTER COLUMN "code" SET DATA TYPE "public"."supplier_code" USING "code"::"public"."supplier_code";
--> statement-breakpoint
INSERT INTO suppliers (id, code, name_ar, low_balance_usd_units, validation_daily_quota) VALUES
  ('019a4f20-0000-7000-8000-000000002501', 'jneedcontur', 'jneedcontur', 10000000, 0)
ON CONFLICT DO NOTHING;
--> statement-breakpoint

-- The credit policy is append-only as `order_policy`: a save is a new row, the newest is in force.
CREATE TRIGGER credit_policy_append_only BEFORE UPDATE OR DELETE ON credit_policy
  FOR EACH ROW EXECUTE FUNCTION append_only_guard();
--> statement-breakpoint
CREATE TRIGGER credit_policy_no_truncate BEFORE TRUNCATE ON credit_policy
  FOR EACH STATEMENT EXECUTE FUNCTION append_only_guard();
--> statement-breakpoint
REVOKE UPDATE, DELETE, TRUNCATE ON credit_policy FROM PUBLIC;
--> statement-breakpoint
DO $$
DECLARE
  grantee text;
BEGIN
  FOR grantee IN
    SELECT DISTINCT acl.grantee::regrole::text
    FROM pg_class AS c, aclexplode(c.relacl) AS acl
    WHERE c.oid = 'credit_policy'::regclass
      AND acl.grantee <> c.relowner
      AND acl.grantee <> 0
  LOOP
    EXECUTE format('REVOKE UPDATE, DELETE, TRUNCATE ON credit_policy FROM %s', grantee);
  END LOOP;
END $$;
--> statement-breakpoint

-- The owner's limits (D9, D10): retail $50 and merchants $500 a day in the section; 5 and 20
-- orders a day per number; an alert from the third account within 7 days; cash $20 and $100 a
-- day, held above $10 and $50, only from balance credited 72 hours ago, refunded after 24 hours
-- undecided, decided on Telegram up to $50.
INSERT INTO credit_policy (id, retail_daily_usd_units, merchant_daily_usd_units,
  recipient_daily_orders_retail, recipient_daily_orders_merchant, recipient_accounts_alert,
  recipient_alert_days, cash_retail_daily_usd_units, cash_merchant_daily_usd_units,
  cash_retail_approval_above_usd_units, cash_merchant_approval_above_usd_units,
  cash_balance_age_hours, cash_hold_hours, cash_telegram_ceiling_usd_units, admin_id)
VALUES ('019a4f20-0000-7000-8000-000000002502', 50000000, 500000000, 5, 20, 2, 7, 20000000,
  100000000, 10000000, 50000000, 72, 24, 50000000, NULL)
ON CONFLICT DO NOTHING;
