-- S27 (ADR 0041): what drizzle-kit cannot express. Hand-written; never edit once applied.
--
-- `rate_settings` is append-only (versions). `rate_observations` is append-only and keeps 90 days:
-- only `purge_rate_observations`, a SECURITY DEFINER function owned by the owner role, deletes, and
-- the guard itself refuses any row younger than that. A source is archived, never deleted, and its
-- kind is fixed. A suggestion is never deleted; its proposal is fixed; its card is set once while
-- it is pending; it leaves `pending` once, and an ended suggestion never changes.

CREATE TRIGGER rate_settings_append_only BEFORE UPDATE OR DELETE ON rate_settings
  FOR EACH ROW EXECUTE FUNCTION append_only_guard();
--> statement-breakpoint
CREATE TRIGGER rate_settings_no_truncate BEFORE TRUNCATE ON rate_settings
  FOR EACH STATEMENT EXECUTE FUNCTION append_only_guard();
--> statement-breakpoint

CREATE FUNCTION rate_observations_guard() RETURNS trigger LANGUAGE plpgsql
SET search_path = public, pg_temp AS $$
BEGIN
  IF TG_OP = 'DELETE'
     AND current_setting('vertex.rate_observations_purge', true) = 'on'
     AND OLD.fetched_at < now() - interval '90 days' THEN
    RETURN OLD;
  END IF;
  RAISE EXCEPTION '% is append-only: % is not allowed', TG_TABLE_NAME, TG_OP;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER rate_observations_guard BEFORE UPDATE OR DELETE ON rate_observations
  FOR EACH ROW EXECUTE FUNCTION rate_observations_guard();
--> statement-breakpoint
CREATE TRIGGER rate_observations_no_truncate BEFORE TRUNCATE ON rate_observations
  FOR EACH STATEMENT EXECUTE FUNCTION append_only_guard();
--> statement-breakpoint

-- Deletes up to `batch` reads older than 90 days; how many.
CREATE FUNCTION purge_rate_observations(batch integer)
RETURNS integer LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, pg_temp AS $$
DECLARE
  deleted integer;
BEGIN
  IF batch IS NULL OR batch < 1 OR batch > 10000 THEN
    RAISE EXCEPTION 'purge_rate_observations: batch must be between 1 and 10000';
  END IF;
  PERFORM set_config('vertex.rate_observations_purge', 'on', true);
  DELETE FROM public.rate_observations
  WHERE id IN (
    SELECT o.id FROM public.rate_observations o
    WHERE o.fetched_at < now() - interval '90 days'
    ORDER BY o.fetched_at
    LIMIT batch);
  GET DIAGNOSTICS deleted = ROW_COUNT;
  PERFORM set_config('vertex.rate_observations_purge', 'off', true);
  RETURN deleted;
END;
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION purge_rate_observations(integer) FROM PUBLIC;
--> statement-breakpoint

CREATE FUNCTION rate_sources_guard() RETURNS trigger LANGUAGE plpgsql
SET search_path = public, pg_temp AS $$
BEGIN
  IF TG_OP = 'DELETE' OR TG_OP = 'TRUNCATE' THEN
    RAISE EXCEPTION 'rate sources are never deleted' USING ERRCODE = 'restrict_violation';
  END IF;
  IF NEW.id IS DISTINCT FROM OLD.id
    OR NEW.kind IS DISTINCT FROM OLD.kind
    OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'rate source %: its kind is fixed', OLD.id USING ERRCODE = 'restrict_violation';
  END IF;
  IF OLD.archived_at IS NOT NULL THEN
    RAISE EXCEPTION 'rate source %: archived', OLD.id USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER rate_sources_guard BEFORE UPDATE OR DELETE ON rate_sources
  FOR EACH ROW EXECUTE FUNCTION rate_sources_guard();
--> statement-breakpoint
CREATE TRIGGER rate_sources_truncate_guard BEFORE TRUNCATE ON rate_sources
  FOR EACH STATEMENT EXECUTE FUNCTION rate_sources_guard();
--> statement-breakpoint

CREATE FUNCTION rate_suggestions_guard() RETURNS trigger LANGUAGE plpgsql
SET search_path = public, pg_temp AS $$
BEGIN
  IF TG_OP = 'DELETE' OR TG_OP = 'TRUNCATE' THEN
    RAISE EXCEPTION 'rate suggestions are never deleted' USING ERRCODE = 'restrict_violation';
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW.status::text <> 'pending' THEN
      RAISE EXCEPTION 'a rate suggestion starts pending' USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
  END IF;
  IF NEW.id IS DISTINCT FROM OLD.id
    OR NEW.proposed_syp_per_usd IS DISTINCT FROM OLD.proposed_syp_per_usd
    OR NEW.base_rate_id IS DISTINCT FROM OLD.base_rate_id
    OR NEW.change_percent IS DISTINCT FROM OLD.change_percent
    OR NEW.reason IS DISTINCT FROM OLD.reason
    OR NEW.observation_ids IS DISTINCT FROM OLD.observation_ids
    OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'rate suggestion %: its proposal is fixed', OLD.id
      USING ERRCODE = 'restrict_violation';
  END IF;
  IF OLD.status::text <> 'pending' THEN
    RAISE EXCEPTION 'rate suggestion %: ended already', OLD.id USING ERRCODE = 'restrict_violation';
  END IF;
  IF OLD.telegram_message_id IS NOT NULL
    AND NEW.telegram_message_id IS DISTINCT FROM OLD.telegram_message_id THEN
    RAISE EXCEPTION 'rate suggestion %: its card is set once', OLD.id
      USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER rate_suggestions_guard BEFORE INSERT OR UPDATE OR DELETE ON rate_suggestions
  FOR EACH ROW EXECUTE FUNCTION rate_suggestions_guard();
--> statement-breakpoint
CREATE TRIGGER rate_suggestions_truncate_guard BEFORE TRUNCATE ON rate_suggestions
  FOR EACH STATEMENT EXECUTE FUNCTION rate_suggestions_guard();
--> statement-breakpoint

-- The app role keeps SELECT and INSERT only on the settings and the reads, and loses DELETE and
-- TRUNCATE on the sources and the suggestions: revoked from PUBLIC and from every role but the
-- owner, whatever the app role is called.
REVOKE UPDATE, DELETE, TRUNCATE ON rate_settings, rate_observations FROM PUBLIC;
--> statement-breakpoint
REVOKE DELETE, TRUNCATE ON rate_sources, rate_suggestions FROM PUBLIC;
--> statement-breakpoint
DO $$
DECLARE
  target regclass;
  grantee text;
BEGIN
  FOREACH target IN ARRAY ARRAY['rate_settings'::regclass, 'rate_observations'::regclass]
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
  FOREACH target IN ARRAY ARRAY['rate_sources'::regclass, 'rate_suggestions'::regclass]
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

-- The purge runs for every non-owner role holding INSERT on the reads (the app role), found as
-- migration 0103 finds them, so no role is named.
DO $$
DECLARE
  grantee text;
BEGIN
  FOR grantee IN
    SELECT DISTINCT acl.grantee::regrole::text
    FROM pg_class AS c, aclexplode(c.relacl) AS acl
    WHERE c.oid = 'rate_observations'::regclass
      AND acl.privilege_type = 'INSERT'
      AND acl.grantee <> c.relowner
      AND acl.grantee <> 0
  LOOP
    EXECUTE format('GRANT EXECUTE ON FUNCTION purge_rate_observations(integer) TO %s', grantee);
  END LOOP;
END;
$$;
