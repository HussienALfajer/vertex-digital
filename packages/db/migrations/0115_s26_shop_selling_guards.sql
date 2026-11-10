-- S26 PR 2 (spec docs/specs/S26-merchant-shops.md, ADR 0040): the guards and grants of shop
-- selling. Hand-written; never edit once applied. Enum values added in this run (`merchant`) are
-- never named here.

-- PR6: `orders_guard` (migrations 0031, 0035, 0037, 0053, 0074, 0078, 0088) also fixes the shop
-- customer who bought a shop order.
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
    OR NEW.shop_customer_id IS DISTINCT FROM OLD.shop_customer_id
    OR NEW.is_test IS DISTINCT FROM OLD.is_test
    OR NEW.product_id IS DISTINCT FROM OLD.product_id
    OR NEW.game_id IS DISTINCT FROM OLD.game_id
    OR NEW.kind IS DISTINCT FROM OLD.kind
    OR NEW.quantity IS DISTINCT FROM OLD.quantity
    OR NEW.fields IS DISTINCT FROM OLD.fields
    OR NEW.verification_code IS DISTINCT FROM OLD.verification_code
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
--> statement-breakpoint

-- TK1, TK2: a shop ticket's shop and customer are fixed like the rest of what it is about
-- (migration 0095's guard); its escalation is set once and never cleared.
CREATE OR REPLACE FUNCTION support_tickets_guard() RETURNS trigger LANGUAGE plpgsql
SET search_path = public, pg_temp AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'support tickets are never deleted' USING ERRCODE = 'restrict_violation';
  END IF;
  IF NEW.id IS DISTINCT FROM OLD.id
    OR NEW.number IS DISTINCT FROM OLD.number
    OR NEW.customer_id IS DISTINCT FROM OLD.customer_id
    OR NEW.shop_id IS DISTINCT FROM OLD.shop_id
    OR NEW.shop_customer_id IS DISTINCT FROM OLD.shop_customer_id
    OR NEW.category IS DISTINCT FROM OLD.category
    OR NEW.order_id IS DISTINCT FROM OLD.order_id
    OR NEW.deposit_id IS DISTINCT FROM OLD.deposit_id
    OR NEW.subject IS DISTINCT FROM OLD.subject
    OR NEW.order_problem IS DISTINCT FROM OLD.order_problem
    OR NEW.opened_by IS DISTINCT FROM OLD.opened_by
    OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'support ticket %: what it is about is fixed', OLD.id
      USING ERRCODE = 'restrict_violation';
  END IF;
  IF OLD.escalated_at IS NOT NULL AND NEW.escalated_at IS DISTINCT FROM OLD.escalated_at THEN
    RAISE EXCEPTION 'support ticket %: escalated once', OLD.id
      USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint

-- PR6, PR8: a shop order's sale row is never deleted; only its released margin is set, once.
CREATE FUNCTION shop_order_sales_guard() RETURNS trigger LANGUAGE plpgsql
SET search_path = public, pg_temp AS $$
BEGIN
  IF TG_OP = 'DELETE' OR TG_OP = 'TRUNCATE' THEN
    RAISE EXCEPTION 'shop order sales are never deleted' USING ERRCODE = 'restrict_violation';
  END IF;
  IF NEW.order_id IS DISTINCT FROM OLD.order_id
    OR NEW.shop_id IS DISTINCT FROM OLD.shop_id
    OR NEW.shop_customer_id IS DISTINCT FROM OLD.shop_customer_id
    OR NEW.unit_sell_usd_units IS DISTINCT FROM OLD.unit_sell_usd_units
    OR NEW.unit_buy_usd_units IS DISTINCT FROM OLD.unit_buy_usd_units
    OR NEW.quantity IS DISTINCT FROM OLD.quantity
    OR NEW.sell_currency IS DISTINCT FROM OLD.sell_currency
    OR NEW.unit_sell_entered_units IS DISTINCT FROM OLD.unit_sell_entered_units
    OR NEW.unit_sell_syp_units IS DISTINCT FROM OLD.unit_sell_syp_units
    OR NEW.rate_syp_per_usd IS DISTINCT FROM OLD.rate_syp_per_usd
    OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'shop order sale %: fixed after insert', OLD.order_id
      USING ERRCODE = 'restrict_violation';
  END IF;
  IF OLD.margin_released_usd_units IS NOT NULL
    AND NEW.margin_released_usd_units IS DISTINCT FROM OLD.margin_released_usd_units THEN
    RAISE EXCEPTION 'shop order sale %: its margin is released once', OLD.order_id
      USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER shop_order_sales_guard BEFORE UPDATE OR DELETE ON shop_order_sales
  FOR EACH ROW EXECUTE FUNCTION shop_order_sales_guard();
--> statement-breakpoint
CREATE TRIGGER shop_order_sales_truncate_guard BEFORE TRUNCATE ON shop_order_sales
  FOR EACH STATEMENT EXECUTE FUNCTION shop_order_sales_guard();
--> statement-breakpoint

-- PR10 (append-only): the trigger of migration 0001 refuses UPDATE, DELETE and TRUNCATE.
CREATE TRIGGER shop_compensations_append_only BEFORE UPDATE OR DELETE ON shop_compensations
  FOR EACH ROW EXECUTE FUNCTION append_only_guard();
--> statement-breakpoint
CREATE TRIGGER shop_compensations_no_truncate BEFORE TRUNCATE ON shop_compensations
  FOR EACH STATEMENT EXECUTE FUNCTION append_only_guard();
--> statement-breakpoint

-- PR9: a shop customer's notification changes only its read time, once (migration 0021's rule).
CREATE FUNCTION shop_customer_notifications_guard() RETURNS trigger LANGUAGE plpgsql
SET search_path = public, pg_temp AS $$
BEGIN
  IF TG_OP = 'DELETE' OR TG_OP = 'TRUNCATE' THEN
    RAISE EXCEPTION 'shop customer notifications are never deleted'
      USING ERRCODE = 'restrict_violation';
  END IF;
  IF NEW.id IS DISTINCT FROM OLD.id
    OR NEW.shop_customer_id IS DISTINCT FROM OLD.shop_customer_id
    OR NEW.shop_id IS DISTINCT FROM OLD.shop_id
    OR NEW.event IS DISTINCT FROM OLD.event
    OR NEW.params IS DISTINCT FROM OLD.params
    OR NEW.created_at IS DISTINCT FROM OLD.created_at
    OR (OLD.read_at IS NOT NULL AND NEW.read_at IS DISTINCT FROM OLD.read_at) THEN
    RAISE EXCEPTION 'shop customer notification % changes only its read time, once', OLD.id
      USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER shop_customer_notifications_guard BEFORE UPDATE OR DELETE
  ON shop_customer_notifications
  FOR EACH ROW EXECUTE FUNCTION shop_customer_notifications_guard();
