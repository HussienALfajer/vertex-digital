-- Ledger guards (ADR 0003, ADR 0011, ADR 0014): what drizzle-kit cannot express. Hand-written;
-- never edit once applied. Functions that read tables name them with their schema and pin
-- search_path, so a session's temporary table cannot stand in for a ledger table.

-- Append-only tables refuse UPDATE, DELETE and TRUNCATE, whoever runs them: corrections are new
-- reversing journals. Reused by every append-only table (audit, order events).
CREATE FUNCTION append_only_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION '% is append-only: % is not allowed', TG_TABLE_NAME, TG_OP;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER ledger_journals_append_only BEFORE UPDATE OR DELETE ON ledger_journals
  FOR EACH ROW EXECUTE FUNCTION append_only_guard();
--> statement-breakpoint
CREATE TRIGGER ledger_journals_no_truncate BEFORE TRUNCATE ON ledger_journals
  FOR EACH STATEMENT EXECUTE FUNCTION append_only_guard();
--> statement-breakpoint
CREATE TRIGGER ledger_postings_append_only BEFORE UPDATE OR DELETE ON ledger_postings
  FOR EACH ROW EXECUTE FUNCTION append_only_guard();
--> statement-breakpoint
CREATE TRIGGER ledger_postings_no_truncate BEFORE TRUNCATE ON ledger_postings
  FOR EACH STATEMENT EXECUTE FUNCTION append_only_guard();
--> statement-breakpoint

-- The app role received SELECT, INSERT, UPDATE, DELETE on these tables from the owner's default
-- privileges (ADR 0014). On journals and postings it keeps only SELECT and INSERT; accounts are
-- archived, never deleted. Revoked from PUBLIC and from every role but the owner, whatever the app
-- role is called. The owner keeps its privileges: foreign key checks lock the referenced rows as
-- the owner, which needs UPDATE; the trigger above still refuses the owner's changes.
REVOKE UPDATE, DELETE, TRUNCATE ON ledger_journals, ledger_postings FROM PUBLIC;
--> statement-breakpoint
REVOKE DELETE, TRUNCATE ON ledger_accounts FROM PUBLIC;
--> statement-breakpoint
DO $$
DECLARE
  grantee text;
BEGIN
  FOR grantee IN
    SELECT DISTINCT acl.grantee::regrole::text
    FROM pg_class AS c, aclexplode(c.relacl) AS acl
    WHERE c.oid IN ('ledger_accounts'::regclass, 'ledger_journals'::regclass, 'ledger_postings'::regclass)
      AND acl.grantee <> c.relowner
      AND acl.grantee <> 0
  LOOP
    EXECUTE format('REVOKE UPDATE, DELETE, TRUNCATE ON ledger_journals, ledger_postings FROM %s', grantee);
    EXECUTE format('REVOKE DELETE, TRUNCATE ON ledger_accounts FROM %s', grantee);
  END LOOP;
END;
$$;
--> statement-breakpoint

-- A journal's time is the database's: an insert cannot backdate it.
CREATE FUNCTION ledger_journals_stamp() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  NEW.created_at := now();
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER ledger_journals_stamp BEFORE INSERT ON ledger_journals
  FOR EACH ROW EXECUTE FUNCTION ledger_journals_stamp();
--> statement-breakpoint

-- Every journal has exactly the number of postings it declares (two or more, by a check) and sums
-- to zero in each currency. Checked at commit (deferred), once the journal and its postings are
-- written. The declared count also refuses postings added to a journal later, even balanced ones.
CREATE FUNCTION ledger_check_journal() RETURNS trigger LANGUAGE plpgsql
SET search_path = public, pg_temp AS $$
DECLARE
  target uuid;
  declared integer;
  actual integer;
BEGIN
  IF TG_TABLE_NAME = 'ledger_journals' THEN
    target := NEW.id;
  ELSE
    target := NEW.journal_id;
  END IF;
  SELECT posting_count INTO declared FROM public.ledger_journals WHERE id = target;
  SELECT count(*) INTO actual FROM public.ledger_postings WHERE journal_id = target;
  IF actual <> declared THEN
    RAISE EXCEPTION 'Journal % has % postings but declares %', target, actual, declared
      USING ERRCODE = 'check_violation';
  END IF;
  IF EXISTS (
    SELECT FROM public.ledger_postings WHERE journal_id = target
    GROUP BY currency HAVING sum(amount_units) <> 0
  ) THEN
    RAISE EXCEPTION 'Journal % does not balance in every currency', target
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NULL;
END;
$$;
--> statement-breakpoint
CREATE CONSTRAINT TRIGGER ledger_journals_balanced AFTER INSERT ON ledger_journals
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION ledger_check_journal();
--> statement-breakpoint
CREATE CONSTRAINT TRIGGER ledger_postings_balanced AFTER INSERT ON ledger_postings
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION ledger_check_journal();
--> statement-breakpoint

-- An account's identity never changes once created: its postings were written for that kind and
-- currency, and its code is how the system finds it. Archiving stays possible.
CREATE FUNCTION ledger_accounts_keep_identity() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.id <> OLD.id OR NEW.code <> OLD.code OR NEW.kind <> OLD.kind
    OR NEW.currency <> OLD.currency THEN
    RAISE EXCEPTION 'The id, code, kind and currency of ledger account % never change', OLD.id;
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER ledger_accounts_keep_identity BEFORE UPDATE ON ledger_accounts
  FOR EACH ROW EXECUTE FUNCTION ledger_accounts_keep_identity();
