-- S21 PR 1 (ADR 0036): the merchant tools' guards and grants.

-- merchant_alert_events (AL2–AL4): never changed; only rows older than 90 days are deleted, by
-- the sweep.
CREATE FUNCTION merchant_alert_events_guard() RETURNS trigger LANGUAGE plpgsql
SET search_path = public, pg_temp AS $$
BEGIN
  IF TG_OP = 'UPDATE' THEN
    RAISE EXCEPTION 'merchant alert events are never changed' USING ERRCODE = 'restrict_violation';
  END IF;
  IF TG_OP = 'DELETE' THEN
    IF OLD.created_at >= now() - interval '90 days' THEN
      RAISE EXCEPTION 'merchant alert event %: kept 90 days', OLD.id
        USING ERRCODE = 'restrict_violation';
    END IF;
    RETURN OLD;
  END IF;
  RAISE EXCEPTION 'merchant alert events are never truncated' USING ERRCODE = 'restrict_violation';
END;
$$;
--> statement-breakpoint
CREATE TRIGGER merchant_alert_events_guard BEFORE UPDATE OR DELETE ON merchant_alert_events
  FOR EACH ROW EXECUTE FUNCTION merchant_alert_events_guard();
--> statement-breakpoint
CREATE TRIGGER merchant_alert_events_truncate_guard BEFORE TRUNCATE ON merchant_alert_events
  FOR EACH STATEMENT EXECUTE FUNCTION merchant_alert_events_guard();
--> statement-breakpoint

-- merchant_order_sales (SP4, SP5): one row per order of its own customer, never deleted; the order
-- and the customer are fixed.
CREATE FUNCTION merchant_order_sales_guard() RETURNS trigger LANGUAGE plpgsql
SET search_path = public, pg_temp AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'merchant order sales are never deleted' USING ERRCODE = 'restrict_violation';
  END IF;
  IF TG_OP = 'UPDATE' AND (NEW.order_id IS DISTINCT FROM OLD.order_id
    OR NEW.customer_id IS DISTINCT FROM OLD.customer_id) THEN
    RAISE EXCEPTION 'merchant order sale %: its order and customer are fixed', OLD.order_id
      USING ERRCODE = 'restrict_violation';
  END IF;
  IF TG_OP = 'INSERT' AND NOT EXISTS (
    SELECT 1 FROM public.orders WHERE id = NEW.order_id AND customer_id = NEW.customer_id
  ) THEN
    RAISE EXCEPTION 'merchant order sale %: not an order of its customer', NEW.order_id
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER merchant_order_sales_guard BEFORE INSERT OR UPDATE OR DELETE ON merchant_order_sales
  FOR EACH ROW EXECUTE FUNCTION merchant_order_sales_guard();
--> statement-breakpoint

-- The app role loses UPDATE and TRUNCATE on the alert events, DELETE and TRUNCATE on the sales and
-- the levels (archived, never deleted): revoked from PUBLIC and from every role but the owner,
-- whatever the app role is called.
REVOKE UPDATE, TRUNCATE ON merchant_alert_events FROM PUBLIC;
--> statement-breakpoint
REVOKE DELETE, TRUNCATE ON merchant_order_sales, merchant_levels FROM PUBLIC;
--> statement-breakpoint
DO $$
DECLARE
  target regclass;
  grantee text;
BEGIN
  FOR grantee IN
    SELECT DISTINCT acl.grantee::regrole::text
    FROM pg_class AS c, aclexplode(c.relacl) AS acl
    WHERE c.oid = 'merchant_alert_events'::regclass
      AND acl.grantee <> c.relowner
      AND acl.grantee <> 0
  LOOP
    EXECUTE format('REVOKE UPDATE, TRUNCATE ON merchant_alert_events FROM %s', grantee);
  END LOOP;
  FOREACH target IN ARRAY ARRAY['merchant_order_sales'::regclass, 'merchant_levels'::regclass]
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
