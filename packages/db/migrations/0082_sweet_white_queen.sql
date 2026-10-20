ALTER TABLE "orders" ALTER COLUMN "price_list_id" DROP DEFAULT;--> statement-breakpoint
ALTER TABLE "margin_rules" ALTER COLUMN "price_list_id" DROP DEFAULT;--> statement-breakpoint
ALTER TABLE "product_prices" ALTER COLUMN "price_list_id" DROP DEFAULT;