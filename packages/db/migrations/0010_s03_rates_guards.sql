-- Exchange rates and payment references (S03, ADR 0003, 0014): what drizzle-kit cannot express.
-- Hand-written; never edit once applied.

-- Both tables are append-only, whoever runs the change: the trigger of migration 0001.
CREATE TRIGGER exchange_rates_append_only BEFORE UPDATE OR DELETE ON exchange_rates
  FOR EACH ROW EXECUTE FUNCTION append_only_guard();
--> statement-breakpoint
CREATE TRIGGER exchange_rates_no_truncate BEFORE TRUNCATE ON exchange_rates
  FOR EACH STATEMENT EXECUTE FUNCTION append_only_guard();
--> statement-breakpoint
CREATE TRIGGER payment_references_append_only BEFORE UPDATE OR DELETE ON payment_references
  FOR EACH ROW EXECUTE FUNCTION append_only_guard();
--> statement-breakpoint
CREATE TRIGGER payment_references_no_truncate BEFORE TRUNCATE ON payment_references
  FOR EACH STATEMENT EXECUTE FUNCTION append_only_guard();
--> statement-breakpoint

-- The app role keeps SELECT and INSERT only, as on the ledger: revoked from PUBLIC and from every
-- role but the owner, whatever the app role is called.
REVOKE UPDATE, DELETE, TRUNCATE ON exchange_rates, payment_references FROM PUBLIC;
--> statement-breakpoint
DO $$
DECLARE
  target text;
  grantee text;
BEGIN
  FOREACH target IN ARRAY ARRAY['exchange_rates', 'payment_references'] LOOP
    FOR grantee IN
      SELECT DISTINCT acl.grantee::regrole::text
      FROM pg_class AS c, aclexplode(c.relacl) AS acl
      WHERE c.oid = target::regclass
        AND acl.grantee <> c.relowner
        AND acl.grantee <> 0
    LOOP
      EXECUTE format('REVOKE UPDATE, DELETE, TRUNCATE ON %I FROM %s', target, grantee);
    END LOOP;
  END LOOP;
END;
$$;
--> statement-breakpoint

-- S02 manual deposits claim their references (rule SC14). A claim takes its adjustment's id, a
-- UUIDv7 already. Reversals carry no reference; an adjustment that already holds a claim keeps it. S02's unique index compares upper-cased values
-- only, so two references differing by surrounding spaces keep the first claim.
INSERT INTO payment_references (id, method, reference, wallet_adjustment_id, created_at)
SELECT a.id, a.deposit_method::text::payment_method, upper(btrim(a.external_reference)), a.id,
  a.created_at
FROM wallet_adjustments AS a
WHERE a.external_reference IS NOT NULL
  AND NOT EXISTS (SELECT 1 FROM payment_references AS p WHERE p.wallet_adjustment_id = a.id)
ORDER BY a.created_at, a.id
ON CONFLICT (method, reference) DO NOTHING;
