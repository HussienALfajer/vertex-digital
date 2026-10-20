CREATE TYPE "public"."account_type" AS ENUM('customer', 'merchant');--> statement-breakpoint
CREATE TYPE "public"."price_source" AS ENUM('rule', 'fixed', 'fixed_fallback', 'retail_cap');--> statement-breakpoint
CREATE TABLE "price_list_fixed_prices" (
	"id" uuid PRIMARY KEY NOT NULL,
	"price_list_id" uuid NOT NULL,
	"product_id" uuid NOT NULL,
	"price_usd_units" bigint NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"archived_at" timestamp with time zone,
	CONSTRAINT "price_list_fixed_prices_price_check" CHECK ("price_list_fixed_prices"."price_usd_units" > 0 and "price_list_fixed_prices"."price_usd_units" <= 10000000000 and "price_list_fixed_prices"."price_usd_units" % 10000 = 0)
);
--> statement-breakpoint
DROP INDEX "margin_rules_scope_target_id_live_idx";--> statement-breakpoint
DROP INDEX "margin_rules_global_live_idx";--> statement-breakpoint
DROP INDEX "product_prices_product_id_created_at_idx";--> statement-breakpoint
ALTER TABLE "customers" ADD COLUMN "account_type" "account_type" DEFAULT 'customer' NOT NULL;--> statement-breakpoint
ALTER TABLE "customers" ADD COLUMN "price_list_id" uuid;--> statement-breakpoint
ALTER TABLE "orders" ADD COLUMN "price_list_id" uuid DEFAULT '01a15a8c-b310-7513-8c14-09e5262ac878' NOT NULL;--> statement-breakpoint
ALTER TABLE "margin_rules" ADD COLUMN "price_list_id" uuid DEFAULT '01a15a8c-b310-7513-8c14-09e5262ac878' NOT NULL;--> statement-breakpoint
ALTER TABLE "product_prices" ADD COLUMN "price_list_id" uuid DEFAULT '01a15a8c-b310-7513-8c14-09e5262ac878' NOT NULL;--> statement-breakpoint
ALTER TABLE "product_prices" ADD COLUMN "source" "price_source" DEFAULT 'rule' NOT NULL;--> statement-breakpoint
ALTER TABLE "product_prices" ADD COLUMN "fixed_price_id" uuid;--> statement-breakpoint
ALTER TABLE "price_list_fixed_prices" ADD CONSTRAINT "price_list_fixed_prices_price_list_id_price_lists_id_fk" FOREIGN KEY ("price_list_id") REFERENCES "public"."price_lists"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "price_list_fixed_prices" ADD CONSTRAINT "price_list_fixed_prices_product_id_catalog_products_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."catalog_products"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "price_list_fixed_prices_list_product_live_idx" ON "price_list_fixed_prices" USING btree ("price_list_id","product_id") WHERE "price_list_fixed_prices"."archived_at" is null;--> statement-breakpoint
CREATE INDEX "price_list_fixed_prices_product_id_idx" ON "price_list_fixed_prices" USING btree ("product_id");--> statement-breakpoint
ALTER TABLE "customers" ADD CONSTRAINT "customers_price_list_id_price_lists_id_fk" FOREIGN KEY ("price_list_id") REFERENCES "public"."price_lists"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "orders" ADD CONSTRAINT "orders_price_list_id_price_lists_id_fk" FOREIGN KEY ("price_list_id") REFERENCES "public"."price_lists"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "margin_rules" ADD CONSTRAINT "margin_rules_price_list_id_price_lists_id_fk" FOREIGN KEY ("price_list_id") REFERENCES "public"."price_lists"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "product_prices" ADD CONSTRAINT "product_prices_price_list_id_price_lists_id_fk" FOREIGN KEY ("price_list_id") REFERENCES "public"."price_lists"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "product_prices" ADD CONSTRAINT "product_prices_fixed_price_id_price_list_fixed_prices_id_fk" FOREIGN KEY ("fixed_price_id") REFERENCES "public"."price_list_fixed_prices"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "customers_price_list_id_idx" ON "customers" USING btree ("price_list_id");--> statement-breakpoint
CREATE INDEX "orders_price_list_id_idx" ON "orders" USING btree ("price_list_id");--> statement-breakpoint
CREATE UNIQUE INDEX "margin_rules_list_scope_target_id_live_idx" ON "margin_rules" USING btree ("price_list_id","scope","target_id") WHERE "margin_rules"."archived_at" is null;--> statement-breakpoint
CREATE UNIQUE INDEX "margin_rules_list_global_live_idx" ON "margin_rules" USING btree ("price_list_id") WHERE "margin_rules"."scope" = 'global' and "margin_rules"."archived_at" is null;--> statement-breakpoint
CREATE INDEX "product_prices_product_list_created_at_idx" ON "product_prices" USING btree ("product_id","price_list_id","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "product_prices_price_list_id_idx" ON "product_prices" USING btree ("price_list_id");--> statement-breakpoint
CREATE INDEX "product_prices_fixed_price_id_idx" ON "product_prices" USING btree ("fixed_price_id");--> statement-breakpoint
ALTER TABLE "product_prices" ADD CONSTRAINT "product_prices_fixed_price_check" CHECK (("product_prices"."source" in ('fixed', 'fixed_fallback')) = ("product_prices"."fixed_price_id" is not null));