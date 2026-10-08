-- Suppliers, stored prices and reviews (S07, F09): what drizzle-kit cannot express. Hand-written;
-- never edit once applied.

-- Append-only (S07 "Data"): credentials, cost changes, calls, health changes, balance reads, the
-- policy and the stored prices are new rows, the newest in force; the trigger of migration 0001
-- refuses UPDATE, DELETE and TRUNCATE whoever runs them.
CREATE TRIGGER supplier_credentials_append_only BEFORE UPDATE OR DELETE ON supplier_credentials
  FOR EACH ROW EXECUTE FUNCTION append_only_guard();
--> statement-breakpoint
CREATE TRIGGER supplier_credentials_no_truncate BEFORE TRUNCATE ON supplier_credentials
  FOR EACH STATEMENT EXECUTE FUNCTION append_only_guard();
--> statement-breakpoint
CREATE TRIGGER supplier_cost_changes_append_only BEFORE UPDATE OR DELETE ON supplier_cost_changes
  FOR EACH ROW EXECUTE FUNCTION append_only_guard();
--> statement-breakpoint
CREATE TRIGGER supplier_cost_changes_no_truncate BEFORE TRUNCATE ON supplier_cost_changes
  FOR EACH STATEMENT EXECUTE FUNCTION append_only_guard();
--> statement-breakpoint
CREATE TRIGGER supplier_calls_append_only BEFORE UPDATE OR DELETE ON supplier_calls
  FOR EACH ROW EXECUTE FUNCTION append_only_guard();
--> statement-breakpoint
CREATE TRIGGER supplier_calls_no_truncate BEFORE TRUNCATE ON supplier_calls
  FOR EACH STATEMENT EXECUTE FUNCTION append_only_guard();
--> statement-breakpoint
CREATE TRIGGER supplier_health_changes_append_only BEFORE UPDATE OR DELETE ON supplier_health_changes
  FOR EACH ROW EXECUTE FUNCTION append_only_guard();
--> statement-breakpoint
CREATE TRIGGER supplier_health_changes_no_truncate BEFORE TRUNCATE ON supplier_health_changes
  FOR EACH STATEMENT EXECUTE FUNCTION append_only_guard();
--> statement-breakpoint
CREATE TRIGGER supplier_balance_reads_append_only BEFORE UPDATE OR DELETE ON supplier_balance_reads
  FOR EACH ROW EXECUTE FUNCTION append_only_guard();
--> statement-breakpoint
CREATE TRIGGER supplier_balance_reads_no_truncate BEFORE TRUNCATE ON supplier_balance_reads
  FOR EACH STATEMENT EXECUTE FUNCTION append_only_guard();
--> statement-breakpoint
CREATE TRIGGER supplier_policy_append_only BEFORE UPDATE OR DELETE ON supplier_policy
  FOR EACH ROW EXECUTE FUNCTION append_only_guard();
--> statement-breakpoint
CREATE TRIGGER supplier_policy_no_truncate BEFORE TRUNCATE ON supplier_policy
  FOR EACH STATEMENT EXECUTE FUNCTION append_only_guard();
--> statement-breakpoint
CREATE TRIGGER product_prices_append_only BEFORE UPDATE OR DELETE ON product_prices
  FOR EACH ROW EXECUTE FUNCTION append_only_guard();
--> statement-breakpoint
CREATE TRIGGER product_prices_no_truncate BEFORE TRUNCATE ON product_prices
  FOR EACH STATEMENT EXECUTE FUNCTION append_only_guard();
--> statement-breakpoint

-- The app role keeps SELECT and INSERT only: revoked from PUBLIC and from every role but the
-- owner, whatever the app role is called.
REVOKE UPDATE, DELETE, TRUNCATE ON supplier_credentials, supplier_cost_changes, supplier_calls, supplier_health_changes, supplier_balance_reads, supplier_policy, product_prices FROM PUBLIC;
--> statement-breakpoint
DO $$
DECLARE
  target regclass;
  grantee text;
