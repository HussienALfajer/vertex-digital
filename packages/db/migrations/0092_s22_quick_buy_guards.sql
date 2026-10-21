-- S22 PR 1 (ADR 0037): the quick-buy guards.

-- quick_link_events (DL2, DL4): never changed; only rows older than 90 days are deleted, by the
-- sweep.
CREATE FUNCTION quick_link_events_guard() RETURNS trigger LANGUAGE plpgsql
SET search_path = public, pg_temp AS $$
BEGIN
  IF TG_OP = 'UPDATE' THEN
    RAISE EXCEPTION 'quick link events are never changed' USING ERRCODE = 'restrict_violation';
  END IF;
  IF TG_OP = 'DELETE' THEN
    IF OLD.created_at >= now() - interval '90 days' THEN
      RAISE EXCEPTION 'quick link event %: kept 90 days', OLD.id
        USING ERRCODE = 'restrict_violation';
    END IF;
    RETURN OLD;
  END IF;
  RAISE EXCEPTION 'quick link events are never truncated' USING ERRCODE = 'restrict_violation';
END;
$$;
--> statement-breakpoint
CREATE TRIGGER quick_link_events_guard BEFORE UPDATE OR DELETE ON quick_link_events
  FOR EACH ROW EXECUTE FUNCTION quick_link_events_guard();
--> statement-breakpoint
CREATE TRIGGER quick_link_events_truncate_guard BEFORE TRUNCATE ON quick_link_events
  FOR EACH STATEMENT EXECUTE FUNCTION quick_link_events_guard();
--> statement-breakpoint

-- catalog_products.quick_code (DL1): a printed link never changes, archived products included.
CREATE FUNCTION catalog_products_quick_code_guard() RETURNS trigger LANGUAGE plpgsql
SET search_path = public, pg_temp AS $$
BEGIN
  IF NEW.quick_code IS DISTINCT FROM OLD.quick_code THEN
    RAISE EXCEPTION 'product %: the quick code never changes', OLD.id
      USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER catalog_products_quick_code_guard BEFORE UPDATE OF quick_code ON catalog_products
  FOR EACH ROW EXECUTE FUNCTION catalog_products_quick_code_guard();
