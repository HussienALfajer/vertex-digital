# TASKS — Owner answers Q23 and Q25 (branch `fix/q23-q25-owner-answers`, specs S04 and S18)

The owner answered two pilot questions on 2026-10-28, both with the recommendation.

- [x] Q23: `USDT_RESERVATION_GRACE_DAYS` 7 → 30 (S04 rule U4)
- [x] Q25: `supplier_offers.listed_cost_usd_units` (migrations 0100, 0101 backfill); the sync keeps a higher quoted or charged cost while the listing shows the same figure (S18 PQ4); worker test
- [x] `docs/open-questions.md`, S04, S18, audits A02 and A05 updated
- [x] `pnpm verify` pass; reviewer: no blocking issue
- [x] PR and merge (no deploy: it ships with the next one, the production reset)
