-- Audit A10 follow-ups, decided under the owner's delegation (2026-10-29).
--
-- A10-54: `supplier_calls` and `supplier_balance_reads` keep 180 days. Rows stay append-only for
-- every role; only `purge_supplier_logs`, a SECURITY DEFINER function owned by the owner role, may
-- delete, and the guard itself refuses any row younger than 180 days. A call at or after its
-- supplier's newest health change is kept (a `down` supplier's probe reads every call since then),
-- and so is each supplier's newest balance read per currency (routing and the money places read
-- it).
--
-- A10-45: a catalog image, Sham Cash QR image or merchant logo that no row references for 30 days
-- loses its file. The row stays as the record; `unreferenced_since` and `swept_at` are the only
-- columns that ever change, through the two `stored_files_*` functions only, and a swept row is
-- final. Receipts, delivery proofs, ticket attachments and shop photos are never swept. The app
-- role keeps SELECT and INSERT only on all three tables (migrations 0012 and 0027).

CREATE FUNCTION supplier_logs_guard() RETURNS trigger LANGUAGE plpgsql
SET search_path = public, pg_temp AS $$
BEGIN
  IF TG_OP = 'DELETE'
     AND current_setting('vertex.supplier_logs_purge', true) = 'on'
     AND OLD.created_at < now() - interval '180 days' THEN
    RETURN OLD;
  END IF;
  RAISE EXCEPTION '% is append-only: % is not allowed', TG_TABLE_NAME, TG_OP;
END;
$$;
--> statement-breakpoint
DROP TRIGGER supplier_calls_append_only ON supplier_calls;
--> statement-breakpoint
CREATE TRIGGER supplier_calls_guard BEFORE UPDATE OR DELETE ON supplier_calls
  FOR EACH ROW EXECUTE FUNCTION supplier_logs_guard();
--> statement-breakpoint
DROP TRIGGER supplier_balance_reads_append_only ON supplier_balance_reads;
--> statement-breakpoint
CREATE TRIGGER supplier_balance_reads_guard BEFORE UPDATE OR DELETE ON supplier_balance_reads
  FOR EACH ROW EXECUTE FUNCTION supplier_logs_guard();
--> statement-breakpoint

-- Deletes up to `batch` calls and up to `batch` balance reads past the retention; how many of each.
CREATE FUNCTION purge_supplier_logs(batch integer)
RETURNS TABLE (calls integer, balance_reads integer) LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, pg_temp AS $$
BEGIN
  IF batch IS NULL OR batch < 1 OR batch > 10000 THEN
    RAISE EXCEPTION 'purge_supplier_logs: batch must be between 1 and 10000';
  END IF;
  PERFORM set_config('vertex.supplier_logs_purge', 'on', true);
  DELETE FROM public.supplier_calls
  WHERE id IN (
    SELECT c.id FROM public.supplier_calls c
    WHERE c.created_at < now() - interval '180 days'
      AND c.created_at < coalesce(
        (SELECT max(h.created_at) FROM public.supplier_health_changes h
         WHERE h.supplier_id = c.supplier_id),
        'infinity'::timestamptz)
    ORDER BY c.created_at
    LIMIT batch);
  GET DIAGNOSTICS calls = ROW_COUNT;
  DELETE FROM public.supplier_balance_reads
  WHERE id IN (
    SELECT r.id FROM public.supplier_balance_reads r
    WHERE r.created_at < now() - interval '180 days'
      AND r.id <> (
        SELECT n.id FROM public.supplier_balance_reads n
        WHERE n.supplier_id = r.supplier_id AND n.currency = r.currency
        ORDER BY n.created_at DESC, n.id DESC
        LIMIT 1)
    ORDER BY r.created_at
    LIMIT batch);
  GET DIAGNOSTICS balance_reads = ROW_COUNT;
  PERFORM set_config('vertex.supplier_logs_purge', 'off', true);
  RETURN NEXT;
END;
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION purge_supplier_logs(integer) FROM PUBLIC;
--> statement-breakpoint

CREATE FUNCTION stored_files_guard() RETURNS trigger LANGUAGE plpgsql
SET search_path = public, pg_temp AS $$
BEGIN
  IF TG_OP = 'UPDATE'
     AND current_setting('vertex.stored_files_sweep', true) = 'on'
     AND OLD.swept_at IS NULL
     AND OLD.kind IN ('catalog_image', 'sham_cash_qr', 'merchant_logo')
     AND to_jsonb(NEW) - 'unreferenced_since' - 'swept_at'
       = to_jsonb(OLD) - 'unreferenced_since' - 'swept_at'
     AND (NEW.swept_at IS NULL OR (
       OLD.unreferenced_since < now() - interval '30 days'
       AND NEW.unreferenced_since = OLD.unreferenced_since
       AND OLD.created_at < now() - interval '30 days')) THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'stored_files is append-only: % is not allowed', TG_OP;
