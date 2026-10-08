CREATE TYPE "public"."notification_event" AS ENUM('deposit_credited', 'deposit_rejected', 'deposit_receipt_requested', 'wallet_adjusted');--> statement-breakpoint
CREATE TABLE "customer_notifications" (
	"id" uuid PRIMARY KEY NOT NULL,
	"customer_id" uuid NOT NULL,
	"event" "notification_event" NOT NULL,
	"params" jsonb NOT NULL,
	"read_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "notification_preferences" (
	"customer_id" uuid NOT NULL,
	"event" "notification_event" NOT NULL,
	"email" boolean NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "notification_preferences_customer_id_event_pk" PRIMARY KEY("customer_id","event")
);
--> statement-breakpoint
ALTER TABLE "customer_notifications" ADD CONSTRAINT "customer_notifications_customer_id_customers_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notification_preferences" ADD CONSTRAINT "notification_preferences_customer_id_customers_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "customer_notifications_customer_id_idx" ON "customer_notifications" USING btree ("customer_id","created_at" DESC NULLS LAST,"id" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "customer_notifications_unread_idx" ON "customer_notifications" USING btree ("customer_id") WHERE "customer_notifications"."read_at" is null;