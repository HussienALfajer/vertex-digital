-- Store switches (S05 F26, ADR 0014): what drizzle-kit cannot express. Hand-written; never edit
-- once applied.

-- A change is a new row, the newest is the value (rule SW1): append-only, whoever runs the change,
-- with the trigger of migration 0001.
CREATE TRIGGER store_switch_changes_append_only BEFORE UPDATE OR DELETE ON store_switch_changes
  FOR EACH ROW EXECUTE FUNCTION append_only_guard();
--> statement-breakpoint
CREATE TRIGGER store_switch_changes_no_truncate BEFORE TRUNCATE ON store_switch_changes
  FOR EACH STATEMENT EXECUTE FUNCTION append_only_guard();
--> statement-breakpoint

-- The app role keeps SELECT and INSERT only: revoked from PUBLIC and from every role but the
-- owner, whatever the app role is called.
REVOKE UPDATE, DELETE, TRUNCATE ON store_switch_changes FROM PUBLIC;
--> statement-breakpoint
DO $$
DECLARE
  grantee text;
BEGIN
  FOR grantee IN
    SELECT DISTINCT acl.grantee::regrole::text
    FROM pg_class AS c, aclexplode(c.relacl) AS acl
    WHERE c.oid = 'store_switch_changes'::regclass
      AND acl.grantee <> c.relowner
      AND acl.grantee <> 0
  LOOP
    EXECUTE format('REVOKE UPDATE, DELETE, TRUNCATE ON store_switch_changes FROM %s', grantee);
  END LOOP;
END;
$$;
