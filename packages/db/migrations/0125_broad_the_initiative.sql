CREATE TABLE "usdt_transfer_dismissals" (
	"transfer_id" uuid PRIMARY KEY NOT NULL,
	"admin_id" uuid NOT NULL,
	"reason" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "usdt_transfer_dismissals_reason_check" CHECK (char_length("usdt_transfer_dismissals"."reason") between 1 and 500)
);
--> statement-breakpoint
ALTER TABLE "usdt_transfer_dismissals" ADD CONSTRAINT "usdt_transfer_dismissals_transfer_id_usdt_transfers_id_fk" FOREIGN KEY ("transfer_id") REFERENCES "public"."usdt_transfers"("id") ON DELETE no action ON UPDATE no action;