END;
$$;
--> statement-breakpoint
DROP TRIGGER stored_files_append_only ON stored_files;
--> statement-breakpoint
CREATE TRIGGER stored_files_guard BEFORE UPDATE OR DELETE ON stored_files
  FOR EACH ROW EXECUTE FUNCTION stored_files_guard();
--> statement-breakpoint

-- The condition "no row references `f`", built from every single-column foreign key to
-- `stored_files`, so a table added later is counted without changing these functions.
CREATE FUNCTION stored_files_unreferenced_condition() RETURNS text LANGUAGE sql STABLE
SET search_path = public, pg_temp AS $$
  SELECT coalesce(string_agg(
    format('NOT EXISTS (SELECT 1 FROM %I.%I r WHERE r.%I = f.id)', n.nspname, t.relname, a.attname),
    ' AND ' ORDER BY t.relname, a.attname), 'true')
  FROM pg_constraint c
  JOIN pg_class t ON t.oid = c.conrelid
  JOIN pg_namespace n ON n.oid = t.relnamespace
  JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = c.conkey[1]
  WHERE c.contype = 'f'
    AND c.confrelid = 'public.stored_files'::regclass
    AND cardinality(c.conkey) = 1;
$$;
--> statement-breakpoint

-- Stamps `unreferenced_since` on sweepable files nothing references, and clears it on files a row
-- references again; how many rows changed.
CREATE FUNCTION stored_files_mark_unreferenced() RETURNS integer LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, pg_temp AS $$
DECLARE
  unreferenced text := public.stored_files_unreferenced_condition();
  changed integer;
BEGIN
  PERFORM set_config('vertex.stored_files_sweep', 'on', true);
  EXECUTE format(
    'UPDATE public.stored_files f
     SET unreferenced_since = CASE WHEN %1$s THEN coalesce(f.unreferenced_since, now()) END
     WHERE f.swept_at IS NULL
       AND f.kind IN (''catalog_image'', ''sham_cash_qr'', ''merchant_logo'')
       AND (f.unreferenced_since IS NULL) = (%1$s)',
    unreferenced);
  GET DIAGNOSTICS changed = ROW_COUNT;
  PERFORM set_config('vertex.stored_files_sweep', 'off', true);
  RETURN changed;
END;
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION stored_files_mark_unreferenced() FROM PUBLIC;
--> statement-breakpoint

-- Marks up to `batch` files swept that have been unreferenced for 30 days and still are; their
-- storage keys, for the caller to remove from disk.
CREATE FUNCTION stored_files_sweep(batch integer) RETURNS SETOF text LANGUAGE plpgsql
SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  unreferenced text := public.stored_files_unreferenced_condition();
  keys text[];
BEGIN
  IF batch IS NULL OR batch < 1 OR batch > 1000 THEN
    RAISE EXCEPTION 'stored_files_sweep: batch must be between 1 and 1000';
  END IF;
  PERFORM set_config('vertex.stored_files_sweep', 'on', true);
  EXECUTE format(
    'WITH due AS (
       SELECT f.id FROM public.stored_files f
       WHERE f.swept_at IS NULL
         AND f.kind IN (''catalog_image'', ''sham_cash_qr'', ''merchant_logo'')
         AND f.unreferenced_since < now() - interval ''30 days''
         AND f.created_at < now() - interval ''30 days''
         AND %s
       ORDER BY f.created_at
       LIMIT %s
       FOR UPDATE OF f SKIP LOCKED),
     swept AS (
       UPDATE public.stored_files s SET swept_at = now()
       FROM due WHERE s.id = due.id
       RETURNING s.storage_key)
     SELECT coalesce(array_agg(storage_key), ''{}'') FROM swept',
    unreferenced, batch) INTO keys;
  PERFORM set_config('vertex.stored_files_sweep', 'off', true);
  RETURN QUERY SELECT unnest(keys);
END;
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION stored_files_sweep(integer) FROM PUBLIC;
--> statement-breakpoint

-- The three functions run for every non-owner role holding INSERT on their tables (the app role),
-- found as `0001_ledger_guards.sql` finds the grantees it revokes from, so no role is named.
DO $$
DECLARE
  grantee text;
BEGIN
  FOR grantee IN
    SELECT DISTINCT acl.grantee::regrole::text
    FROM pg_class AS c, aclexplode(c.relacl) AS acl
    WHERE c.oid IN ('supplier_calls'::regclass, 'stored_files'::regclass)
      AND acl.privilege_type = 'INSERT'
      AND acl.grantee <> c.relowner
      AND acl.grantee <> 0
  LOOP
    EXECUTE format('GRANT EXECUTE ON FUNCTION purge_supplier_logs(integer) TO %s', grantee);
    EXECUTE format('GRANT EXECUTE ON FUNCTION stored_files_mark_unreferenced() TO %s', grantee);
    EXECUTE format('GRANT EXECUTE ON FUNCTION stored_files_sweep(integer) TO %s', grantee);
  END LOOP;
END;
$$;
