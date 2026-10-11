-- Treasury movements and the reconciliation (S13, F20, ADR 0027): what drizzle-kit cannot express.
-- Hand-written; never edit once applied.

-- Append-only (S13 "Data"): movements, results, explanations and settings versions are new rows;
-- the trigger of migration 0001 refuses UPDATE, DELETE and TRUNCATE whoever runs them.
CREATE TRIGGER treasury_movements_append_only BEFORE UPDATE OR DELETE ON treasury_movements
  FOR EACH ROW EXECUTE FUNCTION append_only_guard();
--> statement-breakpoint
CREATE TRIGGER treasury_movements_no_truncate BEFORE TRUNCATE ON treasury_movements
  FOR EACH STATEMENT EXECUTE FUNCTION append_only_guard();
--> statement-breakpoint
CREATE TRIGGER reconciliation_results_append_only BEFORE UPDATE OR DELETE ON reconciliation_results
  FOR EACH ROW EXECUTE FUNCTION append_only_guard();
--> statement-breakpoint
CREATE TRIGGER reconciliation_results_no_truncate BEFORE TRUNCATE ON reconciliation_results
  FOR EACH STATEMENT EXECUTE FUNCTION append_only_guard();
--> statement-breakpoint
CREATE TRIGGER reconciliation_explanations_append_only BEFORE UPDATE OR DELETE ON reconciliation_explanations
  FOR EACH ROW EXECUTE FUNCTION append_only_guard();
--> statement-breakpoint
CREATE TRIGGER reconciliation_explanations_no_truncate BEFORE TRUNCATE ON reconciliation_explanations
  FOR EACH STATEMENT EXECUTE FUNCTION append_only_guard();
--> statement-breakpoint
CREATE TRIGGER reconciliation_settings_append_only BEFORE UPDATE OR DELETE ON reconciliation_settings
  FOR EACH ROW EXECUTE FUNCTION append_only_guard();
--> statement-breakpoint
CREATE TRIGGER reconciliation_settings_no_truncate BEFORE TRUNCATE ON reconciliation_settings
  FOR EACH STATEMENT EXECUTE FUNCTION append_only_guard();
--> statement-breakpoint

-- The app role keeps SELECT and INSERT only on the append-only tables, and loses DELETE and
-- TRUNCATE on runs: revoked from PUBLIC and from every role but the owner, whatever the app role
-- is called.
REVOKE UPDATE, DELETE, TRUNCATE ON treasury_movements, reconciliation_results, reconciliation_explanations, reconciliation_settings FROM PUBLIC;
--> statement-breakpoint
REVOKE DELETE, TRUNCATE ON reconciliation_runs FROM PUBLIC;
--> statement-breakpoint
DO $$
DECLARE
  target regclass;
  grantee text;
BEGIN
  FOREACH target IN ARRAY ARRAY['treasury_movements'::regclass, 'reconciliation_results'::regclass, 'reconciliation_explanations'::regclass, 'reconciliation_settings'::regclass]
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
  FOR grantee IN
    SELECT DISTINCT acl.grantee::regrole::text
    FROM pg_class AS c, aclexplode(c.relacl) AS acl
    WHERE c.oid = 'reconciliation_runs'::regclass
      AND acl.grantee <> c.relowner
      AND acl.grantee <> 0
  LOOP
    EXECUTE format('REVOKE DELETE, TRUNCATE ON reconciliation_runs FROM %s', grantee);
  END LOOP;
END;
$$;
--> statement-breakpoint

-- A movement's accounts fit its kind (rules T1–T6, T9): every side is a place or the corrections
-- account; a transfer never touches the corrections account and a correction is a supplier against
-- it; `outside_category` is set exactly when one side is outside; an opening balance comes from
-- outside; a reversal repeats its original's kind, accounts and amounts, and is never reversed.
CREATE FUNCTION treasury_movements_guard() RETURNS trigger LANGUAGE plpgsql
SET search_path = public, pg_temp AS $$
DECLARE
  from_kind ledger_account_kind;
  to_kind ledger_account_kind;
  original public.treasury_movements%ROWTYPE;
