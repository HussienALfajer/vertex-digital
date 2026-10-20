-- S19 PC9: `orders_guard` (migrations 0031, 0035, 0037, 0053) also fixes the player's region,
-- written with the name by the purchase and never changed after.
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
-- S19 PC1: a game's check provider is turned off (`enabled`), never deleted: its changes are
-- audited against the row. The app role loses DELETE and TRUNCATE on it, revoked from PUBLIC and
-- from every role but the owner, whatever the app role is called.
REVOKE DELETE, TRUNCATE ON game_player_checks FROM PUBLIC;
--> statement-breakpoint
DO $$
DECLARE
  grantee text;
BEGIN
  FOR grantee IN
    SELECT DISTINCT acl.grantee::regrole::text
    FROM pg_class AS c, aclexplode(c.relacl) AS acl
    WHERE c.oid = 'game_player_checks'::regclass
      AND acl.grantee <> c.relowner
      AND acl.grantee <> 0
  LOOP
    EXECUTE format('REVOKE DELETE, TRUNCATE ON game_player_checks FROM %s', grantee);
  END LOOP;
END;
$$;
