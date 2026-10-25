CREATE TYPE "public"."product_alert_kind" AS ENUM('available', 'price_drop');--> statement-breakpoint
CREATE TYPE "public"."product_alert_status" AS ENUM('active', 'sent', 'cancelled', 'expired');--> statement-breakpoint
CREATE TYPE "public"."order_problem" AS ENUM('not_arrived', 'wrong_player_id', 'wrong_amount', 'code_not_working', 'code_used', 'wrong_region', 'refund_missing', 'other');--> statement-breakpoint
ALTER TYPE "public"."notification_event" ADD VALUE 'product_available';--> statement-breakpoint
ALTER TYPE "public"."notification_event" ADD VALUE 'product_price_dropped';--> statement-breakpoint
CREATE TABLE "product_alerts" (
	"id" uuid PRIMARY KEY NOT NULL,
	"customer_id" uuid NOT NULL,
	"product_id" uuid NOT NULL,
	"kind" "product_alert_kind" NOT NULL,
	"baseline_price_usd_units" bigint,
	"price_list_id" uuid NOT NULL,
	"status" "product_alert_status" DEFAULT 'active' NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"sent_at" timestamp with time zone,
	"ended_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "product_alerts_baseline_check" CHECK (("product_alerts"."kind" = 'price_drop') = ("product_alerts"."baseline_price_usd_units" is not null) and ("product_alerts"."baseline_price_usd_units" is null or ("product_alerts"."baseline_price_usd_units" > 0 and "product_alerts"."baseline_price_usd_units" % 10000 = 0))),
	CONSTRAINT "product_alerts_ended_check" CHECK (("product_alerts"."status" = 'active') = ("product_alerts"."ended_at" is null) and ("product_alerts"."status" = 'sent') = ("product_alerts"."sent_at" is not null))
);
--> statement-breakpoint
ALTER TABLE "support_tickets" ADD COLUMN "order_problem" "order_problem";--> statement-breakpoint
ALTER TABLE "product_alerts" ADD CONSTRAINT "product_alerts_customer_id_customers_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "product_alerts" ADD CONSTRAINT "product_alerts_product_id_catalog_products_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."catalog_products"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "product_alerts" ADD CONSTRAINT "product_alerts_price_list_id_price_lists_id_fk" FOREIGN KEY ("price_list_id") REFERENCES "public"."price_lists"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "product_alerts_active_idx" ON "product_alerts" USING btree ("customer_id","product_id","kind") WHERE "product_alerts"."status" = 'active';--> statement-breakpoint
CREATE INDEX "product_alerts_customer_idx" ON "product_alerts" USING btree ("customer_id","created_at");--> statement-breakpoint
CREATE INDEX "product_alerts_product_idx" ON "product_alerts" USING btree ("product_id","status");--> statement-breakpoint
CREATE INDEX "product_alerts_status_idx" ON "product_alerts" USING btree ("status","product_id");--> statement-breakpoint
CREATE INDEX "product_alerts_price_list_idx" ON "product_alerts" USING btree ("price_list_id");--> statement-breakpoint
CREATE INDEX "support_tickets_order_problem_idx" ON "support_tickets" USING btree ("order_problem","last_customer_message_at") WHERE "support_tickets"."order_problem" is not null;--> statement-breakpoint
ALTER TABLE "support_tickets" ADD CONSTRAINT "support_tickets_order_problem_check" CHECK ("support_tickets"."order_problem" is null or "support_tickets"."category" = 'order');