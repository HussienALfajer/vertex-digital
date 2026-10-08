-- USDT deposits (S04, ADR 0003, 0014, 0018): what drizzle-kit cannot express. Hand-written; never
-- edit once applied.

-- Decided deposits before S04 were all decided by the admin. Deposits in a final state refuse
-- every change (migration 0012), so the guard is set aside for this one backfill, inside the
-- migration's transaction.
ALTER TABLE deposits DISABLE TRIGGER deposits_guard;
--> statement-breakpoint
UPDATE deposits SET decided_by = 'admin'
WHERE status IN ('credited', 'rejected') AND decided_by IS NULL;
--> statement-breakpoint
ALTER TABLE deposits ENABLE TRIGGER deposits_guard;
--> statement-breakpoint

-- Migration 0012's guard, plus:
-- - a decision without `decided_by` is the admin's: the S03 release, still running while this
--   one deploys, does not know the column (expand, then contract);
-- - `submitted → pending` is a Sham Cash receipt request (the count goes up, rule RV8) or a USDT
--   bounce (the USDT row carries the TXID's failure, rule U10), nothing else;
-- - a USDT deposit's declared amount never changes: its tail was chosen for it (rule U3).
CREATE OR REPLACE FUNCTION deposits_guard() RETURNS trigger LANGUAGE plpgsql
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
  IF OLD.status = 'submitted' AND NEW.status = 'pending' THEN
    IF OLD.method = 'sham_cash' THEN
      IF NEW.receipt_request_count <= OLD.receipt_request_count THEN
        RAISE EXCEPTION 'deposit % returns to pending only by a receipt request', OLD.id
          USING ERRCODE = 'restrict_violation';
      END IF;
    ELSIF NOT EXISTS (
      SELECT 1 FROM public.usdt_deposits AS u
      WHERE u.deposit_id = OLD.id AND u.check_error IS NOT NULL
    ) THEN
      RAISE EXCEPTION 'deposit % returns to pending only with its TXID failure', OLD.id
        USING ERRCODE = 'restrict_violation';
    END IF;
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
    AND NOT (OLD.method = 'sham_cash' AND OLD.status = 'pending' AND OLD.rate_fixed_at IS NULL) THEN
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
  IF NEW.status IN ('credited', 'rejected') AND NEW.decided_by IS NULL
    AND NEW.admin_id IS NOT NULL THEN
    NEW.decided_by := 'admin';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint

-- `usdt_deposits.deposit_open` follows its deposit: true while `pending` or `submitted`. The
-- partial unique index on the open amounts relies on it (rule U3).
CREATE FUNCTION deposits_sync_usdt_open() RETURNS trigger LANGUAGE plpgsql
SET search_path = public, pg_temp AS $$
BEGIN
  UPDATE public.usdt_deposits
  SET deposit_open = NEW.status IN ('pending', 'submitted')
  WHERE deposit_id = NEW.id AND deposit_open <> (NEW.status IN ('pending', 'submitted'));
  RETURN NULL;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER deposits_sync_usdt_open AFTER UPDATE OF status ON deposits
  FOR EACH ROW WHEN (NEW.status IS DISTINCT FROM OLD.status)
  EXECUTE FUNCTION deposits_sync_usdt_open();
--> statement-breakpoint

-- A USDT deposit's row is never deleted. It takes its deposit's method and its amount is the
-- declared amount plus the tail; what was shown to the customer (address, tail, amount) never
-- changes, nor the transfer once bound; `deposit_open` always mirrors the deposit.
CREATE FUNCTION usdt_deposits_guard() RETURNS trigger LANGUAGE plpgsql
SET search_path = public, pg_temp AS $$
DECLARE
  deposit record;
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'USDT deposits are never deleted' USING ERRCODE = 'restrict_violation';
  END IF;
  SELECT d.method, d.status, d.declared_usd_units INTO deposit
  FROM public.deposits AS d WHERE d.id = NEW.deposit_id;
  IF TG_OP = 'INSERT' THEN
    IF deposit.method::text <> NEW.method::text
      OR NEW.pay_amount_units <> deposit.declared_usd_units + NEW.tail_units THEN
      RAISE EXCEPTION 'USDT deposit % must match its deposit''s method and amount', NEW.deposit_id
        USING ERRCODE = 'check_violation';
    END IF;
  ELSE
    IF (NEW.deposit_id, NEW.method, NEW.receiving_address, NEW.tail_units, NEW.pay_amount_units,
        NEW.created_at)
      IS DISTINCT FROM (OLD.deposit_id, OLD.method, OLD.receiving_address, OLD.tail_units,
        OLD.pay_amount_units, OLD.created_at) THEN
      RAISE EXCEPTION 'USDT deposit % cannot change what was shown', OLD.deposit_id
        USING ERRCODE = 'restrict_violation';
    END IF;
    IF OLD.transfer_id IS NOT NULL AND NEW.transfer_id IS DISTINCT FROM OLD.transfer_id THEN
      RAISE EXCEPTION 'USDT deposit % is bound to its transfer', OLD.deposit_id
        USING ERRCODE = 'restrict_violation';
    END IF;
  END IF;
  IF NEW.deposit_open <> (deposit.status IN ('pending', 'submitted')) THEN
    RAISE EXCEPTION 'USDT deposit % must mirror whether its deposit is open', NEW.deposit_id
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER usdt_deposits_guard BEFORE INSERT OR UPDATE OR DELETE ON usdt_deposits
  FOR EACH ROW EXECUTE FUNCTION usdt_deposits_guard();
--> statement-breakpoint
CREATE TRIGGER usdt_deposits_no_truncate BEFORE TRUNCATE ON usdt_deposits
  FOR EACH STATEMENT EXECUTE FUNCTION append_only_guard();
--> statement-breakpoint

-- Transfers are append-only, whoever runs the change: the trigger of migration 0001.
CREATE TRIGGER usdt_transfers_append_only BEFORE UPDATE OR DELETE ON usdt_transfers
  FOR EACH ROW EXECUTE FUNCTION append_only_guard();
--> statement-breakpoint
CREATE TRIGGER usdt_transfers_no_truncate BEFORE TRUNCATE ON usdt_transfers
  FOR EACH STATEMENT EXECUTE FUNCTION append_only_guard();
--> statement-breakpoint

-- The app role keeps SELECT and INSERT on transfers, and loses DELETE and TRUNCATE on USDT
-- deposits: revoked from PUBLIC and from every role but the owner, as in migration 0012.
REVOKE UPDATE, DELETE, TRUNCATE ON usdt_transfers FROM PUBLIC;
--> statement-breakpoint
REVOKE DELETE, TRUNCATE ON usdt_deposits FROM PUBLIC;
--> statement-breakpoint
DO $$
DECLARE
  target text;
  revoked text;
  grantee text;
BEGIN
  FOREACH target IN ARRAY ARRAY['usdt_transfers', 'usdt_deposits'] LOOP
    revoked := CASE WHEN target = 'usdt_deposits' THEN 'DELETE, TRUNCATE'
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
