-- Reservations, player checks and live order events (S09; ADR 0004, 0014): what drizzle-kit
-- cannot express. Hand-written; never edit once applied.

-- `orders_guard` (migration 0031) changes in one way only: on `awaiting_balance → paid` (rules
-- RS4, RS6) the price columns may change, and the purchase journal and `paid_at` are set. The
-- reservation and player-check columns are fixed like the identity; `cancel_reason` comes with
-- `cancelled` (a check), which is terminal.
CREATE OR REPLACE FUNCTION orders_guard() RETURNS trigger LANGUAGE plpgsql
SET search_path = public, pg_temp AS $$
DECLARE
  paying boolean;
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'orders are never deleted' USING ERRCODE = 'restrict_violation';
  END IF;
  IF OLD.status IN ('delivered', 'partially_refunded', 'refunded', 'cancelled') THEN
    RAISE EXCEPTION 'order % is % and never changes', OLD.id, OLD.status
      USING ERRCODE = 'restrict_violation';
  END IF;
  IF NEW.id IS DISTINCT FROM OLD.id
    OR NEW.number IS DISTINCT FROM OLD.number
    OR NEW.customer_id IS DISTINCT FROM OLD.customer_id
    OR NEW.is_test IS DISTINCT FROM OLD.is_test
    OR NEW.product_id IS DISTINCT FROM OLD.product_id
    OR NEW.game_id IS DISTINCT FROM OLD.game_id
    OR NEW.kind IS DISTINCT FROM OLD.kind
    OR NEW.quantity IS DISTINCT FROM OLD.quantity
    OR NEW.fields IS DISTINCT FROM OLD.fields
    OR NEW.idempotency_key IS DISTINCT FROM OLD.idempotency_key
    OR NEW.request_hash IS DISTINCT FROM OLD.request_hash
    OR NEW.reserved_at IS DISTINCT FROM OLD.reserved_at
    OR NEW.expires_at IS DISTINCT FROM OLD.expires_at
    OR NEW.player_check IS DISTINCT FROM OLD.player_check
    OR NEW.player_name IS DISTINCT FROM OLD.player_name
    OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'order %: its identity and fields are fixed', OLD.id
      USING ERRCODE = 'restrict_violation';
  END IF;
  paying := OLD.status = 'awaiting_balance' AND NEW.status = 'paid';
  IF NOT paying AND (
    NEW.unit_price_usd_units IS DISTINCT FROM OLD.unit_price_usd_units
    OR NEW.total_usd_units IS DISTINCT FROM OLD.total_usd_units
    OR NEW.price_id IS DISTINCT FROM OLD.price_id
    OR NEW.min_margin_usd_units IS DISTINCT FROM OLD.min_margin_usd_units
    OR NEW.display_rate_id IS DISTINCT FROM OLD.display_rate_id
    OR NEW.total_syp_units IS DISTINCT FROM OLD.total_syp_units
    OR NEW.purchase_journal_id IS DISTINCT FROM OLD.purchase_journal_id
    OR NEW.paid_at IS DISTINCT FROM OLD.paid_at) THEN
    RAISE EXCEPTION 'order %: its price is fixed once paid', OLD.id
      USING ERRCODE = 'restrict_violation';
  END IF;
  IF NEW.status <> OLD.status AND (OLD.status, NEW.status) NOT IN (
    ('awaiting_balance', 'paid'), ('awaiting_balance', 'cancelled'),
    ('paid', 'sent_to_supplier'), ('paid', 'refunded'),
    ('sent_to_supplier', 'delivered'), ('sent_to_supplier', 'failed'),
    ('sent_to_supplier', 'needs_review'),
    ('failed', 'sent_to_supplier'), ('failed', 'refunded'), ('failed', 'partially_refunded'),
    ('needs_review', 'delivered'), ('needs_review', 'sent_to_supplier'),
    ('needs_review', 'refunded'), ('needs_review', 'partially_refunded')
  ) THEN
    RAISE EXCEPTION 'order %: % → % is not an allowed transition', OLD.id, OLD.status, NEW.status
      USING ERRCODE = 'restrict_violation';
  END IF;
  IF NEW.delivered_quantity < OLD.delivered_quantity
    OR NEW.refunded_quantity < OLD.refunded_quantity
    OR (OLD.refund_journal_id IS NOT NULL
      AND NEW.refund_journal_id IS DISTINCT FROM OLD.refund_journal_id)
    OR (OLD.refund_idempotency_key IS NOT NULL
      AND NEW.refund_idempotency_key IS DISTINCT FROM OLD.refund_idempotency_key) THEN
    RAISE EXCEPTION 'order %: delivered and refunded units never go back', OLD.id
      USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint

-- Rule LT2: every new order and every status change tells the API's stream, at commit, whose
-- order changed and to what: `<customer id>:<order id>:<status>`, never fields or amounts.
CREATE FUNCTION orders_notify() RETURNS trigger LANGUAGE plpgsql
SET search_path = public, pg_temp AS $$
BEGIN
  IF TG_OP = 'INSERT' OR NEW.status IS DISTINCT FROM OLD.status THEN
    PERFORM pg_notify('customer_orders', NEW.customer_id || ':' || NEW.id || ':' || NEW.status);
  END IF;
  RETURN NULL;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER orders_notify AFTER INSERT OR UPDATE OF status ON orders
  FOR EACH ROW EXECUTE FUNCTION orders_notify();
--> statement-breakpoint

-- `player_checks` is a cache (rule PV3): the app role reads, inserts and deletes (the sweep), but
-- never changes a supplier's answer. Revoked from PUBLIC and from every role but the owner.
REVOKE UPDATE, TRUNCATE ON player_checks FROM PUBLIC;
--> statement-breakpoint
DO $$
DECLARE
  grantee text;
BEGIN
  FOR grantee IN
    SELECT DISTINCT acl.grantee::regrole::text
    FROM pg_class AS c, aclexplode(c.relacl) AS acl
    WHERE c.oid = 'player_checks'::regclass
      AND acl.grantee <> c.relowner
      AND acl.grantee <> 0
  LOOP
    EXECUTE format('REVOKE UPDATE, TRUNCATE ON player_checks FROM %s', grantee);
  END LOOP;
END;
$$;