--> statement-breakpoint
CREATE TRIGGER shop_customer_notifications_truncate_guard BEFORE TRUNCATE
  ON shop_customer_notifications
  FOR EACH STATEMENT EXECUTE FUNCTION shop_customer_notifications_guard();
--> statement-breakpoint

-- SP3: the day's counters are never deleted and never go down.
CREATE FUNCTION shop_daily_stats_guard() RETURNS trigger LANGUAGE plpgsql
SET search_path = public, pg_temp AS $$
BEGIN
  IF TG_OP = 'DELETE' OR TG_OP = 'TRUNCATE' THEN
    RAISE EXCEPTION 'shop statistics are never deleted' USING ERRCODE = 'restrict_violation';
  END IF;
  IF NEW.shop_id IS DISTINCT FROM OLD.shop_id
    OR NEW.damascus_date IS DISTINCT FROM OLD.damascus_date
    OR NEW.visits < OLD.visits
    OR NEW.sign_ups < OLD.sign_ups THEN
    RAISE EXCEPTION 'shop statistics only count up' USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER shop_daily_stats_guard BEFORE UPDATE OR DELETE ON shop_daily_stats
  FOR EACH ROW EXECUTE FUNCTION shop_daily_stats_guard();
--> statement-breakpoint
CREATE TRIGGER shop_daily_stats_truncate_guard BEFORE TRUNCATE ON shop_daily_stats
  FOR EACH STATEMENT EXECUTE FUNCTION shop_daily_stats_guard();
--> statement-breakpoint

-- Grants, revoked from PUBLIC and from every role but the owner, whatever the app role is called:
-- compensations SELECT and INSERT only; sales, notifications and statistics lose DELETE and
-- TRUNCATE, and sales and notifications keep UPDATE of their one changing column only.
REVOKE UPDATE, DELETE, TRUNCATE ON shop_compensations, shop_order_sales, shop_customer_notifications FROM PUBLIC;
--> statement-breakpoint
REVOKE DELETE, TRUNCATE ON shop_daily_stats FROM PUBLIC;
--> statement-breakpoint
DO $$
DECLARE
  target regclass;
  grantee text;
BEGIN
  FOREACH target IN ARRAY ARRAY['shop_compensations'::regclass, 'shop_order_sales'::regclass, 'shop_customer_notifications'::regclass]
  LOOP
    FOR grantee IN
      SELECT DISTINCT acl.grantee::regrole::text
      FROM pg_class AS c, aclexplode(c.relacl) AS acl
      WHERE c.oid = target
        AND acl.grantee <> c.relowner
        AND acl.grantee <> 0
    LOOP
      EXECUTE format('REVOKE UPDATE, DELETE, TRUNCATE ON %s FROM %s', target, grantee);
      IF target = 'shop_order_sales'::regclass THEN
        EXECUTE format('GRANT UPDATE (margin_released_usd_units) ON %s TO %s', target, grantee);
      ELSIF target = 'shop_customer_notifications'::regclass THEN
        EXECUTE format('GRANT UPDATE (read_at) ON %s TO %s', target, grantee);
      END IF;
    END LOOP;
  END LOOP;
  FOR grantee IN
    SELECT DISTINCT acl.grantee::regrole::text
    FROM pg_class AS c, aclexplode(c.relacl) AS acl
    WHERE c.oid = 'shop_daily_stats'::regclass
      AND acl.grantee <> c.relowner
      AND acl.grantee <> 0
  LOOP
    EXECUTE format('REVOKE DELETE, TRUNCATE ON shop_daily_stats FROM %s', grantee);
  END LOOP;
END;
$$;
