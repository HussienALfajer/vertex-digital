ALTER TYPE "public"."email_template" ADD VALUE 'customer_passkey_added' BEFORE 'customer_sign_up_attempt';--> statement-breakpoint
CREATE TABLE "customer_passkeys" (
	"id" uuid PRIMARY KEY NOT NULL,
	"customer_id" uuid NOT NULL,
	"name" text NOT NULL,
	"public_key" text NOT NULL,
	"credential_id" text NOT NULL,
	"counter" bigint NOT NULL,
	"device_type" text NOT NULL,
	"backed_up" boolean NOT NULL,
	"transports" text,
	"aaguid" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_used_at" timestamp with time zone,
	CONSTRAINT "customer_passkeys_name_check" CHECK (char_length("customer_passkeys"."name") between 1 and 40 and "customer_passkeys"."name" = btrim("customer_passkeys"."name")),
	CONSTRAINT "customer_passkeys_device_type_check" CHECK ("customer_passkeys"."device_type" in ('singleDevice', 'multiDevice')),
	CONSTRAINT "customer_passkeys_counter_check" CHECK ("customer_passkeys"."counter" >= 0)
);
--> statement-breakpoint
ALTER TABLE "customer_passkeys" ADD CONSTRAINT "customer_passkeys_customer_id_customers_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "customer_passkeys_credential_id_idx" ON "customer_passkeys" USING btree ("credential_id");--> statement-breakpoint
CREATE INDEX "customer_passkeys_customer_idx" ON "customer_passkeys" USING btree ("customer_id","created_at");