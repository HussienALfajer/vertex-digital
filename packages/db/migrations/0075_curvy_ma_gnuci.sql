CREATE TYPE "public"."price_list_kind" AS ENUM('retail', 'wholesale', 'cost', 'custom');--> statement-breakpoint
ALTER TYPE "public"."order_cancel_reason" ADD VALUE 'price_list_changed';--> statement-breakpoint
ALTER TYPE "public"."price_change_cause" ADD VALUE 'list_change';--> statement-breakpoint
CREATE TABLE "price_lists" (
	"id" uuid PRIMARY KEY NOT NULL,
	"kind" "price_list_kind" NOT NULL,
	"name" text NOT NULL,
	"parent_list_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"archived_at" timestamp with time zone,
	CONSTRAINT "price_lists_name_check" CHECK ("price_lists"."name" = btrim("price_lists"."name") and char_length("price_lists"."name") between 2 and 60),
	CONSTRAINT "price_lists_parent_check" CHECK (("price_lists"."kind" = 'custom') = ("price_lists"."parent_list_id" is not null))
);
--> statement-breakpoint
ALTER TABLE "price_lists" ADD CONSTRAINT "price_lists_parent_list_id_price_lists_id_fk" FOREIGN KEY ("parent_list_id") REFERENCES "public"."price_lists"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "price_lists_root_kind_live_idx" ON "price_lists" USING btree ("kind") WHERE "price_lists"."kind" <> 'custom' and "price_lists"."archived_at" is null;--> statement-breakpoint
CREATE UNIQUE INDEX "price_lists_name_live_idx" ON "price_lists" USING btree (lower("name")) WHERE "price_lists"."archived_at" is null;--> statement-breakpoint
CREATE INDEX "price_lists_parent_list_id_idx" ON "price_lists" USING btree ("parent_list_id");