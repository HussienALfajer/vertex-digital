-- S23 PR 1 (F43, ADR 0038): the merchant tiers' data migration, seeds, guards and grants.
-- Hand-written; never edit once applied.

-- `merchant_levels` (data): every live S21 level is archived (production has none on 2026-10-29;
-- the setup command creates the tier levels), then a live level must carry a tier above Bronze.
-- The merchants' recomputation (the setup command's requeue) moves their profiles off them.
UPDATE merchant_levels SET archived_at = now() WHERE archived_at IS NULL;
--> statement-breakpoint
ALTER TABLE merchant_levels ADD CONSTRAINT merchant_levels_tier_check
  CHECK (tier <> 'bronze' AND (tier IS NOT NULL OR archived_at IS NOT NULL));
--> statement-breakpoint

-- TS2: the seeded privileges per tier, fixed ids. Bronze's deposit limits and player checks are the
-- newest merchant settings' (S20 MD1, S21 BK4), so nothing changes for today's merchants.
INSERT INTO merchant_tier_settings (id, tier, per_deposit_usd_units, daily_deposit_usd_units,
  player_checks_per_hour, player_checks_per_day, bulk_lines_max, order_units_max, deposit_priority,
  support_priority, support_reply_minutes, direct_contact, early_access, fast_alerts,
  receipt_welcome, receipt_large_logo, admin_id)
SELECT '01a3b2c4-5d6e-7f80-9a1b-2c3d4e5f6a01', 'bronze', per_deposit_usd_units,
  daily_deposit_usd_units, player_checks_per_hour, player_checks_per_day, 50, 50, false, false,
  NULL, false, false, false, false, false, NULL
FROM (
  SELECT * FROM merchant_settings ORDER BY created_at DESC, id DESC LIMIT 1
) AS newest
ON CONFLICT DO NOTHING;
--> statement-breakpoint
INSERT INTO merchant_tier_settings (id, tier, per_deposit_usd_units, daily_deposit_usd_units,
  player_checks_per_hour, player_checks_per_day, bulk_lines_max, order_units_max, deposit_priority,
  support_priority, support_reply_minutes, direct_contact, early_access, fast_alerts,
  receipt_welcome, receipt_large_logo, admin_id)
VALUES
  ('01a3b2c4-5d6e-7f80-9a1b-2c3d4e5f6a02', 'silver', 3000000000, 8000000000, 150, 500, 50, 50,
    false, false, NULL, false, false, false, true, false, NULL),
  ('01a3b2c4-5d6e-7f80-9a1b-2c3d4e5f6a03', 'gold', 5000000000, 15000000000, 250, 800, 100, 100,
    true, true, 180, false, true, true, true, true, NULL),
  ('01a3b2c4-5d6e-7f80-9a1b-2c3d4e5f6a04', 'diamond', 10000000000, 30000000000, 400, 1500, 100, 100,
    true, true, 60, true, true, true, true, true, NULL)
ON CONFLICT DO NOTHING;
--> statement-breakpoint

-- Append-only: the tier settings' versions, the tier changes and the months are new rows; the
-- trigger of migration 0001 refuses UPDATE, DELETE and TRUNCATE whoever runs them.
CREATE TRIGGER merchant_tier_settings_append_only BEFORE UPDATE OR DELETE ON merchant_tier_settings
  FOR EACH ROW EXECUTE FUNCTION append_only_guard();
--> statement-breakpoint
CREATE TRIGGER merchant_tier_settings_no_truncate BEFORE TRUNCATE ON merchant_tier_settings
  FOR EACH STATEMENT EXECUTE FUNCTION append_only_guard();
--> statement-breakpoint
CREATE TRIGGER merchant_tier_changes_append_only BEFORE UPDATE OR DELETE ON merchant_tier_changes
  FOR EACH ROW EXECUTE FUNCTION append_only_guard();
--> statement-breakpoint
CREATE TRIGGER merchant_tier_changes_no_truncate BEFORE TRUNCATE ON merchant_tier_changes
  FOR EACH STATEMENT EXECUTE FUNCTION append_only_guard();
