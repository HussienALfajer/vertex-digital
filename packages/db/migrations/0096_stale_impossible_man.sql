CREATE INDEX "email_outbox_expiring_idx" ON "email_outbox" USING btree ("expires_at") WHERE "email_outbox"."params" is not null and "email_outbox"."expires_at" is not null;--> statement-breakpoint
CREATE INDEX "support_tickets_status_activity_idx" ON "support_tickets" USING btree ("status","updated_at" DESC NULLS LAST,"id" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "support_tickets_activity_idx" ON "support_tickets" USING btree ("updated_at" DESC NULLS LAST,"id" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "telegram_deposit_cards_message_idx" ON "telegram_deposit_cards" USING btree ("chat_id","message_id");--> statement-breakpoint
CREATE INDEX "telegram_messages_kind_idx" ON "telegram_messages" USING btree ("kind","created_at" DESC NULLS LAST,"id" DESC NULLS LAST);