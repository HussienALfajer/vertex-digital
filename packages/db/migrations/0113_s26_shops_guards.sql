-- S26 PR 1 (spec docs/specs/S26-merchant-shops.md, ADR 0040): the merchant shops' guards and
-- grants. Hand-written; never edit once applied. Statuses are compared as text where a guard
-- could meet values added in the same run.

-- Append-only: slugs ever held (SH3), own rates (ST3), transfers (WL1, WL5) and settlements (WL9);
-- the trigger of migration 0001 refuses UPDATE, DELETE and TRUNCATE whoever runs them.
CREATE TRIGGER merchant_shop_slugs_append_only BEFORE UPDATE OR DELETE ON merchant_shop_slugs
  FOR EACH ROW EXECUTE FUNCTION append_only_guard();
--> statement-breakpoint
CREATE TRIGGER merchant_shop_slugs_no_truncate BEFORE TRUNCATE ON merchant_shop_slugs
  FOR EACH STATEMENT EXECUTE FUNCTION append_only_guard();
--> statement-breakpoint
CREATE TRIGGER merchant_shop_rates_append_only BEFORE UPDATE OR DELETE ON merchant_shop_rates
  FOR EACH ROW EXECUTE FUNCTION append_only_guard();
--> statement-breakpoint
CREATE TRIGGER merchant_shop_rates_no_truncate BEFORE TRUNCATE ON merchant_shop_rates
  FOR EACH STATEMENT EXECUTE FUNCTION append_only_guard();
--> statement-breakpoint
CREATE TRIGGER shop_transfers_append_only BEFORE UPDATE OR DELETE ON shop_transfers
  FOR EACH ROW EXECUTE FUNCTION append_only_guard();
--> statement-breakpoint
CREATE TRIGGER shop_transfers_no_truncate BEFORE TRUNCATE ON shop_transfers
  FOR EACH STATEMENT EXECUTE FUNCTION append_only_guard();
--> statement-breakpoint
CREATE TRIGGER shop_settlements_append_only BEFORE UPDATE OR DELETE ON shop_settlements
  FOR EACH ROW EXECUTE FUNCTION append_only_guard();
--> statement-breakpoint
CREATE TRIGGER shop_settlements_no_truncate BEFORE TRUNCATE ON shop_settlements
  FOR EACH STATEMENT EXECUTE FUNCTION append_only_guard();
--> statement-breakpoint

-- The shop states table (S26 "Shop states"): a shop is never deleted; its merchant and request
-- time are fixed; it moves only along the table, a closed or rejected shop never moves again (a
-- rejected one is archived once); the list a closed shop sells at is set with the close, once.
CREATE FUNCTION merchant_shops_guard() RETURNS trigger LANGUAGE plpgsql
SET search_path = public, pg_temp AS $$
DECLARE
  moved boolean;
BEGIN
  IF TG_OP = 'DELETE' OR TG_OP = 'TRUNCATE' THEN
    RAISE EXCEPTION 'merchant shops are never deleted' USING ERRCODE = 'restrict_violation';
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW.status::text <> 'requested' OR NEW.price_list_id_at_close IS NOT NULL
      OR NEW.archived_at IS NOT NULL THEN
      RAISE EXCEPTION 'a merchant shop starts requested' USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
  END IF;
  IF NEW.id IS DISTINCT FROM OLD.id
    OR NEW.merchant_id IS DISTINCT FROM OLD.merchant_id
    OR NEW.requested_at IS DISTINCT FROM OLD.requested_at
    OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'merchant shop %: its merchant and request are fixed', OLD.id
      USING ERRCODE = 'restrict_violation';
  END IF;
  IF OLD.archived_at IS NOT NULL THEN
    RAISE EXCEPTION 'merchant shop %: archived', OLD.id USING ERRCODE = 'restrict_violation';
  END IF;
  IF NEW.archived_at IS NOT NULL AND OLD.status::text <> 'rejected' THEN
    RAISE EXCEPTION 'merchant shop %: only a rejected request is archived', OLD.id
      USING ERRCODE = 'restrict_violation';
  END IF;
  moved := NEW.status IS DISTINCT FROM OLD.status;
  IF moved AND NOT (
    (OLD.status::text = 'requested' AND NEW.status::text IN ('active', 'rejected'))
    OR (OLD.status::text = 'active' AND NEW.status::text IN ('suspended', 'closed'))
    OR (OLD.status::text = 'suspended' AND NEW.status::text IN ('active', 'closed'))
  ) THEN
    RAISE EXCEPTION 'merchant shop %: % to % is not allowed', OLD.id, OLD.status, NEW.status
      USING ERRCODE = 'restrict_violation';
  END IF;
  IF OLD.status::text = 'rejected' AND (NEW IS DISTINCT FROM OLD)
    AND NOT (NEW.archived_at IS NOT NULL AND OLD.archived_at IS NULL) THEN
    RAISE EXCEPTION 'merchant shop %: a rejected request changes only by its archive', OLD.id
      USING ERRCODE = 'restrict_violation';
  END IF;
  IF NEW.price_list_id_at_close IS DISTINCT FROM OLD.price_list_id_at_close
    AND NOT (moved AND NEW.status::text = 'closed' AND OLD.price_list_id_at_close IS NULL) THEN
    RAISE EXCEPTION 'merchant shop %: its closing list is set once, with the close', OLD.id
      USING ERRCODE = 'restrict_violation';
  END IF;
  IF NEW.closed_at IS DISTINCT FROM OLD.closed_at
    AND NOT (moved AND NEW.status::text = 'closed') THEN
    RAISE EXCEPTION 'merchant shop %: its close time is set with the close', OLD.id
      USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER merchant_shops_guard BEFORE INSERT OR UPDATE OR DELETE ON merchant_shops
  FOR EACH ROW EXECUTE FUNCTION merchant_shops_guard();
