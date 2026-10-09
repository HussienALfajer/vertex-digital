-- Orders and fulfilment (S08, F11; ADR 0004, 0014): what drizzle-kit cannot express. Hand-written;
-- never edit once applied.

-- Append-only (S08 "Data"): order events, codes, code reveals and the policy are new rows; the
-- trigger of migration 0001 refuses UPDATE, DELETE and TRUNCATE whoever runs them.
CREATE TRIGGER order_events_append_only BEFORE UPDATE OR DELETE ON order_events
  FOR EACH ROW EXECUTE FUNCTION append_only_guard();
--> statement-breakpoint
CREATE TRIGGER order_events_no_truncate BEFORE TRUNCATE ON order_events
  FOR EACH STATEMENT EXECUTE FUNCTION append_only_guard();
--> statement-breakpoint
CREATE TRIGGER order_codes_append_only BEFORE UPDATE OR DELETE ON order_codes
  FOR EACH ROW EXECUTE FUNCTION append_only_guard();
--> statement-breakpoint
CREATE TRIGGER order_codes_no_truncate BEFORE TRUNCATE ON order_codes
  FOR EACH STATEMENT EXECUTE FUNCTION append_only_guard();
--> statement-breakpoint
CREATE TRIGGER order_code_reveals_append_only BEFORE UPDATE OR DELETE ON order_code_reveals
  FOR EACH ROW EXECUTE FUNCTION append_only_guard();
--> statement-breakpoint
CREATE TRIGGER order_code_reveals_no_truncate BEFORE TRUNCATE ON order_code_reveals
  FOR EACH STATEMENT EXECUTE FUNCTION append_only_guard();
--> statement-breakpoint
CREATE TRIGGER order_policy_append_only BEFORE UPDATE OR DELETE ON order_policy
  FOR EACH ROW EXECUTE FUNCTION append_only_guard();
--> statement-breakpoint
CREATE TRIGGER order_policy_no_truncate BEFORE TRUNCATE ON order_policy
  FOR EACH STATEMENT EXECUTE FUNCTION append_only_guard();
--> statement-breakpoint

-- The app role keeps SELECT and INSERT only on the append-only tables, and loses DELETE and
-- TRUNCATE on orders and attempts: revoked from PUBLIC and from every role but the owner, whatever
-- the app role is called. Webhook events keep an UPDATE of their processing columns only.
REVOKE UPDATE, DELETE, TRUNCATE ON order_events, order_codes, order_code_reveals, order_policy, supplier_webhook_events FROM PUBLIC;
--> statement-breakpoint
REVOKE DELETE, TRUNCATE ON orders, fulfilment_attempts FROM PUBLIC;
--> statement-breakpoint
DO $$
DECLARE
  target regclass;
  grantee text;
BEGIN
  FOREACH target IN ARRAY ARRAY['order_events'::regclass, 'order_codes'::regclass, 'order_code_reveals'::regclass, 'order_policy'::regclass, 'supplier_webhook_events'::regclass]
  LOOP
    FOR grantee IN
      SELECT DISTINCT acl.grantee::regrole::text
      FROM pg_class AS c, aclexplode(c.relacl) AS acl
      WHERE c.oid = target
        AND acl.grantee <> c.relowner
        AND acl.grantee <> 0
    LOOP
      EXECUTE format('REVOKE UPDATE, DELETE, TRUNCATE ON %s FROM %s', target, grantee);
      IF target = 'supplier_webhook_events'::regclass THEN
        EXECUTE format('GRANT UPDATE (attempt_id, processed_at, result) ON supplier_webhook_events TO %s', grantee);
      END IF;
    END LOOP;
  END LOOP;
  FOREACH target IN ARRAY ARRAY['orders'::regclass, 'fulfilment_attempts'::regclass]
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
--> statement-breakpoint

-- An order is never deleted; a terminal order never changes; the identity, price and field
-- columns are fixed at purchase; a status changes only along ADR 0004's table (and ADR 0013's
-- `paid → refunded`); delivered and refunded units never go back; a refund journal is set once.
CREATE FUNCTION orders_guard() RETURNS trigger LANGUAGE plpgsql
SET search_path = public, pg_temp AS $$
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
    OR NEW.unit_price_usd_units IS DISTINCT FROM OLD.unit_price_usd_units
    OR NEW.total_usd_units IS DISTINCT FROM OLD.total_usd_units
    OR NEW.price_id IS DISTINCT FROM OLD.price_id
    OR NEW.min_margin_usd_units IS DISTINCT FROM OLD.min_margin_usd_units
    OR NEW.fields IS DISTINCT FROM OLD.fields
    OR NEW.display_rate_id IS DISTINCT FROM OLD.display_rate_id
    OR NEW.total_syp_units IS DISTINCT FROM OLD.total_syp_units
    OR NEW.idempotency_key IS DISTINCT FROM OLD.idempotency_key
    OR NEW.request_hash IS DISTINCT FROM OLD.request_hash
    OR NEW.purchase_journal_id IS DISTINCT FROM OLD.purchase_journal_id
    OR NEW.paid_at IS DISTINCT FROM OLD.paid_at
    OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'order %: its identity, price and fields are fixed', OLD.id
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
CREATE TRIGGER orders_guard BEFORE UPDATE OR DELETE ON orders
  FOR EACH ROW EXECUTE FUNCTION orders_guard();
