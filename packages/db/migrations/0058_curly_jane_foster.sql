ALTER TABLE "supplier_policy" ALTER COLUMN "low_stock_units" SET DATA TYPE bigint;--> statement-breakpoint
ALTER TABLE "supplier_policy" ALTER COLUMN "low_stock_units" SET DEFAULT 10;