-- Q25: an offer whose cost was last written by a sync (or never changed) starts with that cost as
-- its listed cost. A cost a quote or a charge wrote last (S18 PQ3) leaves it unknown until the
-- next sync reads the listing.
UPDATE "supplier_offers" AS o SET "listed_cost_usd_units" = o."cost_usd_units"
WHERE o."cost_usd_units" IS NOT NULL
  AND NOT EXISTS (
    SELECT 1 FROM (
      SELECT c."attempt_id" FROM "supplier_cost_changes" AS c
      WHERE c."offer_id" = o."id"
      ORDER BY c."created_at" DESC, c."id" DESC
      LIMIT 1
    ) AS latest
    WHERE latest."attempt_id" IS NOT NULL
  );
