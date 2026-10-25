-- S22 OP5: a ticket's order problem is named at opening and never changes, like the rest of what
-- the ticket is about (migration 0043's guard, with `order_problem` added).
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
    OR NEW.order_problem IS DISTINCT FROM OLD.order_problem
    OR NEW.opened_by IS DISTINCT FROM OLD.opened_by
    OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'support ticket %: what it is about is fixed', OLD.id
      USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END;
$$;
