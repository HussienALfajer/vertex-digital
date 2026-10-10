-- S11 (F17): an attempt's kind and the admin's choice are fixed from insert. A manual-supplier
-- attempt's unit cost, proof and reference are set by the admin's manual fulfil while it is open
-- (rule MF5): the cost and the reference change only in the update that sets the proof from empty,
-- so each is taken once. Everything else of migration 0031's guard stands: no delete, a delivered
-- or failed attempt never changes.
CREATE OR REPLACE FUNCTION fulfilment_attempts_guard() RETURNS trigger LANGUAGE plpgsql
SET search_path = public, pg_temp AS $$
DECLARE
  manual boolean;
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'fulfilment attempts are never deleted' USING ERRCODE = 'restrict_violation';
  END IF;
  IF OLD.status IN ('delivered', 'failed') THEN
    RAISE EXCEPTION 'attempt % is % and never changes', OLD.id, OLD.status
      USING ERRCODE = 'restrict_violation';
  END IF;
  IF NEW.id IS DISTINCT FROM OLD.id
    OR NEW.order_id IS DISTINCT FROM OLD.order_id
    OR NEW.kind IS DISTINCT FROM OLD.kind
    OR NEW.route_id IS DISTINCT FROM OLD.route_id
    OR NEW.supplier_id IS DISTINCT FROM OLD.supplier_id
    OR NEW.offer_id IS DISTINCT FROM OLD.offer_id
    OR NEW.supplier_offer_id IS DISTINCT FROM OLD.supplier_offer_id
    OR NEW.quantity IS DISTINCT FROM OLD.quantity
    OR NEW.candidates IS DISTINCT FROM OLD.candidates
    OR NEW.chosen_by_admin IS DISTINCT FROM OLD.chosen_by_admin
    OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'attempt %: its supplier, offer, units and candidates are fixed', OLD.id
      USING ERRCODE = 'restrict_violation';
  END IF;
  IF (NEW.proof_file_id IS DISTINCT FROM OLD.proof_file_id AND OLD.proof_file_id IS NOT NULL)
    OR (NEW.delivery_reference IS DISTINCT FROM OLD.delivery_reference
      AND OLD.delivery_reference IS NOT NULL) THEN
    RAISE EXCEPTION 'attempt %: its proof and reference are set once', OLD.id
      USING ERRCODE = 'restrict_violation';
  END IF;
  -- The cost and the reference change only with the proof, in the fulfil's one update (MF5).
  IF (NEW.unit_cost_usd_units IS DISTINCT FROM OLD.unit_cost_usd_units
      OR NEW.delivery_reference IS DISTINCT FROM OLD.delivery_reference)
    AND NOT (OLD.proof_file_id IS NULL AND NEW.proof_file_id IS NOT NULL) THEN
    RAISE EXCEPTION 'attempt %: its cost changes only once, with its delivery proof', OLD.id
      USING ERRCODE = 'restrict_violation';
  END IF;
  IF NEW.unit_cost_usd_units IS DISTINCT FROM OLD.unit_cost_usd_units
    OR NEW.proof_file_id IS DISTINCT FROM OLD.proof_file_id
    OR NEW.delivery_reference IS DISTINCT FROM OLD.delivery_reference THEN
    SELECT code = 'manual' INTO manual FROM public.suppliers WHERE id = OLD.supplier_id;
    IF NOT coalesce(manual, false) THEN
      RAISE EXCEPTION 'attempt %: only a manual attempt takes a cost and a proof from the admin',
        OLD.id USING ERRCODE = 'restrict_violation';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;
