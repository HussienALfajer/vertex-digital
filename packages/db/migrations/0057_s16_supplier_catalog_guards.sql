-- S16 PR 2: the supplier category mirror is never deleted. A category the supplier stops listing
-- gets `missing_since` (rule SC2), and its link or ignore state is kept (edge case 12). The app
-- role loses DELETE and TRUNCATE on it: revoked from PUBLIC and from every role but the owner,
-- whatever the app role is called.
REVOKE DELETE, TRUNCATE ON supplier_categories FROM PUBLIC;
--> statement-breakpoint
DO $$
DECLARE
  grantee text;
BEGIN
  FOR grantee IN
    SELECT DISTINCT acl.grantee::regrole::text
    FROM pg_class AS c, aclexplode(c.relacl) AS acl
    WHERE c.oid = 'supplier_categories'::regclass
      AND acl.grantee <> c.relowner
      AND acl.grantee <> 0
  LOOP
    EXECUTE format('REVOKE DELETE, TRUNCATE ON supplier_categories FROM %s', grantee);
  END LOOP;
END;
$$;