--> statement-breakpoint
CREATE TRIGGER orders_no_truncate BEFORE TRUNCATE ON orders
  FOR EACH STATEMENT EXECUTE FUNCTION append_only_guard();
--> statement-breakpoint

-- An attempt is never deleted; a delivered or failed attempt never changes (ADR 0004: its result
-- is final); what was asked of which supplier, and the routing decision, are fixed.
CREATE FUNCTION fulfilment_attempts_guard() RETURNS trigger LANGUAGE plpgsql
SET search_path = public, pg_temp AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'fulfilment attempts are never deleted' USING ERRCODE = 'restrict_violation';
  END IF;
  IF OLD.status IN ('delivered', 'failed') THEN
    RAISE EXCEPTION 'attempt % is % and never changes', OLD.id, OLD.status
      USING ERRCODE = 'restrict_violation';
  END IF;
  IF NEW.id IS DISTINCT FROM OLD.id
    OR NEW.order_id IS DISTINCT FROM OLD.order_id
    OR NEW.route_id IS DISTINCT FROM OLD.route_id
    OR NEW.supplier_id IS DISTINCT FROM OLD.supplier_id
    OR NEW.offer_id IS DISTINCT FROM OLD.offer_id
    OR NEW.supplier_offer_id IS DISTINCT FROM OLD.supplier_offer_id
    OR NEW.quantity IS DISTINCT FROM OLD.quantity
    OR NEW.unit_cost_usd_units IS DISTINCT FROM OLD.unit_cost_usd_units
    OR NEW.candidates IS DISTINCT FROM OLD.candidates
    OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'attempt %: its supplier, offer, units, cost and candidates are fixed', OLD.id
      USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER fulfilment_attempts_guard BEFORE UPDATE OR DELETE ON fulfilment_attempts
  FOR EACH ROW EXECUTE FUNCTION fulfilment_attempts_guard();
--> statement-breakpoint
CREATE TRIGGER fulfilment_attempts_no_truncate BEFORE TRUNCATE ON fulfilment_attempts
  FOR EACH STATEMENT EXECUTE FUNCTION append_only_guard();
--> statement-breakpoint

-- A stored webhook (rule F4) is never deleted; only its processing columns change, once, from
-- unprocessed to processed (rule F5).
CREATE FUNCTION supplier_webhook_events_guard() RETURNS trigger LANGUAGE plpgsql
SET search_path = public, pg_temp AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'supplier webhook events are never deleted'
      USING ERRCODE = 'restrict_violation';
  END IF;
  IF NEW.id IS DISTINCT FROM OLD.id
    OR NEW.supplier_id IS DISTINCT FROM OLD.supplier_id
    OR NEW.event_id IS DISTINCT FROM OLD.event_id
    OR NEW.body_ciphertext IS DISTINCT FROM OLD.body_ciphertext
    OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'supplier webhook event % changes only its processing', OLD.id
      USING ERRCODE = 'restrict_violation';
  END IF;
  IF OLD.processed_at IS NOT NULL THEN
    RAISE EXCEPTION 'supplier webhook event % is already processed', OLD.id
      USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER supplier_webhook_events_guard BEFORE UPDATE OR DELETE ON supplier_webhook_events
  FOR EACH ROW EXECUTE FUNCTION supplier_webhook_events_guard();
--> statement-breakpoint
CREATE TRIGGER supplier_webhook_events_no_truncate BEFORE TRUNCATE ON supplier_webhook_events
  FOR EACH STATEMENT EXECUTE FUNCTION append_only_guard();
--> statement-breakpoint

-- The order policy's defaults (owner, 2026-10-09): the first poll after 60 s, every 60 s for 10
-- minutes, then every 5 minutes; held after 30 minutes, then polled every 30 minutes for 24 hours;
-- a manual attempt's reminder after 15 minutes. A fixed id, so every database holds the same row.
INSERT INTO order_policy (id, first_poll_seconds, fast_poll_seconds, fast_poll_minutes,
  slow_poll_seconds, hard_limit_minutes, review_poll_minutes, review_poll_hours,
  manual_reminder_minutes, admin_id)
VALUES ('01a1a6f0-9c00-7a00-8c00-000000000801', 60, 60, 10, 300, 30, 30, 24, 15, NULL)
ON CONFLICT DO NOTHING;
