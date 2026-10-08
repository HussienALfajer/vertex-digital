ALTER TYPE "public"."telegram_message_kind" ADD VALUE 'usdt_unmatched' BEFORE 'bot_reply';--> statement-breakpoint
ALTER TYPE "public"."telegram_message_kind" ADD VALUE 'review_reminder' BEFORE 'bot_reply';--> statement-breakpoint
ALTER TYPE "public"."telegram_message_kind" ADD VALUE 'daily_summary' BEFORE 'bot_reply';--> statement-breakpoint
ALTER TYPE "public"."telegram_prompt_kind" ADD VALUE 'approve_number' BEFORE 'stop_confirm';--> statement-breakpoint
ALTER TYPE "public"."telegram_prompt_kind" ADD VALUE 'approve_confirm' BEFORE 'stop_confirm';--> statement-breakpoint
ALTER TYPE "public"."telegram_prompt_kind" ADD VALUE 'reject_note' BEFORE 'stop_confirm';--> statement-breakpoint
CREATE TABLE "telegram_bot_state" (
	"id" smallint PRIMARY KEY NOT NULL,
	"last_reminder_at" timestamp with time zone,
	CONSTRAINT "telegram_bot_state_one_row" CHECK ("telegram_bot_state"."id" = 1)
);
--> statement-breakpoint
CREATE TABLE "telegram_deposit_cards" (
	"deposit_id" uuid NOT NULL,
	"submitted_at" timestamp with time zone NOT NULL,
	"chat_id" bigint NOT NULL,
	"message_id" bigint NOT NULL,
	"reminded_at" timestamp with time zone,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "telegram_deposit_cards_deposit_id_submitted_at_pk" PRIMARY KEY("deposit_id","submitted_at")
);
--> statement-breakpoint
ALTER TABLE "deposit_settings" ADD COLUMN "telegram_approval_max_usd_units" bigint DEFAULT 100000000 NOT NULL;--> statement-breakpoint
ALTER TABLE "telegram_prompts" ADD COLUMN "deposit_id" uuid;--> statement-breakpoint
ALTER TABLE "telegram_prompts" ADD COLUMN "deposit_submitted_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "telegram_deposit_cards" ADD CONSTRAINT "telegram_deposit_cards_deposit_id_deposits_id_fk" FOREIGN KEY ("deposit_id") REFERENCES "public"."deposits"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "telegram_prompts" ADD CONSTRAINT "telegram_prompts_deposit_id_deposits_id_fk" FOREIGN KEY ("deposit_id") REFERENCES "public"."deposits"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "telegram_prompts_deposit_id_idx" ON "telegram_prompts" USING btree ("deposit_id");--> statement-breakpoint
ALTER TABLE "deposit_settings" ADD CONSTRAINT "deposit_settings_telegram_approval_check" CHECK ("deposit_settings"."telegram_approval_max_usd_units" between 0 and 100000000 and "deposit_settings"."telegram_approval_max_usd_units" % 10000 = 0);--> statement-breakpoint
ALTER TABLE "telegram_prompts" ADD CONSTRAINT "telegram_prompts_deposit_check" CHECK (("telegram_prompts"."deposit_id" is null) = ("telegram_prompts"."deposit_submitted_at" is null)
        and ("telegram_prompts"."deposit_id" is not null) = ("telegram_prompts"."kind" <> 'stop_confirm'));