--> statement-breakpoint
CREATE TRIGGER merchant_shops_truncate_guard BEFORE TRUNCATE ON merchant_shops
  FOR EACH STATEMENT EXECUTE FUNCTION merchant_shops_guard();
--> statement-breakpoint

-- WL5: a return request is never deleted; its shop, customer, amount, expiry and key are fixed;
-- it starts pending and only a pending request ends, once, with its decision time.
CREATE FUNCTION shop_return_requests_guard() RETURNS trigger LANGUAGE plpgsql
SET search_path = public, pg_temp AS $$
BEGIN
  IF TG_OP = 'DELETE' OR TG_OP = 'TRUNCATE' THEN
    RAISE EXCEPTION 'shop return requests are never deleted' USING ERRCODE = 'restrict_violation';
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW.status::text <> 'pending' THEN
      RAISE EXCEPTION 'a shop return request starts pending' USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
  END IF;
  IF NEW.id IS DISTINCT FROM OLD.id
    OR NEW.shop_id IS DISTINCT FROM OLD.shop_id
    OR NEW.shop_customer_id IS DISTINCT FROM OLD.shop_customer_id
    OR NEW.amount_usd_units IS DISTINCT FROM OLD.amount_usd_units
    OR NEW.expires_at IS DISTINCT FROM OLD.expires_at
    OR NEW.idempotency_key IS DISTINCT FROM OLD.idempotency_key
    OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'shop return request %: only its end changes', OLD.id
      USING ERRCODE = 'restrict_violation';
  END IF;
  IF OLD.status::text <> 'pending' THEN
    RAISE EXCEPTION 'shop return request %: ended already', OLD.id
      USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER shop_return_requests_guard BEFORE INSERT OR UPDATE OR DELETE ON shop_return_requests
  FOR EACH ROW EXECUTE FUNCTION shop_return_requests_guard();
--> statement-breakpoint
CREATE TRIGGER shop_return_requests_truncate_guard BEFORE TRUNCATE ON shop_return_requests
  FOR EACH STATEMENT EXECUTE FUNCTION shop_return_requests_guard();
--> statement-breakpoint

-- CA9: a shop customer is archived, never deleted (a wallet may name it); its shop, origin and
-- creation are fixed.
CREATE FUNCTION shop_customers_guard() RETURNS trigger LANGUAGE plpgsql
SET search_path = public, pg_temp AS $$
BEGIN
  IF TG_OP = 'DELETE' OR TG_OP = 'TRUNCATE' THEN
    RAISE EXCEPTION 'shop customers are never deleted' USING ERRCODE = 'restrict_violation';
  END IF;
  IF NEW.id IS DISTINCT FROM OLD.id
    OR NEW.shop_id IS DISTINCT FROM OLD.shop_id
    OR NEW.created_by IS DISTINCT FROM OLD.created_by
    OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'shop customer %: its shop and origin are fixed', OLD.id
      USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER shop_customers_guard BEFORE UPDATE OR DELETE ON shop_customers
  FOR EACH ROW EXECUTE FUNCTION shop_customers_guard();
--> statement-breakpoint
CREATE TRIGGER shop_customers_truncate_guard BEFORE TRUNCATE ON shop_customers
  FOR EACH STATEMENT EXECUTE FUNCTION shop_customers_guard();
--> statement-breakpoint

-- The app role keeps SELECT and INSERT only on the append-only tables, and loses DELETE and
-- TRUNCATE on the shops, the return requests and the shop customers: revoked from PUBLIC and from
-- every role but the owner, whatever the app role is called.
REVOKE UPDATE, DELETE, TRUNCATE ON merchant_shop_slugs, merchant_shop_rates, shop_transfers, shop_settlements FROM PUBLIC;
--> statement-breakpoint
REVOKE DELETE, TRUNCATE ON merchant_shops, shop_return_requests, shop_customers FROM PUBLIC;
--> statement-breakpoint
DO $$
DECLARE
  target regclass;
  grantee text;
BEGIN
  FOREACH target IN ARRAY ARRAY['merchant_shop_slugs'::regclass, 'merchant_shop_rates'::regclass, 'shop_transfers'::regclass, 'shop_settlements'::regclass]
  LOOP
    FOR grantee IN
      SELECT DISTINCT acl.grantee::regrole::text
      FROM pg_class AS c, aclexplode(c.relacl) AS acl
      WHERE c.oid = target
        AND acl.grantee <> c.relowner
        AND acl.grantee <> 0
    LOOP
      EXECUTE format('REVOKE UPDATE, DELETE, TRUNCATE ON %s FROM %s', target, grantee);
    END LOOP;
  END LOOP;
  FOREACH target IN ARRAY ARRAY['merchant_shops'::regclass, 'shop_return_requests'::regclass, 'shop_customers'::regclass]
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
