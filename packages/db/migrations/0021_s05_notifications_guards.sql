-- Customer notifications (S05 F27, ADR 0014): what drizzle-kit cannot express. Hand-written;
-- never edit once applied.

-- A delivery record (rule NT1): never deleted, and only `read_at` changes, once, from empty to a
-- time (rule NT5). Whoever runs the change.
CREATE FUNCTION customer_notifications_guard() RETURNS trigger LANGUAGE plpgsql
SET search_path = public, pg_temp AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'customer notifications are never deleted' USING ERRCODE = 'restrict_violation';
  END IF;
  IF NEW.id IS DISTINCT FROM OLD.id
    OR NEW.customer_id IS DISTINCT FROM OLD.customer_id
    OR NEW.event IS DISTINCT FROM OLD.event
    OR NEW.params IS DISTINCT FROM OLD.params
    OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'customer notification % changes only its read time', OLD.id
      USING ERRCODE = 'restrict_violation';
  END IF;
  IF OLD.read_at IS NOT NULL AND NEW.read_at IS DISTINCT FROM OLD.read_at THEN
    RAISE EXCEPTION 'customer notification % is already read', OLD.id
      USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER customer_notifications_guard BEFORE UPDATE OR DELETE ON customer_notifications
  FOR EACH ROW EXECUTE FUNCTION customer_notifications_guard();
--> statement-breakpoint
CREATE TRIGGER customer_notifications_no_truncate BEFORE TRUNCATE ON customer_notifications
  FOR EACH STATEMENT EXECUTE FUNCTION append_only_guard();
--> statement-breakpoint

-- The app role keeps SELECT, INSERT and UPDATE of `read_at` only: the table-wide UPDATE, DELETE
-- and TRUNCATE are revoked from PUBLIC and from every role but the owner, whatever the app role
-- is called, and each of those roles gets the column grant back.
REVOKE UPDATE, DELETE, TRUNCATE ON customer_notifications FROM PUBLIC;
--> statement-breakpoint
DO $$
DECLARE
  grantee text;
BEGIN
  FOR grantee IN
    SELECT DISTINCT acl.grantee::regrole::text
    FROM pg_class AS c, aclexplode(c.relacl) AS acl
    WHERE c.oid = 'customer_notifications'::regclass
      AND acl.grantee <> c.relowner
      AND acl.grantee <> 0
  LOOP
    EXECUTE format('REVOKE UPDATE, DELETE, TRUNCATE ON customer_notifications FROM %s', grantee);
    EXECUTE format('GRANT UPDATE (read_at) ON customer_notifications TO %s', grantee);
  END LOOP;
END;
$$;
