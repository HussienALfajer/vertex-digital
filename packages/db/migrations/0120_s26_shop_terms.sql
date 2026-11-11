-- S26 CA5 (PR 4): the merchant shops' terms page draft. Hand-written; never edit once applied.

-- Drizzle applies every pending migration in one transaction, and a value 0119 added with
-- `ALTER TYPE ... ADD VALUE` cannot be used before that transaction commits. So `content_page` is
-- recreated here, as 0081 did, on the same list of values (no change for drizzle-kit's snapshot):
-- a type created in this transaction may use all its values at once.
ALTER TABLE "content_page_drafts" ALTER COLUMN "page" SET DATA TYPE text;
--> statement-breakpoint
ALTER TABLE "content_page_versions" ALTER COLUMN "page" SET DATA TYPE text;
--> statement-breakpoint
DROP TYPE "public"."content_page";
--> statement-breakpoint
CREATE TYPE "public"."content_page" AS ENUM('terms', 'privacy', 'refund', 'about', 'merchant_terms', 'shop_terms');
--> statement-breakpoint
ALTER TABLE "content_page_drafts" ALTER COLUMN "page" SET DATA TYPE "public"."content_page" USING "page"::"public"."content_page";
--> statement-breakpoint
ALTER TABLE "content_page_versions" ALTER COLUMN "page" SET DATA TYPE "public"."content_page" USING "page"::"public"."content_page";
--> statement-breakpoint

-- CA5: the shops' terms draft, empty and unpublished (as 0081's merchant terms). Until it is
-- published, a shop shows and records the store's own terms.
INSERT INTO content_page_drafts (page, title) VALUES ('shop_terms', 'شروط متاجر التجار')
ON CONFLICT (page) DO NOTHING;
