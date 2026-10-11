CREATE TYPE "public"."announcement_tone" AS ENUM('info', 'warning');--> statement-breakpoint
CREATE TYPE "public"."content_page" AS ENUM('terms', 'privacy', 'refund', 'about');--> statement-breakpoint
CREATE TABLE "announcements" (
	"id" uuid PRIMARY KEY NOT NULL,
	"text" text NOT NULL,
	"tone" "announcement_tone" DEFAULT 'info' NOT NULL,
	"link_path" text,
	"starts_at" timestamp with time zone,
	"ends_at" timestamp with time zone,
	"enabled" boolean DEFAULT false NOT NULL,
	"revision" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"archived_at" timestamp with time zone,
	CONSTRAINT "announcements_text_check" CHECK (char_length("announcements"."text") between 5 and 140),
	CONSTRAINT "announcements_revision_check" CHECK ("announcements"."revision" >= 1),
	CONSTRAINT "announcements_schedule_check" CHECK ("announcements"."starts_at" is null or "announcements"."ends_at" is null or "announcements"."ends_at" > "announcements"."starts_at"),
	CONSTRAINT "announcements_archived_check" CHECK (not ("announcements"."enabled" and "announcements"."archived_at" is not null)),
	CONSTRAINT "announcements_link_path_check" CHECK ("announcements"."link_path" is null or (char_length("announcements"."link_path") <= 200 and "announcements"."link_path" ~ '^/([A-Za-z0-9._~/-]*)?(#[A-Za-z0-9_-]+)?$' and "announcements"."link_path" !~ '^//' and "announcements"."link_path" !~ '(^|/)\.\.(/|#|$)'))
);
--> statement-breakpoint
CREATE TABLE "banners" (
	"id" uuid PRIMARY KEY NOT NULL,
	"image_file_id" uuid NOT NULL,
	"alt_text" text NOT NULL,
	"link_path" text,
	"starts_at" timestamp with time zone,
	"ends_at" timestamp with time zone,
	"enabled" boolean DEFAULT false NOT NULL,
	"position" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"archived_at" timestamp with time zone,
	CONSTRAINT "banners_alt_text_check" CHECK (char_length("banners"."alt_text") between 2 and 120),
	CONSTRAINT "banners_schedule_check" CHECK ("banners"."starts_at" is null or "banners"."ends_at" is null or "banners"."ends_at" > "banners"."starts_at"),
	CONSTRAINT "banners_archived_check" CHECK (not ("banners"."enabled" and "banners"."archived_at" is not null)),
	CONSTRAINT "banners_link_path_check" CHECK ("banners"."link_path" is null or (char_length("banners"."link_path") <= 200 and "banners"."link_path" ~ '^/([A-Za-z0-9._~/-]*)?(#[A-Za-z0-9_-]+)?$' and "banners"."link_path" !~ '^//' and "banners"."link_path" !~ '(^|/)\.\.(/|#|$)'))
);
--> statement-breakpoint
CREATE TABLE "content_page_drafts" (
	"page" "content_page" PRIMARY KEY NOT NULL,
	"title" text NOT NULL,
	"body" text DEFAULT '' NOT NULL,
	"revision" integer DEFAULT 0 NOT NULL,
	"updated_by" uuid,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "content_page_drafts_title_check" CHECK (char_length("content_page_drafts"."title") between 2 and 80),
	CONSTRAINT "content_page_drafts_body_check" CHECK (char_length("content_page_drafts"."body") <= 30000),
	CONSTRAINT "content_page_drafts_revision_check" CHECK ("content_page_drafts"."revision" >= 0)
);
--> statement-breakpoint
CREATE TABLE "content_page_versions" (
	"id" uuid PRIMARY KEY NOT NULL,
	"page" "content_page" NOT NULL,
	"version" integer NOT NULL,
	"title" text NOT NULL,
	"body" text NOT NULL,
	"draft_revision" integer NOT NULL,
	"admin_id" uuid NOT NULL,
	"published_at" timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
	CONSTRAINT "content_page_versions_version_check" CHECK ("content_page_versions"."version" >= 1),
	CONSTRAINT "content_page_versions_title_check" CHECK (char_length("content_page_versions"."title") between 2 and 80),
	CONSTRAINT "content_page_versions_body_check" CHECK (char_length("content_page_versions"."body") between 1 and 30000)
);
--> statement-breakpoint
CREATE TABLE "content_settings" (
	"id" integer PRIMARY KEY NOT NULL,
	"live_activity_enabled" boolean DEFAULT true NOT NULL,
	"faq_revision" integer DEFAULT 0 NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "content_settings_one_row_check" CHECK ("content_settings"."id" = 1),
	CONSTRAINT "content_settings_faq_revision_check" CHECK ("content_settings"."faq_revision" >= 0)
);
--> statement-breakpoint
CREATE TABLE "faq_items" (
	"id" uuid PRIMARY KEY NOT NULL,
	"section_id" uuid NOT NULL,
	"question" text NOT NULL,
	"answer" text NOT NULL,
	"position" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"archived_at" timestamp with time zone,
	CONSTRAINT "faq_items_question_check" CHECK (char_length("faq_items"."question") between 5 and 200),
	CONSTRAINT "faq_items_answer_check" CHECK (char_length("faq_items"."answer") between 1 and 3000)
);
--> statement-breakpoint
CREATE TABLE "faq_publications" (
	"id" uuid PRIMARY KEY NOT NULL,
	"faq_revision" integer NOT NULL,
	"sections" jsonb NOT NULL,
	"admin_id" uuid NOT NULL,
	"published_at" timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
	CONSTRAINT "faq_publications_sections_check" CHECK (jsonb_typeof("faq_publications"."sections") = 'array')
);
--> statement-breakpoint
CREATE TABLE "faq_sections" (
	"id" uuid PRIMARY KEY NOT NULL,
	"title" text NOT NULL,
	"position" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"archived_at" timestamp with time zone,
	CONSTRAINT "faq_sections_title_check" CHECK (char_length("faq_sections"."title") between 2 and 60)
);
--> statement-breakpoint
ALTER TABLE "customers" ADD COLUMN "terms_version_id" uuid;--> statement-breakpoint
ALTER TABLE "customers" ADD COLUMN "privacy_version_id" uuid;--> statement-breakpoint
ALTER TABLE "banners" ADD CONSTRAINT "banners_image_file_id_stored_files_id_fk" FOREIGN KEY ("image_file_id") REFERENCES "public"."stored_files"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "faq_items" ADD CONSTRAINT "faq_items_section_id_faq_sections_id_fk" FOREIGN KEY ("section_id") REFERENCES "public"."faq_sections"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "announcements_one_enabled_idx" ON "announcements" USING btree ("enabled") WHERE "announcements"."enabled" and "announcements"."archived_at" is null;--> statement-breakpoint
CREATE INDEX "banners_image_file_id_idx" ON "banners" USING btree ("image_file_id");--> statement-breakpoint
CREATE UNIQUE INDEX "content_page_versions_page_version_idx" ON "content_page_versions" USING btree ("page","version" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "faq_items_section_id_position_idx" ON "faq_items" USING btree ("section_id","position");--> statement-breakpoint
CREATE INDEX "faq_publications_published_at_idx" ON "faq_publications" USING btree ("published_at" DESC NULLS LAST);--> statement-breakpoint
ALTER TABLE "customers" ADD CONSTRAINT "customers_terms_version_id_content_page_versions_id_fk" FOREIGN KEY ("terms_version_id") REFERENCES "public"."content_page_versions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "customers" ADD CONSTRAINT "customers_privacy_version_id_content_page_versions_id_fk" FOREIGN KEY ("privacy_version_id") REFERENCES "public"."content_page_versions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "customers_terms_version_id_idx" ON "customers" USING btree ("terms_version_id");--> statement-breakpoint
CREATE INDEX "customers_privacy_version_id_idx" ON "customers" USING btree ("privacy_version_id");--> statement-breakpoint
CREATE INDEX "orders_activity_idx" ON "orders" USING btree ("delivered_at" DESC NULLS LAST) WHERE "orders"."status" = 'delivered' and not "orders"."is_test";