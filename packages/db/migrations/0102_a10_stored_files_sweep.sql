ALTER TABLE "stored_files" ADD COLUMN "unreferenced_since" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "stored_files" ADD COLUMN "swept_at" timestamp with time zone;