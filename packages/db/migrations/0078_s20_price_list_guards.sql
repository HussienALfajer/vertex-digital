-- S20 (ADR 0035): the seeded lists' global rules, the list guards and `orders_guard` again.
-- Hand-written; never edit once applied.

-- Decision 2 (owner, 2026-10-20): wholesale 5%, $0 fixed, $0.05 minimum; cost 1%, $0 fixed,
-- $0.01 minimum. Fixed ids, so every database holds the same rows. Rules before S20 are retail's
-- (the column's default filled them).
INSERT INTO margin_rules (id, price_list_id, scope, target_id, percent_bp, fixed_usd_units, min_margin_usd_units)
VALUES
  ('01a15a8c-b312-75f3-92d2-6da2e25d2df8', '01a15a8c-b312-75f3-92d2-65b29d838051', 'global', NULL, 500, 0, 50000),
  ('01a15a8c-b312-75f3-92d2-72570354506e', '01a15a8c-b312-75f3-92d2-691f7e3bf413', 'global', NULL, 100, 0, 10000)
ON CONFLICT DO NOTHING;
--> statement-breakpoint
-- LS1: root lists are never archived.
ALTER TABLE price_lists ADD CONSTRAINT price_lists_root_live_check
  CHECK (kind = 'custom' OR archived_at IS NULL);
--> statement-breakpoint
-- LS1, LS3: a list's kind and parent are fixed at creation (so no cycle can form); an archived
-- list never comes back; lists are archived, never deleted.
CREATE OR REPLACE FUNCTION price_lists_guard() RETURNS trigger LANGUAGE plpgsql
SET search_path = public, pg_temp AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'price lists are archived, never deleted' USING ERRCODE = 'restrict_violation';
  END IF;
  IF NEW.id IS DISTINCT FROM OLD.id
    OR NEW.kind IS DISTINCT FROM OLD.kind
    OR NEW.parent_list_id IS DISTINCT FROM OLD.parent_list_id
    OR NEW.created_at IS DISTINCT FROM OLD.created_at
    OR (OLD.archived_at IS NOT NULL AND NEW.archived_at IS DISTINCT FROM OLD.archived_at) THEN
    RAISE EXCEPTION 'price list %: its kind and parent are fixed, and an archived list stays archived', OLD.id
      USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER price_lists_guard BEFORE UPDATE OR DELETE ON price_lists
  FOR EACH ROW EXECUTE FUNCTION price_lists_guard();
--> statement-breakpoint
-- LS2: a fixed price never changes: a new value archives the row and inserts another, so the price
-- rows that used it keep naming the value. Only `archived_at`, once.
CREATE OR REPLACE FUNCTION price_list_fixed_prices_guard() RETURNS trigger LANGUAGE plpgsql
SET search_path = public, pg_temp AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'fixed prices are archived, never deleted' USING ERRCODE = 'restrict_violation';
  END IF;
  IF NEW.id IS DISTINCT FROM OLD.id
    OR NEW.price_list_id IS DISTINCT FROM OLD.price_list_id
    OR NEW.product_id IS DISTINCT FROM OLD.product_id
    OR NEW.price_usd_units IS DISTINCT FROM OLD.price_usd_units
    OR NEW.created_at IS DISTINCT FROM OLD.created_at
    OR OLD.archived_at IS NOT NULL THEN
    RAISE EXCEPTION 'fixed price %: only archived, once', OLD.id
      USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER price_list_fixed_prices_guard BEFORE UPDATE OR DELETE ON price_list_fixed_prices
  FOR EACH ROW EXECUTE FUNCTION price_list_fixed_prices_guard();
--> statement-breakpoint
-- The app role loses DELETE and TRUNCATE on both, revoked from PUBLIC and from every role but the
-- owner, whatever the app role is called.
REVOKE DELETE, TRUNCATE ON price_lists FROM PUBLIC;
--> statement-breakpoint
DO $$
DECLARE
  grantee text;
BEGIN
  FOR grantee IN
    SELECT DISTINCT acl.grantee::regrole::text
    FROM pg_class AS c, aclexplode(c.relacl) AS acl
    WHERE c.oid = 'price_lists'::regclass
      AND acl.grantee <> c.relowner
      AND acl.grantee <> 0
  LOOP
    EXECUTE format('REVOKE DELETE, TRUNCATE ON price_lists FROM %s', grantee);
  END LOOP;
END;
$$;
--> statement-breakpoint
REVOKE DELETE, TRUNCATE ON price_list_fixed_prices FROM PUBLIC;
--> statement-breakpoint
DO $$
DECLARE
  grantee text;
BEGIN
  FOR grantee IN
    SELECT DISTINCT acl.grantee::regrole::text
    FROM pg_class AS c, aclexplode(c.relacl) AS acl
    WHERE c.oid = 'price_list_fixed_prices'::regclass
      AND acl.grantee <> c.relowner
      AND acl.grantee <> 0
  LOOP
    EXECUTE format('REVOKE DELETE, TRUNCATE ON price_list_fixed_prices FROM %s', grantee);
  END LOOP;
END;
$$;
--> statement-breakpoint
-- S20 PO2: `orders_guard` (migrations 0031, 0035, 0037, 0053, 0074) also fixes the list an order
-- was charged on, with the price columns (they change together only on `awaiting_balance → paid`).
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
    OR NEW.player_region IS DISTINCT FROM OLD.player_region
    OR NEW.checkout_id IS DISTINCT FROM OLD.checkout_id
    OR NEW.checkout_line IS DISTINCT FROM OLD.checkout_line
    OR NEW.is_gift IS DISTINCT FROM OLD.is_gift
    OR NEW.gift_sender_name IS DISTINCT FROM OLD.gift_sender_name
    OR NEW.gift_message IS DISTINCT FROM OLD.gift_message
    OR NEW.placed_by IS DISTINCT FROM OLD.placed_by
    OR NEW.payer IS DISTINCT FROM OLD.payer
    OR NEW.admin_purpose IS DISTINCT FROM OLD.admin_purpose
    OR NEW.admin_id IS DISTINCT FROM OLD.admin_id
    OR NEW.admin_reason IS DISTINCT FROM OLD.admin_reason
    OR NEW.customer_note IS DISTINCT FROM OLD.customer_note
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
    OR NEW.price_list_id IS DISTINCT FROM OLD.price_list_id
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
