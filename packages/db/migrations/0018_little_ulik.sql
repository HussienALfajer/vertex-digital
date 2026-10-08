CREATE TYPE "public"."store_switch" AS ENUM('registration_open', 'purchases_stopped', 'deposits_stopped', 'sham_cash_paused', 'usdt_trc20_paused', 'usdt_bep20_paused');--> statement-breakpoint
CREATE TYPE "public"."switch_channel" AS ENUM('admin', 'telegram');--> statement-breakpoint
CREATE TABLE "store_switch_changes" (
	"id" uuid PRIMARY KEY NOT NULL,
	"switch" "store_switch" NOT NULL,
	"value" boolean NOT NULL,
	"admin_id" uuid NOT NULL,
	"channel" "switch_channel" NOT NULL,
	"created_at" timestamp with time zone DEFAULT clock_timestamp() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "store_switch_changes_switch_created_at_idx" ON "store_switch_changes" USING btree ("switch","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "store_switch_changes_created_at_idx" ON "store_switch_changes" USING btree ("created_at" DESC NULLS LAST);