CREATE INDEX "audit_entries_entity_id_idx" ON "audit_entries" USING btree ("entity_id","occurred_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "fulfilment_attempts_sent_at_idx" ON "fulfilment_attempts" USING btree ("sent_at");--> statement-breakpoint
CREATE INDEX "ledger_journals_created_at_idx" ON "ledger_journals" USING btree ("created_at");