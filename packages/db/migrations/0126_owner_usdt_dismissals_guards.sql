-- Owner request 2026-11-16: what drizzle-kit cannot express. Hand-written; never edit once applied.
--
-- `usdt_transfer_dismissals` is append-only, whoever runs the change: the trigger of migration
-- 0001. The app role keeps SELECT and INSERT, as on `usdt_transfers` (migration 0014).

CREATE TRIGGER usdt_transfer_dismissals_append_only BEFORE UPDATE OR DELETE
  ON usdt_transfer_dismissals FOR EACH ROW EXECUTE FUNCTION append_only_guard();
--> statement-breakpoint
CREATE TRIGGER usdt_transfer_dismissals_no_truncate BEFORE TRUNCATE ON usdt_transfer_dismissals
  FOR EACH STATEMENT EXECUTE FUNCTION append_only_guard();
--> statement-breakpoint
REVOKE UPDATE, DELETE, TRUNCATE ON usdt_transfer_dismissals FROM PUBLIC;
--> statement-breakpoint
DO $$
DECLARE
  grantee text;
BEGIN
  FOR grantee IN
    SELECT DISTINCT acl.grantee::regrole::text
    FROM pg_class AS c, aclexplode(c.relacl) AS acl
    WHERE c.oid = 'usdt_transfer_dismissals'::regclass
      AND acl.grantee <> c.relowner
      AND acl.grantee <> 0
  LOOP
    EXECUTE format('REVOKE UPDATE, DELETE, TRUNCATE ON usdt_transfer_dismissals FROM %s', grantee);
  END LOOP;
END;
$$;
