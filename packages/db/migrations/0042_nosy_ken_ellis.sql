CREATE TYPE "public"."ticket_author" AS ENUM('customer', 'admin');--> statement-breakpoint
CREATE TYPE "public"."ticket_category" AS ENUM('order', 'deposit', 'account', 'other');--> statement-breakpoint
CREATE TYPE "public"."ticket_closer" AS ENUM('customer', 'admin', 'system');--> statement-breakpoint
CREATE TYPE "public"."ticket_status" AS ENUM('open', 'answered', 'closed');--> statement-breakpoint
ALTER TYPE "public"."stored_file_kind" ADD VALUE 'ticket_attachment';--> statement-breakpoint
ALTER TYPE "public"."email_template" ADD VALUE 'customer_ticket_replied';--> statement-breakpoint
ALTER TYPE "public"."notification_event" ADD VALUE 'ticket_replied';--> statement-breakpoint
ALTER TYPE "public"."order_cancel_reason" ADD VALUE 'frozen';--> statement-breakpoint
ALTER TYPE "public"."telegram_message_kind" ADD VALUE 'ticket_opened';--> statement-breakpoint
ALTER TYPE "public"."telegram_message_kind" ADD VALUE 'ticket_reply';--> statement-breakpoint
CREATE TABLE "customer_sign_ins" (
	"id" uuid PRIMARY KEY NOT NULL,
	"customer_id" uuid NOT NULL,
	"ip_address" text,
	"user_agent" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "customer_sign_ins_user_agent_check" CHECK ("customer_sign_ins"."user_agent" is null or char_length("customer_sign_ins"."user_agent") <= 500)
);
--> statement-breakpoint
CREATE TABLE "customer_limits" (
	"customer_id" uuid PRIMARY KEY NOT NULL,
	"per_deposit_usd_units" bigint,
	"daily_deposit_usd_units" bigint,
	"daily_purchase_usd_units" bigint,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "customer_limits_per_deposit_check" CHECK ("customer_limits"."per_deposit_usd_units" is null or ("customer_limits"."per_deposit_usd_units" > 0 and "customer_limits"."per_deposit_usd_units" % 10000 = 0 and "customer_limits"."per_deposit_usd_units" <= 100000000000)),
	CONSTRAINT "customer_limits_daily_deposit_check" CHECK ("customer_limits"."daily_deposit_usd_units" is null or ("customer_limits"."daily_deposit_usd_units" > 0 and "customer_limits"."daily_deposit_usd_units" % 10000 = 0 and "customer_limits"."daily_deposit_usd_units" <= 100000000000)),
	CONSTRAINT "customer_limits_daily_purchase_check" CHECK ("customer_limits"."daily_purchase_usd_units" is null or ("customer_limits"."daily_purchase_usd_units" > 0 and "customer_limits"."daily_purchase_usd_units" % 10000 = 0 and "customer_limits"."daily_purchase_usd_units" <= 100000000000)),
	CONSTRAINT "customer_limits_per_deposit_within_daily_check" CHECK ("customer_limits"."per_deposit_usd_units" is null or "customer_limits"."daily_deposit_usd_units" is null or "customer_limits"."per_deposit_usd_units" <= "customer_limits"."daily_deposit_usd_units")
);
--> statement-breakpoint
CREATE TABLE "customer_notes" (
	"id" uuid PRIMARY KEY NOT NULL,
	"customer_id" uuid NOT NULL,
	"body" text NOT NULL,
	"pinned" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"archived_at" timestamp with time zone,
	CONSTRAINT "customer_notes_body_check" CHECK (char_length("customer_notes"."body") between 1 and 2000)
);
--> statement-breakpoint
CREATE TABLE "support_attachments" (
	"message_id" uuid NOT NULL,
	"file_id" uuid NOT NULL,
	"position" smallint NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "support_attachments_message_id_position_pk" PRIMARY KEY("message_id","position"),
	CONSTRAINT "support_attachments_file_id_unique" UNIQUE("file_id"),
	CONSTRAINT "support_attachments_position_check" CHECK ("support_attachments"."position" between 1 and 3)
);
--> statement-breakpoint
CREATE TABLE "support_messages" (
	"id" uuid PRIMARY KEY NOT NULL,
	"ticket_id" uuid NOT NULL,
	"author" "ticket_author" NOT NULL,
	"body" text NOT NULL,
	"idempotency_key" uuid,
	"created_at" timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
	CONSTRAINT "support_messages_idempotency_key_unique" UNIQUE("idempotency_key"),
	CONSTRAINT "support_messages_body_check" CHECK (char_length("support_messages"."body") between 1 and 2000)
);
--> statement-breakpoint
CREATE TABLE "support_settings" (
	"id" integer PRIMARY KEY NOT NULL,
	"telegram_url" text,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "support_settings_one_row_check" CHECK ("support_settings"."id" = 1),
	CONSTRAINT "support_settings_telegram_url_check" CHECK ("support_settings"."telegram_url" is null or "support_settings"."telegram_url" ~ '^https://t\.me/[A-Za-z0-9_]{5,32}$')
);
--> statement-breakpoint
CREATE TABLE "support_tickets" (
	"id" uuid PRIMARY KEY NOT NULL,
	"number" text NOT NULL,
	"customer_id" uuid NOT NULL,
	"category" "ticket_category" NOT NULL,
	"order_id" uuid,
	"deposit_id" uuid,
	"subject" text NOT NULL,
	"status" "ticket_status" NOT NULL,
	"opened_by" "ticket_author" NOT NULL,
	"last_customer_message_at" timestamp with time zone,
	"last_admin_message_at" timestamp with time zone,
	"closed_at" timestamp with time zone,
	"closed_by" "ticket_closer",
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "support_tickets_number_unique" UNIQUE("number"),
	CONSTRAINT "support_tickets_number_check" CHECK ("support_tickets"."number" ~ '^VT-[2-9A-HJKMNP-Z]{6}$'),
	CONSTRAINT "support_tickets_subject_check" CHECK (char_length("support_tickets"."subject") between 3 and 120),
	CONSTRAINT "support_tickets_link_check" CHECK (("support_tickets"."category" = 'order') = ("support_tickets"."order_id" is not null) and ("support_tickets"."category" = 'deposit') = ("support_tickets"."deposit_id" is not null)),
	CONSTRAINT "support_tickets_closed_check" CHECK (("support_tickets"."status" = 'closed') = ("support_tickets"."closed_at" is not null and "support_tickets"."closed_by" is not null) and ("support_tickets"."closed_at" is null) = ("support_tickets"."closed_by" is null))
);
--> statement-breakpoint
ALTER TABLE "customers" ADD COLUMN "frozen_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "customer_sign_ins" ADD CONSTRAINT "customer_sign_ins_customer_id_customers_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "customer_limits" ADD CONSTRAINT "customer_limits_customer_id_customers_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "customer_notes" ADD CONSTRAINT "customer_notes_customer_id_customers_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "support_attachments" ADD CONSTRAINT "support_attachments_message_id_support_messages_id_fk" FOREIGN KEY ("message_id") REFERENCES "public"."support_messages"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "support_attachments" ADD CONSTRAINT "support_attachments_file_id_stored_files_id_fk" FOREIGN KEY ("file_id") REFERENCES "public"."stored_files"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "support_messages" ADD CONSTRAINT "support_messages_ticket_id_support_tickets_id_fk" FOREIGN KEY ("ticket_id") REFERENCES "public"."support_tickets"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "support_tickets" ADD CONSTRAINT "support_tickets_customer_id_customers_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "support_tickets" ADD CONSTRAINT "support_tickets_order_id_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."orders"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "support_tickets" ADD CONSTRAINT "support_tickets_deposit_id_deposits_id_fk" FOREIGN KEY ("deposit_id") REFERENCES "public"."deposits"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "customer_sign_ins_customer_idx" ON "customer_sign_ins" USING btree ("customer_id","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "customer_sign_ins_ip_idx" ON "customer_sign_ins" USING btree ("ip_address","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "customer_notes_customer_idx" ON "customer_notes" USING btree ("customer_id","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE UNIQUE INDEX "customer_notes_one_pinned_idx" ON "customer_notes" USING btree ("customer_id") WHERE "customer_notes"."pinned" and "customer_notes"."archived_at" is null;--> statement-breakpoint
CREATE INDEX "support_messages_ticket_idx" ON "support_messages" USING btree ("ticket_id","created_at");--> statement-breakpoint
CREATE INDEX "support_tickets_customer_idx" ON "support_tickets" USING btree ("customer_id","updated_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "support_tickets_queue_idx" ON "support_tickets" USING btree ("status","last_customer_message_at");--> statement-breakpoint
CREATE INDEX "support_tickets_auto_close_idx" ON "support_tickets" USING btree ("status","last_admin_message_at");--> statement-breakpoint
CREATE UNIQUE INDEX "support_tickets_open_order_idx" ON "support_tickets" USING btree ("order_id") WHERE "support_tickets"."status" <> 'closed';--> statement-breakpoint
CREATE UNIQUE INDEX "support_tickets_open_deposit_idx" ON "support_tickets" USING btree ("deposit_id") WHERE "support_tickets"."status" <> 'closed';--> statement-breakpoint
CREATE INDEX "support_tickets_order_idx" ON "support_tickets" USING btree ("order_id");--> statement-breakpoint
CREATE INDEX "support_tickets_deposit_idx" ON "support_tickets" USING btree ("deposit_id");