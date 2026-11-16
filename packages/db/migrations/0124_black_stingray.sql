DROP INDEX "rate_sources_live_handle_idx";--> statement-breakpoint
CREATE UNIQUE INDEX "rate_sources_live_handle_idx" ON "rate_sources" USING btree ("kind",lower("handle")) WHERE archived_at is null;