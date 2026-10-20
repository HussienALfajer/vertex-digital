-- Price list seeds (S20 data, ADR 0035): the three root lists with fixed ids (the contracts'
-- `ROOT_PRICE_LIST_IDS`), before the columns that default to the retail list reference it.
-- Hand-written; never edit once applied.
INSERT INTO price_lists (id, kind, name) VALUES
  ('01a15a8c-b310-7513-8c14-09e5262ac878', 'retail', 'التجزئة'),
  ('01a15a8c-b312-75f3-92d2-65b29d838051', 'wholesale', 'الجملة'),
  ('01a15a8c-b312-75f3-92d2-691f7e3bf413', 'cost', 'سعر التكلفة')
ON CONFLICT DO NOTHING;
