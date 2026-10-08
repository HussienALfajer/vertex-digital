CREATE TYPE "public"."telegram_message_kind" AS ENUM('switch_changed', 'bot_reply', 'link_changed', 'test');--> statement-breakpoint
CREATE TYPE "public"."telegram_message_status" AS ENUM('pending', 'sent', 'failed', 'skipped');--> statement-breakpoint
CREATE TYPE "public"."telegram_prompt_kind" AS ENUM('stop_confirm');--> statement-breakpoint
CREATE TABLE "telegram_link_codes" (
	"id" uuid PRIMARY KEY NOT NULL,
	"admin_id" uuid NOT NULL,
	"code_sha256" "bytea" NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"used_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "telegram_link_codes_code_sha256_unique" UNIQUE("code_sha256"),
	CONSTRAINT "telegram_link_codes_sha256_check" CHECK (octet_length("telegram_link_codes"."code_sha256") = 32)
);
--> statement-breakpoint
CREATE TABLE "telegram_links" (
	"id" uuid PRIMARY KEY NOT NULL,
	"admin_id" uuid NOT NULL,
	"chat_id" bigint NOT NULL,
	"telegram_user_id" bigint NOT NULL,
	"telegram_username" text,
	"linked_at" timestamp with time zone DEFAULT now() NOT NULL,
	"unlinked_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "telegram_messages" (
	"id" uuid PRIMARY KEY NOT NULL,
	"kind" "telegram_message_kind" NOT NULL,
	"params" jsonb NOT NULL,
	"dedupe_key" text,
	"chat_id" bigint,
	"status" "telegram_message_status" DEFAULT 'pending' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"last_error" text,
	"telegram_message_id" bigint,
	"sent_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "telegram_messages_dedupe_key_unique" UNIQUE("dedupe_key")
);
--> statement-breakpoint
CREATE TABLE "telegram_prompts" (
	"id" uuid PRIMARY KEY NOT NULL,
	"kind" "telegram_prompt_kind" NOT NULL,
	"data" jsonb NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"closed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "telegram_updates" (
	"update_id" bigint PRIMARY KEY NOT NULL,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX "telegram_links_live_idx" ON "telegram_links" USING btree ((true)) WHERE "telegram_links"."unlinked_at" is null;--> statement-breakpoint
CREATE INDEX "telegram_messages_created_at_idx" ON "telegram_messages" USING btree ("created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE UNIQUE INDEX "telegram_prompts_open_idx" ON "telegram_prompts" USING btree ((true)) WHERE "telegram_prompts"."closed_at" is null;