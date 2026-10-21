-- S22 DL1 (ADR 0037): a product's permanent direct-link code, 6 characters of the order-number
-- alphabet (31 characters, 31^6 = 887,503,681 codes). The next migration uses it as the column's
-- default, which backfills every existing product. A code is the next value of a sequence through
-- an affine permutation modulo 31^6 (the multiplier 3^18 is coprime with 31), so two products
-- never draw the same code, even in one statement, and consecutive products get unrelated codes.
-- The codes are public links, not secrets: nothing relies on them being unguessable.
CREATE SEQUENCE public.catalog_quick_code_seq AS bigint MINVALUE 0 MAXVALUE 887503680 START 0 NO CYCLE;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION public.catalog_quick_code() RETURNS text
LANGUAGE plpgsql VOLATILE
SET search_path = public, pg_temp AS $$
DECLARE
  alphabet constant text := '23456789ABCDEFGHJKMNPQRSTUVWXYZ';
  value bigint := (nextval('public.catalog_quick_code_seq') * 387420489 + 104729) % 887503681;
  code text := '';
BEGIN
  FOR position IN 1..6 LOOP
    code := substr(alphabet, (value % 31)::int + 1, 1) || code;
    value := value / 31;
  END LOOP;
  RETURN code;
END;
$$;
