-- Checkouts, gifts and share links (S10; ADR 0003, 0004, 0014): what drizzle-kit cannot
-- express. Hand-written; never edit once applied.

-- `orders_guard` (migrations 0031, 0035) also fixes the checkout and the gift: an order's
-- checkout, its line and its gift texts are part of its identity (S10 "orders (changed)").
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
    OR NEW.checkout_id IS DISTINCT FROM OLD.checkout_id
    OR NEW.checkout_line IS DISTINCT FROM OLD.checkout_line
    OR NEW.is_gift IS DISTINCT FROM OLD.is_gift
    OR NEW.gift_sender_name IS DISTINCT FROM OLD.gift_sender_name
    OR NEW.gift_message IS DISTINCT FROM OLD.gift_message
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

-- Rule M1 (S10): the orders of a checkout share its one purchase journal, and only theirs. A
-- checkout order is inserted paid with its checkout's journal, for its checkout's customer; any
-- other order never takes a checkout's journal (the partial unique index covers single orders).
CREATE FUNCTION orders_checkout_guard() RETURNS trigger LANGUAGE plpgsql
SET search_path = public, pg_temp AS $$
DECLARE
  checkout public.checkouts%ROWTYPE;
BEGIN
  IF NEW.checkout_id IS NULL THEN
    IF NEW.purchase_journal_id IS NOT NULL AND EXISTS (
      SELECT 1 FROM public.checkouts WHERE purchase_journal_id = NEW.purchase_journal_id) THEN
      RAISE EXCEPTION 'order %: a checkout''s journal pays only its checkout''s orders', NEW.id
        USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
  END IF;
  SELECT * INTO checkout FROM public.checkouts WHERE id = NEW.checkout_id;
  IF NEW.purchase_journal_id IS DISTINCT FROM checkout.purchase_journal_id
    OR NEW.customer_id IS DISTINCT FROM checkout.customer_id
    OR NEW.is_test IS DISTINCT FROM checkout.is_test THEN
    RAISE EXCEPTION 'order %: a checkout order carries its checkout''s journal and customer', NEW.id
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER orders_checkout_guard BEFORE INSERT OR UPDATE OF purchase_journal_id ON orders
  FOR EACH ROW EXECUTE FUNCTION orders_checkout_guard();
--> statement-breakpoint

-- `checkouts` (rules CT5, CT7): never deleted; only `finished_at` changes, once, from empty to
-- a time (and `updated_at` with it).
CREATE FUNCTION checkouts_guard() RETURNS trigger LANGUAGE plpgsql
SET search_path = public, pg_temp AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'checkouts are never deleted' USING ERRCODE = 'restrict_violation';
  END IF;
  IF OLD.finished_at IS NOT NULL
    OR NEW.finished_at IS NULL
    OR (to_jsonb(NEW) - 'finished_at' - 'updated_at')
      IS DISTINCT FROM (to_jsonb(OLD) - 'finished_at' - 'updated_at') THEN
    RAISE EXCEPTION 'checkout %: only finished_at changes, once', OLD.id
      USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER checkouts_guard BEFORE UPDATE OR DELETE ON checkouts
  FOR EACH ROW EXECUTE FUNCTION checkouts_guard();
--> statement-breakpoint
REVOKE DELETE, TRUNCATE ON checkouts FROM PUBLIC;
--> statement-breakpoint
DO $$
DECLARE
  grantee text;
BEGIN
  FOR grantee IN
    SELECT DISTINCT acl.grantee::regrole::text
    FROM pg_class AS c, aclexplode(c.relacl) AS acl
    WHERE c.oid = 'checkouts'::regclass
      AND acl.grantee <> c.relowner
      AND acl.grantee <> 0
  LOOP
    EXECUTE format('REVOKE DELETE, TRUNCATE ON checkouts FROM %s', grantee);
  END LOOP;
END;
$$;
--> statement-breakpoint

-- `order_share_links` (rules GF4, RC1, RC3, AD1): never deleted; the order, kind and token are
-- fixed; a revoked link never changes again.
CREATE FUNCTION order_share_links_guard() RETURNS trigger LANGUAGE plpgsql
SET search_path = public, pg_temp AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'share links are never deleted' USING ERRCODE = 'restrict_violation';
  END IF;
  IF OLD.revoked_at IS NOT NULL THEN
    RAISE EXCEPTION 'share link % is revoked and never changes', OLD.id
      USING ERRCODE = 'restrict_violation';
  END IF;
  IF NEW.id IS DISTINCT FROM OLD.id
    OR NEW.order_id IS DISTINCT FROM OLD.order_id
    OR NEW.kind IS DISTINCT FROM OLD.kind
    OR NEW.token IS DISTINCT FROM OLD.token
    OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'share link %: its order, kind and token are fixed', OLD.id
      USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER order_share_links_guard BEFORE UPDATE OR DELETE ON order_share_links
  FOR EACH ROW EXECUTE FUNCTION order_share_links_guard();
--> statement-breakpoint
REVOKE DELETE, TRUNCATE ON order_share_links FROM PUBLIC;
--> statement-breakpoint
DO $$
DECLARE
  grantee text;
BEGIN
  FOR grantee IN
    SELECT DISTINCT acl.grantee::regrole::text
    FROM pg_class AS c, aclexplode(c.relacl) AS acl
    WHERE c.oid = 'order_share_links'::regclass
      AND acl.grantee <> c.relowner
      AND acl.grantee <> 0
  LOOP
    EXECUTE format('REVOKE DELETE, TRUNCATE ON order_share_links FROM %s', grantee);
  END LOOP;
END;
$$;