BEGIN
  SELECT kind INTO from_kind FROM public.ledger_accounts WHERE id = NEW.from_account_id;
  SELECT kind INTO to_kind FROM public.ledger_accounts WHERE id = NEW.to_account_id;
  IF from_kind::text NOT IN ('sham_cash_receipts', 'usdt_receipts', 'supplier_prepaid', 'outside_funds', 'supplier_corrections')
    OR to_kind::text NOT IN ('sham_cash_receipts', 'usdt_receipts', 'supplier_prepaid', 'outside_funds', 'supplier_corrections') THEN
    RAISE EXCEPTION 'treasury_movements: both sides must be places or the corrections account';
  END IF;
  IF NEW.kind = 'transfer' AND 'supplier_corrections' IN (from_kind::text, to_kind::text) THEN
    RAISE EXCEPTION 'treasury_movements: a transfer never touches the corrections account';
  END IF;
  IF NEW.kind = 'supplier_correction' AND NOT (
    (from_kind::text = 'supplier_corrections' AND to_kind::text = 'supplier_prepaid')
    OR (from_kind::text = 'supplier_prepaid' AND to_kind::text = 'supplier_corrections')) THEN
    RAISE EXCEPTION 'treasury_movements: a correction is a supplier against the corrections account';
  END IF;
  IF (NEW.outside_category IS NOT NULL) <> ('outside_funds' IN (from_kind::text, to_kind::text)) THEN
    RAISE EXCEPTION 'treasury_movements: a category is set exactly when one side is outside';
  END IF;
  IF from_kind::text = 'outside_funds' AND to_kind::text = 'outside_funds' THEN
    RAISE EXCEPTION 'treasury_movements: outside to outside is not a movement';
  END IF;
  IF NEW.opening_balance AND from_kind::text <> 'outside_funds' THEN
    RAISE EXCEPTION 'treasury_movements: an opening balance comes from outside';
  END IF;
  IF NEW.reverses_movement_id IS NOT NULL THEN
    SELECT * INTO original FROM public.treasury_movements WHERE id = NEW.reverses_movement_id;
    IF original.reverses_movement_id IS NOT NULL THEN
      RAISE EXCEPTION 'treasury_movements: a reversal is never reversed';
    END IF;
    IF NEW.kind <> original.kind OR NEW.from_account_id <> original.from_account_id
      OR NEW.to_account_id <> original.to_account_id OR NEW.sent_units <> original.sent_units
      OR NEW.received_units <> original.received_units
      OR NEW.outside_category IS DISTINCT FROM original.outside_category
      OR NEW.rate IS DISTINCT FROM original.rate OR NEW.opening_balance
      OR NEW.order_id IS DISTINCT FROM original.order_id THEN
      RAISE EXCEPTION 'treasury_movements: a reversal repeats its original';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER treasury_movements_guard BEFORE INSERT ON treasury_movements
  FOR EACH ROW EXECUTE FUNCTION treasury_movements_guard();
--> statement-breakpoint

-- A run changes only while it runs, to its end (rules RN4, RN5); after that only its alert time,
-- once (rule NT1). Its trigger, day, start, admin and key are fixed; no run is ever deleted.
CREATE FUNCTION reconciliation_runs_guard() RETURNS trigger LANGUAGE plpgsql
SET search_path = public, pg_temp AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'reconciliation_runs rows are never deleted';
  END IF;
  IF NEW.id <> OLD.id OR NEW.trigger <> OLD.trigger
    OR NEW.business_date IS DISTINCT FROM OLD.business_date
    OR NEW.started_at <> OLD.started_at OR NEW.admin_id IS DISTINCT FROM OLD.admin_id
    OR NEW.idempotency_key IS DISTINCT FROM OLD.idempotency_key THEN
    RAISE EXCEPTION 'reconciliation_runs: the trigger, day, start, admin and key are fixed';
  END IF;
  IF OLD.status <> 'running' AND (
    NEW.status <> OLD.status OR NEW.finished_at IS DISTINCT FROM OLD.finished_at
    OR NEW.snapshot_position IS DISTINCT FROM OLD.snapshot_position
    OR NEW.mismatch_count <> OLD.mismatch_count OR NEW.warning_count <> OLD.warning_count
    OR NEW.recheck_at IS DISTINCT FROM OLD.recheck_at
    OR NEW.failure IS DISTINCT FROM OLD.failure
    OR (OLD.alerted_at IS NOT NULL AND NEW.alerted_at IS DISTINCT FROM OLD.alerted_at)) THEN
    RAISE EXCEPTION 'reconciliation_runs: an ended run changes only its alert time, once';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER reconciliation_runs_guard BEFORE UPDATE OR DELETE ON reconciliation_runs
  FOR EACH ROW EXECUTE FUNCTION reconciliation_runs_guard();
--> statement-breakpoint

-- The settings' seed (rules E1, E5): $1 and 7 days, a fixed id so every database holds it.
INSERT INTO reconciliation_settings (id, tolerance_usd_units, count_stale_days, admin_id)
VALUES ('01a1288b-5011-756d-8919-b0f1f3babc2d', 1000000, 7, NULL)
ON CONFLICT DO NOTHING;
