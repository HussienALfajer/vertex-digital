DROP INDEX "product_routes_product_id_supplier_id_live_idx";--> statement-breakpoint
ALTER TABLE "fulfilment_attempts" ADD COLUMN "expected_delivery_minutes" integer;--> statement-breakpoint
ALTER TABLE "fulfilment_attempts" ADD COLUMN "hard_limit_minutes" integer;--> statement-breakpoint
ALTER TABLE "product_routes" ADD COLUMN "price_basis" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "product_routes" ADD COLUMN "expected_delivery_minutes" integer;--> statement-breakpoint
ALTER TABLE "product_routes" ADD COLUMN "hard_limit_minutes" integer;--> statement-breakpoint
CREATE INDEX "product_routes_product_id_idx" ON "product_routes" USING btree ("product_id");--> statement-breakpoint
ALTER TABLE "product_routes" ADD CONSTRAINT "product_routes_timing_check" CHECK (("product_routes"."expected_delivery_minutes" is null or "product_routes"."expected_delivery_minutes" between 1 and 240)
        and ("product_routes"."hard_limit_minutes" is null or "product_routes"."hard_limit_minutes" between 5 and 240)
        and ("product_routes"."expected_delivery_minutes" is null or "product_routes"."hard_limit_minutes" is null
          or "product_routes"."expected_delivery_minutes" < "product_routes"."hard_limit_minutes"));