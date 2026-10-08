-- Deposits (S03, ADR 0003, 0014, 0017): what drizzle-kit cannot express. Hand-written; never edit
-- once applied.

-- Settings versions, receipts, flags and stored files are append-only, whoever runs the change:
-- the trigger of migration 0001.
CREATE TRIGGER deposit_settings_append_only BEFORE UPDATE OR DELETE ON deposit_settings
  FOR EACH ROW EXECUTE FUNCTION append_only_guard();
--> statement-breakpoint
CREATE TRIGGER deposit_settings_no_truncate BEFORE TRUNCATE ON deposit_settings
  FOR EACH STATEMENT EXECUTE FUNCTION append_only_guard();
--> statement-breakpoint
CREATE TRIGGER deposit_receipts_append_only BEFORE UPDATE OR DELETE ON deposit_receipts
  FOR EACH ROW EXECUTE FUNCTION append_only_guard();
--> statement-breakpoint
CREATE TRIGGER deposit_receipts_no_truncate BEFORE TRUNCATE ON deposit_receipts
  FOR EACH STATEMENT EXECUTE FUNCTION append_only_guard();
--> statement-breakpoint
CREATE TRIGGER deposit_flags_append_only BEFORE UPDATE OR DELETE ON deposit_flags
  FOR EACH ROW EXECUTE FUNCTION append_only_guard();
--> statement-breakpoint
CREATE TRIGGER deposit_flags_no_truncate BEFORE TRUNCATE ON deposit_flags
  FOR EACH STATEMENT EXECUTE FUNCTION append_only_guard();
--> statement-breakpoint
CREATE TRIGGER stored_files_append_only BEFORE UPDATE OR DELETE ON stored_files
  FOR EACH ROW EXECUTE FUNCTION append_only_guard();
--> statement-breakpoint
CREATE TRIGGER stored_files_no_truncate BEFORE TRUNCATE ON stored_files
  FOR EACH STATEMENT EXECUTE FUNCTION append_only_guard();
--> statement-breakpoint

-- A deposit is never deleted, never leaves a final state, moves only along the transition table
-- (`DEPOSIT_TRANSITIONS` in the contracts), and never changes what the customer declared. Its
-- quote changes only by a requote: while `pending` and before the rate was fixed (rule SC10).
-- Decision fields can only be written by the move into a final state, which nothing follows.
CREATE FUNCTION deposits_guard() RETURNS trigger LANGUAGE plpgsql
SET search_path = public, pg_temp AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'deposits are never deleted' USING ERRCODE = 'restrict_violation';
  END IF;
  IF OLD.status IN ('credited', 'rejected', 'expired', 'cancelled') THEN
    RAISE EXCEPTION 'deposit % is final (%)', OLD.id, OLD.status USING ERRCODE = 'restrict_violation';
  END IF;
  IF NEW.status <> OLD.status AND NOT (
    (OLD.status = 'pending' AND NEW.status IN ('submitted', 'cancelled', 'expired'))
    OR (OLD.status = 'submitted' AND NEW.status IN ('credited', 'rejected', 'pending'))
  ) THEN
    RAISE EXCEPTION 'deposit % cannot move from % to %', OLD.id, OLD.status, NEW.status
      USING ERRCODE = 'restrict_violation';
  END IF;
  IF (NEW.id, NEW.customer_id, NEW.method, NEW.reference_code, NEW.currency,
      NEW.declared_amount_units, NEW.idempotency_key, NEW.created_at)
    IS DISTINCT FROM (OLD.id, OLD.customer_id, OLD.method, OLD.reference_code, OLD.currency,
      OLD.declared_amount_units, OLD.idempotency_key, OLD.created_at) THEN
    RAISE EXCEPTION 'deposit % cannot change what was declared', OLD.id
      USING ERRCODE = 'restrict_violation';
  END IF;
  IF (NEW.rate_id, NEW.rate, NEW.quote_expires_at, NEW.declared_usd_units)
      IS DISTINCT FROM (OLD.rate_id, OLD.rate, OLD.quote_expires_at, OLD.declared_usd_units)
    AND NOT (OLD.status = 'pending' AND OLD.rate_fixed_at IS NULL) THEN
    RAISE EXCEPTION 'deposit % cannot change its quote', OLD.id USING ERRCODE = 'restrict_violation';
  END IF;
  IF OLD.rate_fixed_at IS NOT NULL AND NEW.rate_fixed_at IS DISTINCT FROM OLD.rate_fixed_at THEN
    RAISE EXCEPTION 'deposit % has a fixed rate', OLD.id USING ERRCODE = 'restrict_violation';
  END IF;
  IF NEW.receipt_request_count < OLD.receipt_request_count
    OR (OLD.receipt_requested_at IS NOT NULL
      AND NEW.receipt_requested_at IS DISTINCT FROM OLD.receipt_requested_at) THEN
    RAISE EXCEPTION 'deposit % cannot undo a receipt request', OLD.id
      USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER deposits_guard BEFORE UPDATE OR DELETE ON deposits
  FOR EACH ROW EXECUTE FUNCTION deposits_guard();
--> statement-breakpoint
CREATE TRIGGER deposits_no_truncate BEFORE TRUNCATE ON deposits
  FOR EACH STATEMENT EXECUTE FUNCTION append_only_guard();
--> statement-breakpoint

-- The app role keeps SELECT and INSERT on the append-only tables, and loses DELETE and TRUNCATE
-- on deposits: revoked from PUBLIC and from every role but the owner, whatever the app role is
-- called.
REVOKE UPDATE, DELETE, TRUNCATE ON deposit_settings, deposit_receipts, deposit_flags, stored_files
  FROM PUBLIC;
--> statement-breakpoint
REVOKE DELETE, TRUNCATE ON deposits FROM PUBLIC;
--> statement-breakpoint
DO $$
DECLARE
  target text;
  revoked text;
  grantee text;
BEGIN
  FOREACH target IN ARRAY ARRAY['deposit_settings', 'deposit_receipts', 'deposit_flags',
    'stored_files', 'deposits'] LOOP
    revoked := CASE WHEN target = 'deposits' THEN 'DELETE, TRUNCATE'
      ELSE 'UPDATE, DELETE, TRUNCATE' END;
    FOR grantee IN
      SELECT DISTINCT acl.grantee::regrole::text
      FROM pg_class AS c, aclexplode(c.relacl) AS acl
      WHERE c.oid = target::regclass
        AND acl.grantee <> c.relowner
        AND acl.grantee <> 0
    LOOP
      EXECUTE format('REVOKE %s ON %I FROM %s', revoked, target, grantee);
    END LOOP;
  END LOOP;
END;
$$;
--> statement-breakpoint

-- Migration 0010's backfill again, before deposits can claim references (rule SC14): a manual
-- deposit written by the release before it, while 0010 was being deployed, gets its claim too.
-- Idempotent: claimed adjustments and taken references are skipped.
INSERT INTO payment_references (id, method, reference, wallet_adjustment_id, created_at)
SELECT a.id, a.deposit_method::text::payment_method, upper(btrim(a.external_reference)), a.id,
  a.created_at
FROM wallet_adjustments AS a
WHERE a.external_reference IS NOT NULL
  AND NOT EXISTS (SELECT 1 FROM payment_references AS p WHERE p.wallet_adjustment_id = a.id)
ORDER BY a.created_at, a.id
ON CONFLICT (method, reference) DO NOTHING;