BEGIN
  FOREACH target IN ARRAY ARRAY['supplier_credentials'::regclass, 'supplier_cost_changes'::regclass, 'supplier_calls'::regclass, 'supplier_health_changes'::regclass, 'supplier_balance_reads'::regclass, 'supplier_policy'::regclass, 'product_prices'::regclass]
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
END;
$$;
--> statement-breakpoint

-- A sync run changes only while it runs, once, to its end (rule SY1); a decided review never
-- changes again (rule P4). Neither is ever deleted.
CREATE FUNCTION supplier_sync_runs_guard() RETURNS trigger LANGUAGE plpgsql
SET search_path = public, pg_temp AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'supplier_sync_runs rows are never deleted';
  END IF;
  IF OLD.status <> 'running' THEN
    RAISE EXCEPTION 'supplier_sync_runs: a finished run never changes';
  END IF;
  IF NEW.id <> OLD.id OR NEW.supplier_id <> OLD.supplier_id OR NEW.trigger <> OLD.trigger
    OR NEW.started_at <> OLD.started_at THEN
    RAISE EXCEPTION 'supplier_sync_runs: the supplier, trigger and start are fixed';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER supplier_sync_runs_guard BEFORE UPDATE OR DELETE ON supplier_sync_runs
  FOR EACH ROW EXECUTE FUNCTION supplier_sync_runs_guard();
--> statement-breakpoint
CREATE FUNCTION price_reviews_guard() RETURNS trigger LANGUAGE plpgsql
SET search_path = public, pg_temp AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'price_reviews rows are never deleted';
  END IF;
  IF OLD.status <> 'open' THEN
    RAISE EXCEPTION 'price_reviews: a decided review never changes';
  END IF;
  IF NEW.id <> OLD.id OR NEW.product_id <> OLD.product_id
    OR NEW.cost_before_usd_units <> OLD.cost_before_usd_units
    OR NEW.price_before_usd_units <> OLD.price_before_usd_units THEN
    RAISE EXCEPTION 'price_reviews: the product and the price held are fixed';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER price_reviews_guard BEFORE UPDATE OR DELETE ON price_reviews
  FOR EACH ROW EXECUTE FUNCTION price_reviews_guard();
--> statement-breakpoint

-- The four suppliers (S07 "Data"), fixed ids so every database holds the same rows. Their names
-- are what the panel shows; base URLs live in the adapters (ADR 0021).
INSERT INTO suppliers (id, code, name_ar) VALUES
  ('01a11d3c-890a-76cc-a8bc-6b90091bfc01', 'shop2topup', 'SHOP2TOPUP'),
  ('01a11d3c-890b-70e7-8e09-9b5e1fa47e26', 'wdgzone', 'WDGZone'),
  ('01a11d3c-890c-77e7-af29-3e992e2bc8d0', 'manual', 'يدوي'),
  ('01a11d3c-890c-77e7-af29-41b711a8e367', 'fake', 'مورد تجريبي')
ON CONFLICT DO NOTHING;
--> statement-breakpoint

-- The policy's defaults (ADR 0021, owner, 2026-10-08): review above 10%, costs stale after 2
-- hours, health over 30 minutes from 5 calls, degraded below 90% or above a 10 s p90, down below
-- 50% or after 3 consecutive errors, a probe after 10 minutes down.
INSERT INTO supplier_policy (id, price_review_threshold_bp, cost_stale_minutes,
  health_window_minutes, health_min_calls, degraded_success_bp, degraded_p90_ms, down_success_bp,
  down_consecutive_errors, probe_after_minutes, admin_id)
VALUES ('01a11d3c-890c-77e7-af29-451969625ce3', 1000, 120, 30, 5, 9000, 10000, 5000, 3, 10, NULL)
ON CONFLICT DO NOTHING;
