-- S19 (ADR 0034): the FazerCards supplier row, fixed id so every database holds the same row.
-- Drizzle applies every pending migration in one transaction, and a value that 0068 added with
-- `ALTER TYPE ... ADD VALUE` cannot be used before that transaction commits. So `supplier_code` is
-- recreated here, as 0061 did, on the same list of values (no change for drizzle-kit's snapshot): a
-- type created in this transaction may use all its values at once. Only `suppliers.code` uses it.
ALTER TABLE "suppliers" ALTER COLUMN "code" SET DATA TYPE text;
--> statement-breakpoint
DROP TYPE "public"."supplier_code";
--> statement-breakpoint
CREATE TYPE "public"."supplier_code" AS ENUM('wdgzone', 'fazercards', 'manual', 'fake');
--> statement-breakpoint
ALTER TABLE "suppliers" ALTER COLUMN "code" SET DATA TYPE "public"."supplier_code" USING "code"::"public"."supplier_code";
--> statement-breakpoint

-- Its low-balance alert at $5 (D8, editable in the panel); 1000 player checks a Damascus day.
INSERT INTO suppliers (id, code, name_ar, low_balance_usd_units, validation_daily_quota) VALUES
  ('01a11d3c-890d-7c1e-9f2a-6a3b5c7d9e10', 'fazercards', 'FazerCards', 5000000, 1000)
ON CONFLICT DO NOTHING;
