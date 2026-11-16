CREATE TYPE "public"."rate_decision_channel" AS ENUM('panel', 'telegram');--> statement-breakpoint
CREATE TYPE "public"."rate_observation_status" AS ENUM('ok', 'no_match', 'fetch_failed', 'out_of_range');--> statement-breakpoint
CREATE TYPE "public"."rate_origin" AS ENUM('admin', 'auto', 'suggestion');--> statement-breakpoint
CREATE TYPE "public"."rate_source_kind" AS ENUM('telegram_channel', 'sp_today_page');--> statement-breakpoint
CREATE TYPE "public"."rate_suggestion_reason" AS ENUM('single_source', 'sources_disagree', 'move_too_large', 'drift_too_large', 'auto_off');--> statement-breakpoint
CREATE TYPE "public"."rate_suggestion_status" AS ENUM('pending', 'approved', 'rejected', 'superseded', 'expired');--> statement-breakpoint
ALTER TYPE "public"."telegram_message_kind" ADD VALUE 'rate_suggestion';--> statement-breakpoint
ALTER TYPE "public"."telegram_message_kind" ADD VALUE 'rate_suggestion_closed';--> statement-breakpoint
ALTER TYPE "public"."telegram_message_kind" ADD VALUE 'rate_auto_changed';--> statement-breakpoint
ALTER TYPE "public"."telegram_message_kind" ADD VALUE 'rate_source_broken';--> statement-breakpoint
ALTER TYPE "public"."telegram_message_kind" ADD VALUE 'rate_sources_silent';--> statement-breakpoint
ALTER TYPE "public"."telegram_prompt_kind" ADD VALUE 'rate_auto_off_confirm';--> statement-breakpoint
CREATE TABLE "rate_observations" (
	"id" uuid PRIMARY KEY NOT NULL,
	"source_id" uuid NOT NULL,
	"fetched_at" timestamp with time zone NOT NULL,
	"posted_at" timestamp with time zone,
	"status" "rate_observation_status" NOT NULL,
	"syp_per_usd" numeric(12, 4),
	"excerpt" text,
	"error_code" text,
	CONSTRAINT "rate_observations_figure_check" CHECK (("rate_observations"."status" in ('ok', 'out_of_range')) = ("rate_observations"."syp_per_usd" is not null)
        and ("rate_observations"."syp_per_usd" is null or "rate_observations"."syp_per_usd" > 0)),
	CONSTRAINT "rate_observations_excerpt_check" CHECK ("rate_observations"."excerpt" is null or char_length("rate_observations"."excerpt") <= 300)
);
--> statement-breakpoint
CREATE TABLE "rate_settings" (
	"id" uuid PRIMARY KEY NOT NULL,
	"auto_enabled" boolean NOT NULL,
	"auto_max_move_bps" integer NOT NULL,
	"agreement_max_spread_bps" integer NOT NULL,
	"min_agreeing_sources" integer NOT NULL,
	"drift_window_hours" integer NOT NULL,
	"drift_max_bps" integer NOT NULL,
	"min_move_bps" integer NOT NULL,
	"freshness_minutes" integer NOT NULL,
	"silent_alert_hours" integer NOT NULL,
	"telegram_approve_max_bps" integer NOT NULL,
	"poll_minutes" integer NOT NULL,
	"admin_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "rate_settings_telegram_cap_check" CHECK ("rate_settings"."telegram_approve_max_bps" <= 500),
	CONSTRAINT "rate_settings_sources_check" CHECK ("rate_settings"."min_agreeing_sources" >= 2)
);
--> statement-breakpoint
CREATE TABLE "rate_sources" (
	"id" uuid PRIMARY KEY NOT NULL,
	"kind" "rate_source_kind" NOT NULL,
	"label" text NOT NULL,
	"handle" text NOT NULL,
	"parser" jsonb NOT NULL,
	"enabled" boolean NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"archived_at" timestamp with time zone,
	CONSTRAINT "rate_sources_label_check" CHECK (char_length("rate_sources"."label") between 2 and 40)
);
--> statement-breakpoint
CREATE TABLE "rate_suggestions" (
	"id" uuid PRIMARY KEY NOT NULL,
	"proposed_syp_per_usd" numeric(12, 4) NOT NULL,
	"base_rate_id" uuid NOT NULL,
	"change_percent" numeric(8, 2) NOT NULL,
	"reason" "rate_suggestion_reason" NOT NULL,
	"observation_ids" uuid[] NOT NULL,
	"status" "rate_suggestion_status" DEFAULT 'pending' NOT NULL,
	"decided_at" timestamp with time zone,
	"decided_channel" "rate_decision_channel",
	"admin_id" uuid,
	"applied_rate_id" uuid,
	"telegram_message_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "rate_suggestions_rate_check" CHECK ("rate_suggestions"."proposed_syp_per_usd" > 0),
	CONSTRAINT "rate_suggestions_decision_check" CHECK (("rate_suggestions"."status" = 'pending') = ("rate_suggestions"."decided_at" is null)
        and ("rate_suggestions"."status" in ('approved', 'rejected')) = ("rate_suggestions"."decided_channel" is not null)
        and ("rate_suggestions"."status" in ('approved', 'rejected')) = ("rate_suggestions"."admin_id" is not null)
        and ("rate_suggestions"."status" = 'approved') = ("rate_suggestions"."applied_rate_id" is not null))
);
--> statement-breakpoint
ALTER TABLE "exchange_rates" ALTER COLUMN "admin_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "exchange_rates" ADD COLUMN "origin" "rate_origin" DEFAULT 'admin' NOT NULL;--> statement-breakpoint
ALTER TABLE "exchange_rates" ADD COLUMN "suggestion_id" uuid;--> statement-breakpoint
ALTER TABLE "rate_observations" ADD CONSTRAINT "rate_observations_source_id_rate_sources_id_fk" FOREIGN KEY ("source_id") REFERENCES "public"."rate_sources"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rate_suggestions" ADD CONSTRAINT "rate_suggestions_base_rate_id_exchange_rates_id_fk" FOREIGN KEY ("base_rate_id") REFERENCES "public"."exchange_rates"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rate_suggestions" ADD CONSTRAINT "rate_suggestions_applied_rate_id_exchange_rates_id_fk" FOREIGN KEY ("applied_rate_id") REFERENCES "public"."exchange_rates"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rate_suggestions" ADD CONSTRAINT "rate_suggestions_telegram_message_id_telegram_messages_id_fk" FOREIGN KEY ("telegram_message_id") REFERENCES "public"."telegram_messages"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "rate_observations_source_idx" ON "rate_observations" USING btree ("source_id","fetched_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "rate_observations_fetched_at_idx" ON "rate_observations" USING btree ("fetched_at");--> statement-breakpoint
CREATE INDEX "rate_settings_created_at_idx" ON "rate_settings" USING btree ("created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE UNIQUE INDEX "rate_sources_live_handle_idx" ON "rate_sources" USING btree ("kind","handle") WHERE archived_at is null;--> statement-breakpoint
CREATE UNIQUE INDEX "rate_suggestions_one_pending_idx" ON "rate_suggestions" USING btree ("status") WHERE status = 'pending';--> statement-breakpoint
CREATE INDEX "rate_suggestions_created_at_idx" ON "rate_suggestions" USING btree ("created_at" DESC NULLS LAST,"id" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "rate_suggestions_base_rate_idx" ON "rate_suggestions" USING btree ("base_rate_id");--> statement-breakpoint
CREATE INDEX "rate_suggestions_applied_rate_idx" ON "rate_suggestions" USING btree ("applied_rate_id");--> statement-breakpoint
CREATE INDEX "rate_suggestions_telegram_message_idx" ON "rate_suggestions" USING btree ("telegram_message_id");--> statement-breakpoint
ALTER TABLE "exchange_rates" ADD CONSTRAINT "exchange_rates_suggestion_id_rate_suggestions_id_fk" FOREIGN KEY ("suggestion_id") REFERENCES "public"."rate_suggestions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "exchange_rates_suggestion_idx" ON "exchange_rates" USING btree ("suggestion_id");--> statement-breakpoint
ALTER TABLE "exchange_rates" ADD CONSTRAINT "exchange_rates_origin_check" CHECK (("exchange_rates"."origin" = 'auto') = ("exchange_rates"."admin_id" is null)
        and ("exchange_rates"."origin" = 'suggestion') = ("exchange_rates"."suggestion_id" is not null));