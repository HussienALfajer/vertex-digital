-- S20 PR 3 (F28, ADR 0035): the merchant tables' guards, grants and seeds, and the `merchant_terms`
-- page draft. Hand-written; never edit once applied.

-- Drizzle applies every pending migration in one transaction, and a value 0080 added with
-- `ALTER TYPE ... ADD VALUE` cannot be used before that transaction commits. So `content_page` is
-- recreated here, as 0069 did for `supplier_code`, on the same list of values (no change for
-- drizzle-kit's snapshot): a type created in this transaction may use all its values at once.
ALTER TABLE "content_page_drafts" ALTER COLUMN "page" SET DATA TYPE text;
--> statement-breakpoint
ALTER TABLE "content_page_versions" ALTER COLUMN "page" SET DATA TYPE text;
--> statement-breakpoint
DROP TYPE "public"."content_page";
--> statement-breakpoint
CREATE TYPE "public"."content_page" AS ENUM('terms', 'privacy', 'refund', 'about', 'merchant_terms');
--> statement-breakpoint
ALTER TABLE "content_page_drafts" ALTER COLUMN "page" SET DATA TYPE "public"."content_page" USING "page"::"public"."content_page";
--> statement-breakpoint
ALTER TABLE "content_page_versions" ALTER COLUMN "page" SET DATA TYPE "public"."content_page" USING "page"::"public"."content_page";
--> statement-breakpoint

-- MT1: the merchant terms' draft, empty and unpublished (as 0048's four pages).
INSERT INTO content_page_drafts (page, title) VALUES ('merchant_terms', 'شروط حساب التاجر')
ON CONFLICT (page) DO NOTHING;
--> statement-breakpoint

-- The seeded merchant settings (owner decisions 1, 7, 8): $2,000 a deposit, $5,000 in 24 hours,
-- 60 orders per 10 minutes, 7 days to reapply after a rejection, 7 days to answer a request.
INSERT INTO merchant_settings (id, per_deposit_usd_units, daily_deposit_usd_units, orders_per_ten_minutes, reapply_wait_days, info_expiry_days, admin_id)
VALUES ('01a20f6e-3a1c-7b4d-9e2f-5c6d7e8f9a10', 2000000000, 5000000000, 60, 7, 7, NULL)
ON CONFLICT DO NOTHING;
--> statement-breakpoint

-- Append-only: the timeline, the settings versions and the photos' owners are new rows; the
-- trigger of migration 0001 refuses UPDATE, DELETE and TRUNCATE whoever runs them.
CREATE TRIGGER merchant_application_events_append_only BEFORE UPDATE OR DELETE ON merchant_application_events
  FOR EACH ROW EXECUTE FUNCTION append_only_guard();
--> statement-breakpoint
CREATE TRIGGER merchant_application_events_no_truncate BEFORE TRUNCATE ON merchant_application_events
  FOR EACH STATEMENT EXECUTE FUNCTION append_only_guard();
--> statement-breakpoint
CREATE TRIGGER merchant_settings_append_only BEFORE UPDATE OR DELETE ON merchant_settings
  FOR EACH ROW EXECUTE FUNCTION append_only_guard();
--> statement-breakpoint
CREATE TRIGGER merchant_settings_no_truncate BEFORE TRUNCATE ON merchant_settings
  FOR EACH STATEMENT EXECUTE FUNCTION append_only_guard();
--> statement-breakpoint
CREATE TRIGGER merchant_shop_photos_append_only BEFORE UPDATE OR DELETE ON merchant_shop_photos
  FOR EACH ROW EXECUTE FUNCTION append_only_guard();
--> statement-breakpoint
CREATE TRIGGER merchant_shop_photos_no_truncate BEFORE TRUNCATE ON merchant_shop_photos
  FOR EACH STATEMENT EXECUTE FUNCTION append_only_guard();
--> statement-breakpoint

-- A version named by an application or a profile is a version of the merchant terms (MT2).
CREATE FUNCTION merchant_terms_version_check(version_id uuid) RETURNS void LANGUAGE plpgsql
SET search_path = public, pg_temp AS $$
BEGIN
  IF version_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM public.content_page_versions WHERE id = version_id AND page = 'merchant_terms'
  ) THEN
    RAISE EXCEPTION 'terms_version_id is not a merchant_terms version' USING ERRCODE = 'check_violation';
  END IF;
END;
$$;
--> statement-breakpoint

