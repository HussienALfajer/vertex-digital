ALTER TABLE "fulfilment_attempts" ADD COLUMN "option_map" jsonb;--> statement-breakpoint
ALTER TABLE "product_routes" ADD COLUMN "option_map" jsonb DEFAULT '{}'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "product_routes" ADD CONSTRAINT "product_routes_option_map_check" CHECK (jsonb_typeof("product_routes"."option_map") = 'object');