-- Audit A10: database guards for rules that held only in code. Hand-written; never edit once
-- applied.

-- A10-41 (A02-29): a USDT deposit is credited only bound to a transfer whose TXID is the
-- deposit's transaction number (S04 rule U12; `creditUsdtDeposit` binds before it credits). The
-- rest of `deposits_guard` is migration 0014's, unchanged.
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
  IF NEW.status = 'credited' AND OLD.method <> 'sham_cash' AND NOT EXISTS (
    SELECT 1 FROM public.usdt_deposits AS u
    JOIN public.usdt_transfers AS t ON t.id = u.transfer_id
    WHERE u.deposit_id = OLD.id AND t.txid = NEW.transaction_number
  ) THEN
    RAISE EXCEPTION 'deposit % is credited only bound to the transfer of its TXID', OLD.id
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

-- A10-44 (A03-36): a game's or a category's slug is its address in the store and in printed
-- links: it never changes, archived rows included (S06 rule CT1).
CREATE FUNCTION catalog_slug_guard() RETURNS trigger LANGUAGE plpgsql
SET search_path = public, pg_temp AS $$
BEGIN
  IF NEW.slug IS DISTINCT FROM OLD.slug THEN
    RAISE EXCEPTION '% %: the slug never changes', TG_TABLE_NAME, OLD.id
      USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER catalog_games_slug_guard BEFORE UPDATE OF slug ON catalog_games
  FOR EACH ROW EXECUTE FUNCTION catalog_slug_guard();
--> statement-breakpoint
CREATE TRIGGER catalog_categories_slug_guard BEFORE UPDATE OF slug ON catalog_categories
  FOR EACH ROW EXECUTE FUNCTION catalog_slug_guard();
--> statement-breakpoint

-- A10-44 (A05-66): a margin rule is changed in place and archived, never deleted, and keeps what
-- it applies to (S06 PR rules, S20 RP1): its prices name it.
CREATE FUNCTION margin_rules_guard() RETURNS trigger LANGUAGE plpgsql
SET search_path = public, pg_temp AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'margin rules are archived, never deleted' USING ERRCODE = 'restrict_violation';
  END IF;
  IF (NEW.id, NEW.price_list_id, NEW.scope, NEW.target_id, NEW.created_at)
    IS DISTINCT FROM (OLD.id, OLD.price_list_id, OLD.scope, OLD.target_id, OLD.created_at) THEN
    RAISE EXCEPTION 'margin rule % keeps what it applies to', OLD.id
      USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER margin_rules_guard BEFORE UPDATE OR DELETE ON margin_rules
  FOR EACH ROW EXECUTE FUNCTION margin_rules_guard();
--> statement-breakpoint

-- A10-44: the catalog, its routes and the margin rules are archived, never deleted, by the app
-- role (ADR 0011 "archive, don't delete"; ADR 0014). The owner keeps DELETE for a restore.
REVOKE DELETE, TRUNCATE ON catalog_categories, catalog_games, catalog_input_fields,
  catalog_products, product_routes, margin_rules FROM PUBLIC;
--> statement-breakpoint
DO $$
DECLARE
  target regclass;
  grantee text;
BEGIN
  FOREACH target IN ARRAY ARRAY['catalog_categories'::regclass, 'catalog_games'::regclass,
    'catalog_input_fields'::regclass, 'catalog_products'::regclass, 'product_routes'::regclass,
    'margin_rules'::regclass]
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