-- MA4: an application starts under review, moves only on the transition table, never leaves a
-- final status and is never deleted; its customer, key and submission are fixed, and the form
-- changes only on a resubmission (`info_requested → under_review`). Its photo is its customer's.
CREATE FUNCTION merchant_applications_guard() RETURNS trigger LANGUAGE plpgsql
SET search_path = public, pg_temp AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'merchant applications are never deleted' USING ERRCODE = 'restrict_violation';
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW.status <> 'under_review' OR NEW.decided_at IS NOT NULL OR NEW.info_requested_at IS NOT NULL THEN
      RAISE EXCEPTION 'a merchant application starts under review' USING ERRCODE = 'check_violation';
    END IF;
  ELSE
    IF OLD.status IN ('approved', 'rejected', 'expired', 'withdrawn') THEN
      RAISE EXCEPTION 'merchant application %: % is final', OLD.id, OLD.status
        USING ERRCODE = 'restrict_violation';
    END IF;
    IF NEW.id IS DISTINCT FROM OLD.id
      OR NEW.customer_id IS DISTINCT FROM OLD.customer_id
      OR NEW.idempotency_key IS DISTINCT FROM OLD.idempotency_key
      OR NEW.submitted_at IS DISTINCT FROM OLD.submitted_at
      OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
      RAISE EXCEPTION 'merchant application %: its customer, key and submission are fixed', OLD.id
        USING ERRCODE = 'restrict_violation';
    END IF;
    IF NEW.status IS DISTINCT FROM OLD.status AND NOT (
      (OLD.status = 'under_review' AND NEW.status IN ('info_requested', 'approved', 'rejected', 'withdrawn'))
      OR (OLD.status = 'info_requested' AND NEW.status IN ('under_review', 'withdrawn', 'expired', 'approved'))
    ) THEN
      RAISE EXCEPTION 'merchant application %: % → % is not an allowed transition', OLD.id, OLD.status, NEW.status
        USING ERRCODE = 'restrict_violation';
    END IF;
    IF NOT (OLD.status = 'info_requested' AND NEW.status = 'under_review') AND (
      NEW.trade_name IS DISTINCT FROM OLD.trade_name
      OR NEW.activity IS DISTINCT FROM OLD.activity
      OR NEW.activity_other IS DISTINCT FROM OLD.activity_other
      OR NEW.years_in_business IS DISTINCT FROM OLD.years_in_business
      OR NEW.governorate IS DISTINCT FROM OLD.governorate
      OR NEW.city IS DISTINCT FROM OLD.city
      OR NEW.street_address IS DISTINCT FROM OLD.street_address
      OR NEW.whatsapp IS DISTINCT FROM OLD.whatsapp
      OR NEW.telegram_username IS DISTINCT FROM OLD.telegram_username
      OR NEW.monthly_volume IS DISTINCT FROM OLD.monthly_volume
      OR NEW.product_interests IS DISTINCT FROM OLD.product_interests
      OR NEW.sales_channels IS DISTINCT FROM OLD.sales_channels
      OR NEW.shop_photo_file_id IS DISTINCT FROM OLD.shop_photo_file_id
      OR NEW.shop_link IS DISTINCT FROM OLD.shop_link
      OR NEW.terms_version_id IS DISTINCT FROM OLD.terms_version_id
      OR NEW.heard_from IS DISTINCT FROM OLD.heard_from
    ) THEN
      RAISE EXCEPTION 'merchant application %: the form changes only on a resubmission', OLD.id
        USING ERRCODE = 'restrict_violation';
    END IF;
  END IF;
  PERFORM public.merchant_terms_version_check(NEW.terms_version_id);
  IF NEW.shop_photo_file_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM public.merchant_shop_photos
    WHERE file_id = NEW.shop_photo_file_id AND customer_id = NEW.customer_id
  ) THEN
    RAISE EXCEPTION 'the shop photo is not the applicant''s' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER merchant_applications_guard BEFORE INSERT OR UPDATE OR DELETE ON merchant_applications
  FOR EACH ROW EXECUTE FUNCTION merchant_applications_guard();
--> statement-breakpoint

-- MA5–MA7, MT2: a profile is updated in place (a re-grant, a revocation, the terms), never deleted;
-- its customer is fixed and its terms are a merchant terms version.
CREATE FUNCTION merchant_profiles_guard() RETURNS trigger LANGUAGE plpgsql
SET search_path = public, pg_temp AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'merchant profiles are never deleted' USING ERRCODE = 'restrict_violation';
  END IF;
  IF TG_OP = 'UPDATE' AND NEW.customer_id IS DISTINCT FROM OLD.customer_id THEN
    RAISE EXCEPTION 'merchant profile %: its customer is fixed', OLD.customer_id
      USING ERRCODE = 'restrict_violation';
  END IF;
  PERFORM public.merchant_terms_version_check(NEW.terms_version_id);
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER merchant_profiles_guard BEFORE INSERT OR UPDATE OR DELETE ON merchant_profiles
  FOR EACH ROW EXECUTE FUNCTION merchant_profiles_guard();
--> statement-breakpoint

-- The app role keeps SELECT and INSERT only on the append-only tables, and loses DELETE and
-- TRUNCATE on applications and profiles: revoked from PUBLIC and from every role but the owner,
-- whatever the app role is called.
REVOKE UPDATE, DELETE, TRUNCATE ON merchant_application_events, merchant_settings, merchant_shop_photos FROM PUBLIC;
--> statement-breakpoint
REVOKE DELETE, TRUNCATE ON merchant_applications, merchant_profiles FROM PUBLIC;
--> statement-breakpoint
DO $$
DECLARE
  target regclass;
  grantee text;
BEGIN
  FOREACH target IN ARRAY ARRAY['merchant_application_events'::regclass, 'merchant_settings'::regclass, 'merchant_shop_photos'::regclass]
  LOOP
    FOR grantee IN
      SELECT DISTINCT acl.grantee::regrole::text
      FROM pg_class AS c, aclexplode(c.relacl) AS acl
      WHERE c.oid = target
        AND acl.grantee <> c.relowner
        AND acl.grantee <> 0
    LOOP
      EXECUTE format('REVOKE UPDATE, DELETE, TRUNCATE ON %s FROM %s', target, grantee);
    END LOOP;
  END LOOP;
  FOREACH target IN ARRAY ARRAY['merchant_applications'::regclass, 'merchant_profiles'::regclass]
  LOOP
    FOR grantee IN
      SELECT DISTINCT acl.grantee::regrole::text
      FROM pg_class AS c, aclexplode(c.relacl) AS acl
      WHERE c.oid = target
        AND acl.grantee <> c.relowner
        AND acl.grantee <> 0
    LOOP
      EXECUTE format('REVOKE DELETE, TRUNCATE ON %s FROM %s', target, grantee);
    END LOOP;
  END LOOP;
END;
$$;
