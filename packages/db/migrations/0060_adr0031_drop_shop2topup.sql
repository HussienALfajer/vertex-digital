-- ADR 0031: SHOP2TOPUP is dropped. Hand-written; never edit once applied.
-- Its supplier row goes only when nothing names it: a row of any table with a foreign key to
-- `suppliers`, a change of its pause switch, its ledger account (created by a first posting), or
-- an audit entry. Ledger and audit rows are never deleted, so any of them stops the migration (and
-- the deploy) for the owner to decide. The enum values `shop2topup` and `shop2topup_paused` stay
-- until the next release (expand, then contract): the previous release still sends them.
DO $$
DECLARE
  supplier uuid;
  ref record;
  found bigint;
BEGIN
  SELECT id INTO supplier FROM public.suppliers WHERE code = 'shop2topup';
  IF supplier IS NULL THEN
    RETURN;
  END IF;

  FOR ref IN
    SELECT con.conrelid::regclass AS tbl, a.attname AS col
    FROM pg_constraint AS con
    JOIN pg_attribute AS a ON a.attrelid = con.conrelid AND a.attnum = ANY (con.conkey)
    WHERE con.contype = 'f' AND con.confrelid = 'public.suppliers'::regclass
  LOOP
    EXECUTE format('SELECT count(*) FROM %s WHERE %I = $1', ref.tbl, ref.col) INTO found USING supplier;
    IF found > 0 THEN
      RAISE EXCEPTION 'SHOP2TOPUP is still referenced: % rows of %.%', found, ref.tbl, ref.col;
    END IF;
  END LOOP;

  SELECT count(*) INTO found FROM public.store_switch_changes WHERE switch = 'shop2topup_paused';
  IF found > 0 THEN
    RAISE EXCEPTION 'SHOP2TOPUP is still referenced: % changes of its pause switch', found;
  END IF;

  SELECT count(*) INTO found FROM public.ledger_accounts WHERE code = 'supplier_prepaid:shop2topup';
  IF found > 0 THEN
    RAISE EXCEPTION 'SHOP2TOPUP is still referenced: its ledger account has postings';
  END IF;

  SELECT count(*) INTO found FROM public.audit_entries
  WHERE entity_id = supplier OR details::text LIKE '%shop2topup%';
  IF found > 0 THEN
    RAISE EXCEPTION 'SHOP2TOPUP is still referenced: % audit entries', found;
  END IF;

  DELETE FROM public.suppliers WHERE id = supplier;
END;
$$;
