-- Customers administration and support (S12; ADR 0011, 0014): what drizzle-kit cannot express.
-- Hand-written; never edit once applied.

-- A ticket's conversation is a record (TK7, TK11): messages and attachments are append-only.
CREATE TRIGGER support_messages_append_only BEFORE UPDATE OR DELETE ON support_messages
  FOR EACH ROW EXECUTE FUNCTION append_only_guard();
--> statement-breakpoint
CREATE TRIGGER support_messages_no_truncate BEFORE TRUNCATE ON support_messages
  FOR EACH STATEMENT EXECUTE FUNCTION append_only_guard();
--> statement-breakpoint
CREATE TRIGGER support_attachments_append_only BEFORE UPDATE OR DELETE ON support_attachments
  FOR EACH ROW EXECUTE FUNCTION append_only_guard();
--> statement-breakpoint
CREATE TRIGGER support_attachments_no_truncate BEFORE TRUNCATE ON support_attachments
  FOR EACH STATEMENT EXECUTE FUNCTION append_only_guard();
--> statement-breakpoint

-- A note's body and customer never change; only `pinned` and `archived_at` do (SN2). Notes are
-- archived, never deleted.
CREATE OR REPLACE FUNCTION customer_notes_guard() RETURNS trigger LANGUAGE plpgsql
SET search_path = public, pg_temp AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'customer notes are archived, never deleted' USING ERRCODE = 'restrict_violation';
  END IF;
  IF NEW.id IS DISTINCT FROM OLD.id
    OR NEW.customer_id IS DISTINCT FROM OLD.customer_id
    OR NEW.body IS DISTINCT FROM OLD.body
    OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'customer note %: its customer and body are fixed', OLD.id
      USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER customer_notes_guard BEFORE UPDATE OR DELETE ON customer_notes
  FOR EACH ROW EXECUTE FUNCTION customer_notes_guard();
--> statement-breakpoint
CREATE TRIGGER customer_notes_no_truncate BEFORE TRUNCATE ON customer_notes
  FOR EACH STATEMENT EXECUTE FUNCTION append_only_guard();
--> statement-breakpoint

-- A ticket is closed, never deleted; what it is about and who opened it never change (TK1, TK2).
CREATE OR REPLACE FUNCTION support_tickets_guard() RETURNS trigger LANGUAGE plpgsql
SET search_path = public, pg_temp AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'support tickets are never deleted' USING ERRCODE = 'restrict_violation';
  END IF;
  IF NEW.id IS DISTINCT FROM OLD.id
    OR NEW.number IS DISTINCT FROM OLD.number
    OR NEW.customer_id IS DISTINCT FROM OLD.customer_id
    OR NEW.category IS DISTINCT FROM OLD.category
    OR NEW.order_id IS DISTINCT FROM OLD.order_id
    OR NEW.deposit_id IS DISTINCT FROM OLD.deposit_id
    OR NEW.subject IS DISTINCT FROM OLD.subject
    OR NEW.opened_by IS DISTINCT FROM OLD.opened_by
    OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'support ticket %: what it is about is fixed', OLD.id
      USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER support_tickets_guard BEFORE UPDATE OR DELETE ON support_tickets
  FOR EACH ROW EXECUTE FUNCTION support_tickets_guard();
--> statement-breakpoint
CREATE TRIGGER support_tickets_no_truncate BEFORE TRUNCATE ON support_tickets
  FOR EACH STATEMENT EXECUTE FUNCTION append_only_guard();
--> statement-breakpoint

-- The app role keeps SELECT and INSERT only on the append-only tables, and loses DELETE and
-- TRUNCATE on notes, tickets and the settings row: revoked from PUBLIC and from every role but the
-- owner, whatever the app role is called. Sign-ins and limits keep DELETE (the 90-day purge).
REVOKE UPDATE, DELETE, TRUNCATE ON support_messages, support_attachments FROM PUBLIC;
--> statement-breakpoint
REVOKE DELETE, TRUNCATE ON customer_notes, support_tickets, support_settings FROM PUBLIC;
--> statement-breakpoint
DO $$
DECLARE
  target regclass;
  grantee text;
BEGIN
  FOREACH target IN ARRAY ARRAY['support_messages'::regclass, 'support_attachments'::regclass]
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
  FOREACH target IN ARRAY ARRAY['customer_notes'::regclass, 'support_tickets'::regclass, 'support_settings'::regclass]
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
--> statement-breakpoint

-- The support settings' one row, empty until the admin sets the Telegram link (SC1).
INSERT INTO support_settings (id, telegram_url) VALUES (1, NULL) ON CONFLICT (id) DO NOTHING;
