CREATE TYPE "public"."shop_compensation_margin_source" AS ENUM('merchant', 'store', 'none');--> statement-breakpoint
CREATE TYPE "public"."shop_notification_event" AS ENUM('transfer_received', 'return_requested', 'return_done', 'settled', 'order_delivered', 'order_partially_refunded', 'order_refunded', 'order_compensated', 'ticket_replied');--> statement-breakpoint
ALTER TYPE "public"."email_template" ADD VALUE 'shop_customer_order_delivered';--> statement-breakpoint
ALTER TYPE "public"."email_template" ADD VALUE 'shop_customer_order_partially_refunded';--> statement-breakpoint
ALTER TYPE "public"."email_template" ADD VALUE 'shop_customer_order_refunded';--> statement-breakpoint
ALTER TYPE "public"."email_template" ADD VALUE 'shop_customer_order_compensated';--> statement-breakpoint
ALTER TYPE "public"."email_template" ADD VALUE 'shop_customer_ticket_replied';--> statement-breakpoint
ALTER TYPE "public"."notification_event" ADD VALUE 'merchant_shop_ticket';--> statement-breakpoint
ALTER TYPE "public"."notification_event" ADD VALUE 'merchant_shop_margin_returned';--> statement-breakpoint
ALTER TYPE "public"."ticket_author" ADD VALUE 'merchant';--> statement-breakpoint
CREATE TABLE "shop_compensations" (
	"id" uuid PRIMARY KEY NOT NULL,
	"order_id" uuid NOT NULL,
	"shop_id" uuid NOT NULL,
	"shop_customer_id" uuid NOT NULL,
	"units" integer NOT NULL,
	"vertex_usd_units" bigint NOT NULL,
	"margin_usd_units" bigint NOT NULL,
	"margin_from" "shop_compensation_margin_source" NOT NULL,
	"adjustment_journal_id" uuid NOT NULL,
	"margin_journal_id" uuid,
	"idempotency_key" uuid NOT NULL,
	"admin_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
	CONSTRAINT "shop_compensations_adjustment_journal_id_unique" UNIQUE("adjustment_journal_id"),
	CONSTRAINT "shop_compensations_margin_journal_id_unique" UNIQUE("margin_journal_id"),
	CONSTRAINT "shop_compensations_idempotency_key_unique" UNIQUE("idempotency_key"),
	CONSTRAINT "shop_compensations_amount_check" CHECK ("shop_compensations"."units" > 0 and "shop_compensations"."vertex_usd_units" > 0 and "shop_compensations"."vertex_usd_units" % 10000 = 0
        and "shop_compensations"."margin_usd_units" >= 0 and "shop_compensations"."margin_usd_units" % 10000 = 0
        and ("shop_compensations"."margin_journal_id" is not null) = ("shop_compensations"."margin_from" = 'merchant' and "shop_compensations"."margin_usd_units" > 0))
);
--> statement-breakpoint
CREATE TABLE "shop_order_sales" (
	"order_id" uuid PRIMARY KEY NOT NULL,
	"shop_id" uuid NOT NULL,
	"shop_customer_id" uuid NOT NULL,
	"unit_sell_usd_units" bigint NOT NULL,
	"unit_buy_usd_units" bigint NOT NULL,
	"quantity" integer NOT NULL,
	"sell_currency" "sale_currency" NOT NULL,
	"unit_sell_entered_units" bigint NOT NULL,
	"unit_sell_syp_units" bigint,
	"rate_syp_per_usd" numeric(12, 4),
	"margin_released_usd_units" bigint,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "shop_order_sales_amount_check" CHECK ("shop_order_sales"."unit_buy_usd_units" > 0 and "shop_order_sales"."unit_buy_usd_units" % 10000 = 0
        and "shop_order_sales"."unit_sell_usd_units" >= "shop_order_sales"."unit_buy_usd_units" and "shop_order_sales"."unit_sell_usd_units" % 10000 = 0
        and "shop_order_sales"."quantity" > 0 and "shop_order_sales"."unit_sell_entered_units" > 0
        and ("shop_order_sales"."sell_currency" <> 'usd' or "shop_order_sales"."unit_sell_entered_units" = "shop_order_sales"."unit_sell_usd_units")
        and ("shop_order_sales"."sell_currency" = 'usd' or "shop_order_sales"."rate_syp_per_usd" is not null)
        and ("shop_order_sales"."rate_syp_per_usd" is null or "shop_order_sales"."rate_syp_per_usd" > 0)
        and ("shop_order_sales"."margin_released_usd_units" is null or "shop_order_sales"."margin_released_usd_units" >= 0))
);
--> statement-breakpoint
CREATE TABLE "shop_customer_notifications" (
	"id" uuid PRIMARY KEY NOT NULL,
	"shop_customer_id" uuid NOT NULL,
	"shop_id" uuid NOT NULL,
	"event" "shop_notification_event" NOT NULL,
	"params" jsonb NOT NULL,
	"read_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "shop_daily_stats" (
	"shop_id" uuid NOT NULL,
	"damascus_date" date NOT NULL,
	"visits" integer DEFAULT 0 NOT NULL,
	"sign_ups" integer DEFAULT 0 NOT NULL,
	CONSTRAINT "shop_daily_stats_shop_id_damascus_date_pk" PRIMARY KEY("shop_id","damascus_date"),
	CONSTRAINT "shop_daily_stats_counts_check" CHECK ("shop_daily_stats"."visits" >= 0 and "shop_daily_stats"."sign_ups" >= 0)
);
--> statement-breakpoint
CREATE TABLE "shop_push_subscriptions" (
	"id" uuid PRIMARY KEY NOT NULL,
	"shop_customer_id" uuid NOT NULL,
	"session_id" uuid NOT NULL,
	"endpoint" text NOT NULL,
	"p256dh" text NOT NULL,
	"auth" text NOT NULL,
	"vapid_key_id" text NOT NULL,
	"failures" integer DEFAULT 0 NOT NULL,
	"last_sent_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "shop_push_subscriptions_endpoint_length" CHECK (char_length("shop_push_subscriptions"."endpoint") <= 1024),
	CONSTRAINT "shop_push_subscriptions_failures" CHECK ("shop_push_subscriptions"."failures" >= 0)
);
--> statement-breakpoint
ALTER TABLE "support_tickets" ALTER COLUMN "customer_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "orders" ADD COLUMN "shop_customer_id" uuid;--> statement-breakpoint
ALTER TABLE "support_tickets" ADD COLUMN "shop_id" uuid;--> statement-breakpoint
ALTER TABLE "support_tickets" ADD COLUMN "shop_customer_id" uuid;--> statement-breakpoint
ALTER TABLE "support_tickets" ADD COLUMN "last_merchant_message_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "support_tickets" ADD COLUMN "escalated_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "shop_compensations" ADD CONSTRAINT "shop_compensations_order_id_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."orders"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shop_compensations" ADD CONSTRAINT "shop_compensations_shop_id_merchant_shops_id_fk" FOREIGN KEY ("shop_id") REFERENCES "public"."merchant_shops"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shop_compensations" ADD CONSTRAINT "shop_compensations_shop_customer_id_shop_customers_id_fk" FOREIGN KEY ("shop_customer_id") REFERENCES "public"."shop_customers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shop_compensations" ADD CONSTRAINT "shop_compensations_adjustment_journal_id_ledger_journals_id_fk" FOREIGN KEY ("adjustment_journal_id") REFERENCES "public"."ledger_journals"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shop_compensations" ADD CONSTRAINT "shop_compensations_margin_journal_id_ledger_journals_id_fk" FOREIGN KEY ("margin_journal_id") REFERENCES "public"."ledger_journals"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shop_order_sales" ADD CONSTRAINT "shop_order_sales_order_id_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."orders"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shop_order_sales" ADD CONSTRAINT "shop_order_sales_shop_id_merchant_shops_id_fk" FOREIGN KEY ("shop_id") REFERENCES "public"."merchant_shops"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shop_order_sales" ADD CONSTRAINT "shop_order_sales_shop_customer_id_shop_customers_id_fk" FOREIGN KEY ("shop_customer_id") REFERENCES "public"."shop_customers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shop_customer_notifications" ADD CONSTRAINT "shop_customer_notifications_shop_customer_id_shop_customers_id_fk" FOREIGN KEY ("shop_customer_id") REFERENCES "public"."shop_customers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shop_customer_notifications" ADD CONSTRAINT "shop_customer_notifications_shop_id_merchant_shops_id_fk" FOREIGN KEY ("shop_id") REFERENCES "public"."merchant_shops"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shop_daily_stats" ADD CONSTRAINT "shop_daily_stats_shop_id_merchant_shops_id_fk" FOREIGN KEY ("shop_id") REFERENCES "public"."merchant_shops"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shop_push_subscriptions" ADD CONSTRAINT "shop_push_subscriptions_shop_customer_id_shop_customers_id_fk" FOREIGN KEY ("shop_customer_id") REFERENCES "public"."shop_customers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shop_push_subscriptions" ADD CONSTRAINT "shop_push_subscriptions_session_id_shop_customer_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."shop_customer_sessions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "shop_compensations_order_idx" ON "shop_compensations" USING btree ("order_id");--> statement-breakpoint
CREATE INDEX "shop_compensations_shop_id_idx" ON "shop_compensations" USING btree ("shop_id");--> statement-breakpoint
CREATE INDEX "shop_compensations_shop_customer_id_idx" ON "shop_compensations" USING btree ("shop_customer_id");--> statement-breakpoint
CREATE INDEX "shop_order_sales_shop_idx" ON "shop_order_sales" USING btree ("shop_id","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "shop_order_sales_customer_idx" ON "shop_order_sales" USING btree ("shop_customer_id","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "shop_customer_notifications_customer_idx" ON "shop_customer_notifications" USING btree ("shop_customer_id","created_at" DESC NULLS LAST,"id" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "shop_customer_notifications_unread_idx" ON "shop_customer_notifications" USING btree ("shop_customer_id") WHERE "shop_customer_notifications"."read_at" is null;--> statement-breakpoint
CREATE INDEX "shop_customer_notifications_shop_id_idx" ON "shop_customer_notifications" USING btree ("shop_id");--> statement-breakpoint
CREATE UNIQUE INDEX "shop_push_subscriptions_endpoint_idx" ON "shop_push_subscriptions" USING btree ("endpoint");--> statement-breakpoint
CREATE INDEX "shop_push_subscriptions_customer_idx" ON "shop_push_subscriptions" USING btree ("shop_customer_id");--> statement-breakpoint
CREATE INDEX "shop_push_subscriptions_session_id_idx" ON "shop_push_subscriptions" USING btree ("session_id");--> statement-breakpoint
ALTER TABLE "orders" ADD CONSTRAINT "orders_shop_customer_id_shop_customers_id_fk" FOREIGN KEY ("shop_customer_id") REFERENCES "public"."shop_customers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "support_tickets" ADD CONSTRAINT "support_tickets_shop_id_merchant_shops_id_fk" FOREIGN KEY ("shop_id") REFERENCES "public"."merchant_shops"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "support_tickets" ADD CONSTRAINT "support_tickets_shop_customer_id_shop_customers_id_fk" FOREIGN KEY ("shop_customer_id") REFERENCES "public"."shop_customers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "orders_shop_customer_id_created_at_idx" ON "orders" USING btree ("shop_customer_id","created_at" DESC NULLS LAST) WHERE "orders"."shop_customer_id" is not null;--> statement-breakpoint
CREATE INDEX "support_tickets_shop_customer_idx" ON "support_tickets" USING btree ("shop_customer_id","updated_at" DESC NULLS LAST) WHERE "support_tickets"."shop_customer_id" is not null;--> statement-breakpoint
CREATE INDEX "support_tickets_shop_idx" ON "support_tickets" USING btree ("shop_id","updated_at" DESC NULLS LAST,"id" DESC NULLS LAST) WHERE "support_tickets"."shop_id" is not null;--> statement-breakpoint
ALTER TABLE "orders" ADD CONSTRAINT "orders_shop_customer_check" CHECK ("orders"."shop_customer_id" is null or ("orders"."customer_id" is not null
        and "orders"."checkout_id" is null and "orders"."payer" = 'customer'
        and "orders"."placed_by" = 'customer' and not "orders"."is_gift"));--> statement-breakpoint
ALTER TABLE "support_tickets" ADD CONSTRAINT "support_tickets_owner_check" CHECK (("support_tickets"."customer_id" is null) <> ("support_tickets"."shop_customer_id" is null)
        and ("support_tickets"."shop_id" is null) = ("support_tickets"."shop_customer_id" is null)
        and ("support_tickets"."shop_id" is not null or ("support_tickets"."escalated_at" is null and "support_tickets"."last_merchant_message_at" is null))
        and ("support_tickets"."shop_id" is null or ("support_tickets"."deposit_id" is null and "support_tickets"."opened_by" = 'customer')));