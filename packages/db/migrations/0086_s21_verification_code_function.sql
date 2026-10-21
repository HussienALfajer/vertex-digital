-- S21 VF1: an order's verification code, 22 base64url characters. PostgreSQL has no CSPRNG byte
-- function without pgcrypto, so the code is cut from two random UUIDs (`gen_random_uuid()` reads
-- the system's strong random source): its first 16 bytes carry 122 random bits, the 6 bits after
-- them a few more. The next migration uses it as the column's default, which backfills every
-- existing order and keeps the release before S21 PR 2 inserting orders as it does today.
CREATE OR REPLACE FUNCTION public.order_verification_code() RETURNS text
LANGUAGE sql VOLATILE PARALLEL SAFE
SET search_path = public, pg_temp AS $$
  SELECT translate(
    substr(encode(uuid_send(gen_random_uuid()) || uuid_send(gen_random_uuid()), 'base64'), 1, 22),
    '+/', '-_'
  );
$$;