--> statement-breakpoint
CREATE TRIGGER merchant_tier_months_append_only BEFORE UPDATE OR DELETE ON merchant_tier_months
  FOR EACH ROW EXECUTE FUNCTION append_only_guard();
--> statement-breakpoint
CREATE TRIGGER merchant_tier_months_no_truncate BEFORE TRUNCATE ON merchant_tier_months
  FOR EACH STATEMENT EXECUTE FUNCTION append_only_guard();
--> statement-breakpoint

-- MG1–MG7: a grant is never deleted; its customer, tier, start, end, reason and admin are fixed;
-- it is ended once (`ended_at` and `end_reason` together, never changed after).
CREATE FUNCTION merchant_tier_grants_guard() RETURNS trigger LANGUAGE plpgsql
SET search_path = public, pg_temp AS $$
BEGIN
  IF TG_OP = 'DELETE' OR TG_OP = 'TRUNCATE' THEN
    RAISE EXCEPTION 'merchant tier grants are never deleted' USING ERRCODE = 'restrict_violation';
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW.ended_at IS NOT NULL THEN
      RAISE EXCEPTION 'a merchant tier grant starts open' USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
  END IF;
  IF NEW.id IS DISTINCT FROM OLD.id
    OR NEW.customer_id IS DISTINCT FROM OLD.customer_id
    OR NEW.tier IS DISTINCT FROM OLD.tier
    OR NEW.starts_at IS DISTINCT FROM OLD.starts_at
    OR NEW.ends_at IS DISTINCT FROM OLD.ends_at
    OR NEW.reason IS DISTINCT FROM OLD.reason
    OR NEW.admin_id IS DISTINCT FROM OLD.admin_id
    OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'merchant tier grant %: only its end changes', OLD.id
      USING ERRCODE = 'restrict_violation';
  END IF;
  IF OLD.ended_at IS NOT NULL AND (NEW.ended_at IS DISTINCT FROM OLD.ended_at
    OR NEW.end_reason IS DISTINCT FROM OLD.end_reason) THEN
    RAISE EXCEPTION 'merchant tier grant %: ended already', OLD.id
      USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER merchant_tier_grants_guard BEFORE INSERT OR UPDATE OR DELETE ON merchant_tier_grants
  FOR EACH ROW EXECUTE FUNCTION merchant_tier_grants_guard();
--> statement-breakpoint
CREATE TRIGGER merchant_tier_grants_truncate_guard BEFORE TRUNCATE ON merchant_tier_grants
  FOR EACH STATEMENT EXECUTE FUNCTION merchant_tier_grants_guard();
--> statement-breakpoint

-- The app role keeps SELECT and INSERT only on the append-only tables, and loses DELETE and
-- TRUNCATE on the grants: revoked from PUBLIC and from every role but the owner, whatever the app
-- role is called.
REVOKE UPDATE, DELETE, TRUNCATE ON merchant_tier_settings, merchant_tier_changes, merchant_tier_months FROM PUBLIC;
--> statement-breakpoint
REVOKE DELETE, TRUNCATE ON merchant_tier_grants FROM PUBLIC;
--> statement-breakpoint
DO $$
DECLARE
  target regclass;
  grantee text;
BEGIN
  FOREACH target IN ARRAY ARRAY['merchant_tier_settings'::regclass, 'merchant_tier_changes'::regclass, 'merchant_tier_months'::regclass]
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
  FOR grantee IN
    SELECT DISTINCT acl.grantee::regrole::text
    FROM pg_class AS c, aclexplode(c.relacl) AS acl
    WHERE c.oid = 'merchant_tier_grants'::regclass
      AND acl.grantee <> c.relowner
      AND acl.grantee <> 0
  LOOP
    EXECUTE format('REVOKE DELETE, TRUNCATE ON %s FROM %s', 'merchant_tier_grants', grantee);
  END LOOP;
END;
$$;
