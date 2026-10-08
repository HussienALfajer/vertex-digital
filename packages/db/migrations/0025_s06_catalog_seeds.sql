-- Catalog and pricing seeds (S06): what drizzle-kit cannot express. Hand-written; never edit once
-- applied. Fixed UUIDv7 ids, so every database holds the same rows.

-- The three categories (S06 data, `catalog_categories`); the admin renames, adds and orders them.
INSERT INTO catalog_categories (id, slug, name_ar, sort_order) VALUES
  ('01a11cc9-31b8-7425-997b-57bd8f0631b2', 'games', 'ألعاب', 1),
  ('01a11cc9-31ba-7318-934b-28d285e4230e', 'apps', 'تطبيقات', 2),
  ('01a11cc9-31ba-7318-934b-2dc263d34cc6', 'gift-cards', 'بطاقات هدايا', 3)
ON CONFLICT DO NOTHING;
--> statement-breakpoint

-- The global margin rule (Q7, owner, 2026-10-08; ADR 0020): 10%, $0 fixed, $0.10 minimum. It
-- always exists and is never archived (rule PR2).
INSERT INTO margin_rules (id, scope, target_id, percent_bp, fixed_usd_units, min_margin_usd_units)
VALUES ('01a11cc9-31ba-7318-934b-314f9387d86e', 'global', NULL, 1000, 0, 100000)
ON CONFLICT DO NOTHING;
