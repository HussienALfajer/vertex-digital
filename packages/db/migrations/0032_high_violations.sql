ALTER TYPE "public"."telegram_message_kind" ADD VALUE 'manual_order';--> statement-breakpoint
ALTER TYPE "public"."telegram_message_kind" ADD VALUE 'manual_order_reminder';--> statement-breakpoint
ALTER TYPE "public"."telegram_message_kind" ADD VALUE 'order_needs_review';--> statement-breakpoint
ALTER TYPE "public"."telegram_message_kind" ADD VALUE 'order_conflict';