-- Wallet guards (S02, ADR 0003, 0014): what drizzle-kit cannot express. Hand-written; never edit
-- once applied.

-- A wallet's customer never changes either (migration 0001 kept id, code, kind and currency).
CREATE OR REPLACE FUNCTION ledger_accounts_keep_identity() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.id <> OLD.id OR NEW.code <> OLD.code OR NEW.kind <> OLD.kind
    OR NEW.currency <> OLD.currency OR NEW.customer_id IS DISTINCT FROM OLD.customer_id THEN
    RAISE EXCEPTION 'The id, code, kind, currency and customer of ledger account % never change', OLD.id;
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint

-- Adjustments are append-only, whoever runs the change: the trigger of migration 0001.
CREATE TRIGGER wallet_adjustments_append_only BEFORE UPDATE OR DELETE ON wallet_adjustments
  FOR EACH ROW EXECUTE FUNCTION append_only_guard();
--> statement-breakpoint
CREATE TRIGGER wallet_adjustments_no_truncate BEFORE TRUNCATE ON wallet_adjustments
  FOR EACH STATEMENT EXECUTE FUNCTION append_only_guard();
--> statement-breakpoint

-- The app role keeps SELECT and INSERT only, as on the ledger and the audit log: revoked from
-- PUBLIC and from every role but the owner, whatever the app role is called.
REVOKE UPDATE, DELETE, TRUNCATE ON wallet_adjustments FROM PUBLIC;
--> statement-breakpoint
DO $$
DECLARE
  grantee text;
BEGIN
  FOR grantee IN
    SELECT DISTINCT acl.grantee::regrole::text
    FROM pg_class AS c, aclexplode(c.relacl) AS acl
    WHERE c.oid = 'wallet_adjustments'::regclass
      AND acl.grantee <> c.relowner
      AND acl.grantee <> 0
  LOOP
    EXECUTE format('REVOKE UPDATE, DELETE, TRUNCATE ON wallet_adjustments FROM %s', grantee);
  END LOOP;
END;
$$;
--> statement-breakpoint

-- A reversal mirrors its original (rules R1, R3): same customer, amount and category, the
-- opposite direction, and the original is not itself a reversal. The unique
-- reverses_adjustment_id keeps it to one reversal per original (rule R2).
CREATE FUNCTION wallet_adjustments_check_reversal() RETURNS trigger LANGUAGE plpgsql
SET search_path = public, pg_temp AS $$
DECLARE
  original public.wallet_adjustments%ROWTYPE;
BEGIN
  IF NEW.reverses_adjustment_id IS NULL THEN
    RETURN NEW;
  END IF;
  SELECT * INTO original FROM public.wallet_adjustments WHERE id = NEW.reverses_adjustment_id;
  IF original.reverses_adjustment_id IS NOT NULL THEN
    RAISE EXCEPTION 'Adjustment % is a reversal and cannot be reversed', original.id
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.direction = original.direction OR NEW.amount_usd_units <> original.amount_usd_units
    OR NEW.category <> original.category OR NEW.customer_id <> original.customer_id THEN
    RAISE EXCEPTION 'A reversal of adjustment % must mirror it', original.id
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER wallet_adjustments_check_reversal BEFORE INSERT ON wallet_adjustments
  FOR EACH ROW EXECUTE FUNCTION wallet_adjustments_check_reversal();
