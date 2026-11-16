ALTER TABLE "telegram_prompts" DROP CONSTRAINT "telegram_prompts_deposit_check";--> statement-breakpoint
ALTER TABLE "telegram_prompts" ADD CONSTRAINT "telegram_prompts_deposit_check" CHECK (("telegram_prompts"."deposit_id" is null) = ("telegram_prompts"."deposit_submitted_at" is null)
        and ("telegram_prompts"."deposit_id" is not null)
          = ("telegram_prompts"."kind" in ('approve_number', 'approve_confirm', 'reject_note')));