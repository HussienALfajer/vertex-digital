-- Audit guards (ADR 0011, 0014, S01 rule A3) and the rest of the staff → admin rename (ADR 0016).
-- Hand-written; never edit once applied.

-- The audit log is append-only, whoever runs the change: the trigger of migration 0001.
CREATE TRIGGER audit_entries_append_only BEFORE UPDATE OR DELETE ON audit_entries
  FOR EACH ROW EXECUTE FUNCTION append_only_guard();
--> statement-breakpoint
CREATE TRIGGER audit_entries_no_truncate BEFORE TRUNCATE ON audit_entries
  FOR EACH STATEMENT EXECUTE FUNCTION append_only_guard();
--> statement-breakpoint

-- The app role keeps SELECT and INSERT only, as on the ledger: revoked from PUBLIC and from every
-- role but the owner, whatever the app role is called.
REVOKE UPDATE, DELETE, TRUNCATE ON audit_entries FROM PUBLIC;
--> statement-breakpoint
DO $$
DECLARE
  grantee text;
BEGIN
  FOR grantee IN
    SELECT DISTINCT acl.grantee::regrole::text
    FROM pg_class AS c, aclexplode(c.relacl) AS acl
    WHERE c.oid = 'audit_entries'::regclass
      AND acl.grantee <> c.relowner
      AND acl.grantee <> 0
  LOOP
    EXECUTE format('REVOKE UPDATE, DELETE, TRUNCATE ON audit_entries FROM %s', grantee);
  END LOOP;
END;
$$;
--> statement-breakpoint

-- Migration 0003 renamed the staff tables; their primary keys kept the old names.
ALTER INDEX staff_users_pkey RENAME TO admin_users_pkey;
--> statement-breakpoint
ALTER INDEX staff_sessions_pkey RENAME TO admin_sessions_pkey;
--> statement-breakpoint
ALTER INDEX staff_accounts_pkey RENAME TO admin_accounts_pkey;
--> statement-breakpoint
ALTER INDEX staff_verifications_pkey RENAME TO admin_verifications_pkey;
--> statement-breakpoint
ALTER INDEX staff_two_factors_pkey RENAME TO admin_two_factors_pkey;
