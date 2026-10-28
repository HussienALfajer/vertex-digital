ALTER TABLE "email_outbox" ALTER COLUMN "to_address" DROP NOT NULL;--> statement-breakpoint
CREATE INDEX "customer_sign_ins_created_at_idx" ON "customer_sign_ins" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "usdt_deposits_txid_idx" ON "usdt_deposits" USING btree ("txid") WHERE "usdt_deposits"."txid" is not null;--> statement-breakpoint
CREATE INDEX "merchant_profiles_granted_at_idx" ON "merchant_profiles" USING btree ("granted_at" DESC NULLS LAST,"customer_id" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "product_alerts_ended_at_idx" ON "product_alerts" USING btree ("ended_at") WHERE "product_alerts"."ended_at" is not null;--> statement-breakpoint
CREATE INDEX "telegram_updates_received_at_idx" ON "telegram_updates" USING btree ("received_at");