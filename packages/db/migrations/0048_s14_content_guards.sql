-- Store content (S14, F21): what drizzle-kit cannot express. Hand-written; never edit once applied.

-- Append-only (PG5, FQ6): page versions and FAQ publications are new rows; the trigger of migration
-- 0001 refuses UPDATE, DELETE and TRUNCATE whoever runs them.
CREATE TRIGGER content_page_versions_append_only BEFORE UPDATE OR DELETE ON content_page_versions
  FOR EACH ROW EXECUTE FUNCTION append_only_guard();
--> statement-breakpoint
CREATE TRIGGER content_page_versions_no_truncate BEFORE TRUNCATE ON content_page_versions
  FOR EACH STATEMENT EXECUTE FUNCTION append_only_guard();
--> statement-breakpoint
CREATE TRIGGER faq_publications_append_only BEFORE UPDATE OR DELETE ON faq_publications
  FOR EACH ROW EXECUTE FUNCTION append_only_guard();
--> statement-breakpoint
CREATE TRIGGER faq_publications_no_truncate BEFORE TRUNCATE ON faq_publications
  FOR EACH STATEMENT EXECUTE FUNCTION append_only_guard();
--> statement-breakpoint

-- The app role keeps SELECT and INSERT only on the append-only tables, and loses DELETE and
-- TRUNCATE on the drafts, the settings row and the archived tables (archive, never delete):
-- revoked from PUBLIC and from every role but the owner, whatever the app role is called.
REVOKE UPDATE, DELETE, TRUNCATE ON content_page_versions, faq_publications FROM PUBLIC;
--> statement-breakpoint
REVOKE DELETE, TRUNCATE ON content_page_drafts, content_settings, faq_sections, faq_items, banners, announcements FROM PUBLIC;
--> statement-breakpoint
DO $$
DECLARE
  target regclass;
  grantee text;
BEGIN
  FOREACH target IN ARRAY ARRAY['content_page_versions'::regclass, 'faq_publications'::regclass]
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
  FOREACH target IN ARRAY ARRAY['content_page_drafts'::regclass, 'content_settings'::regclass, 'faq_sections'::regclass, 'faq_items'::regclass, 'banners'::regclass, 'announcements'::regclass]
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
--> statement-breakpoint

-- A customer's accepted versions are versions of their own page (TA2), and never change.
CREATE FUNCTION customers_accepted_versions_guard() RETURNS trigger LANGUAGE plpgsql
SET search_path = public, pg_temp AS $$
BEGIN
  IF TG_OP = 'UPDATE' AND (
    NEW.terms_version_id IS DISTINCT FROM OLD.terms_version_id
    OR NEW.privacy_version_id IS DISTINCT FROM OLD.privacy_version_id
  ) THEN
    RAISE EXCEPTION 'A customer''s accepted versions never change' USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.terms_version_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM public.content_page_versions WHERE id = NEW.terms_version_id AND page = 'terms'
  ) THEN
    RAISE EXCEPTION 'terms_version_id is not a terms version' USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.privacy_version_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM public.content_page_versions WHERE id = NEW.privacy_version_id AND page = 'privacy'
  ) THEN
    RAISE EXCEPTION 'privacy_version_id is not a privacy version' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER customers_accepted_versions BEFORE INSERT OR UPDATE OF terms_version_id, privacy_version_id ON customers
  FOR EACH ROW EXECUTE FUNCTION customers_accepted_versions_guard();
--> statement-breakpoint

-- The four page drafts (PG1), empty and unpublished, and the content settings' one row (LA6).
INSERT INTO content_page_drafts (page, title) VALUES
  ('terms', 'الشروط والأحكام'),
  ('privacy', 'سياسة الخصوصية'),
  ('refund', 'سياسة الاسترداد'),
  ('about', 'من نحن')
ON CONFLICT (page) DO NOTHING;
--> statement-breakpoint
INSERT INTO content_settings (id) VALUES (1) ON CONFLICT (id) DO NOTHING;
