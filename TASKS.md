# TASKS — S07 Suppliers, mapping and price sync

Spec: `docs/specs/S07-suppliers.md` (F09 with F10, CT9; ADRs 0003, 0004, 0005, 0008, 0011, 0016, 0019, 0020, 0021). Three PRs, as the spec's implementation notes suggest; each leaves `main` green and runs in its own session. The `shop2topup` and `wdgzone` adapters follow later through `/supplier-adapter` (Q12).

## PR 1 — Contracts, db, repricing write path, `suppliers` API module, `pricing` additions, bridge · Opus 5.5 `high`
- [ ] Contracts `suppliers.ts`: codes, health states, call operations and results, credential fields, sync triggers and statuses, policy schema; schemas for every request and response; pure `supplierHealth` (H1–H5), `routeUsability` (RT4), `priceBasis` (RT5–RT6, P1); unit tests (100%)
- [ ] Contracts `pricing.ts`: price change causes, review statuses, price / review / decide schemas; pure `needsReview` (P3), `displayStepAllowed` (P9); `catalog.ts`: `productAvailability` with routes and held price (P6); `settings.ts`: three supplier switches; `telegram.ts`: new message kinds; unit tests (100%)
- [ ] Contracts: error codes (`SUPPLIER_NOT_CONFIGURED`, `SUPPLIER_UNAVAILABLE`, `OFFER_ALREADY_MAPPED`, `ROUTE_EXISTS`, `ROUTE_KIND_MISMATCH`, `ROUTE_FIELDS_UNMAPPED`, `OFFER_MISSING`, `REVIEW_CLOSED`, `REVIEW_STALE`, `DISPLAY_STEP_TOO_LARGE`) with Arabic admin text; audit entity types and actions with admin labels; queue names
- [ ] Db (`/db-migration`): `suppliers` (seeded four), `supplier_credentials`, `supplier_offers`, `supplier_cost_changes`, `supplier_sync_runs`, `supplier_calls`, `supplier_health_changes`, `supplier_balance_reads`, `supplier_policy` (seeded), `product_routes`, `product_prices`, `price_reviews`; enums, checks (whole cents, `price > cost`), partial unique indexes, append-only triggers and grants; `TABLE_OWNERS`; tests
- [ ] Db: credential encryption (AES-256-GCM, supplier id as associated data, key version) shared by api and worker; tests (round trip, moved ciphertext, wrong key)
- [ ] Db: repricing write path `packages/db/src/pricing` (P1–P5: product locks in id order, review hold and refresh, causes) and the availability facts read; tests on real PostgreSQL (each cause, review hold/refresh, rule change with open reviews, concurrent sync and rule change, 100-row import)
- [ ] Api `suppliers` module: list, detail, credentials (re-authentication, enqueue `admin` sync), threshold, sync request (1/min, running run), runs, offers, cost history, import (RT8), routes (create, manual, update, archive/restore, manual cost), price history, policy; audit in each transaction; `no-store`; `test/suppliers.test.ts`
- [ ] Api `pricing` additions: reviews list, decide (P4), adjust margin; rule changes reprice (P5); `PUT /api/admin/rates` refuses `DISPLAY_STEP_TOO_LARGE` (P9); game detail adds price, basis supplier, availability; tests
- [ ] Env: `SUPPLIER_KEYS_SECRET`, `SUPPLIER_FAKE_ENABLED` (refused in production) in api config and `.env.example`; nginx zone for sync-now if needed
- [ ] Bridge: build, OpenAPI export, admin client
- [ ] Wiring checklist, docs (`docs/architecture.md` rows, folder `CLAUDE.md`, `docs/deployment.md`, `wiring.md` patterns)
- [ ] Checks, reviewer, acceptance, PR with auto-merge

## PR 2 — Worker: registry, sync, balances, health, messages, fake scripting · Opus 5.5 `high`
- [ ] Suppliers: `SupplierOffer` gains optional `group`, `kind`, `requiredFields`; fake catalog (~10 offers, groups, kinds, fields) with scripted overrides from `FAKE_SUPPLIER_STATE_FILE`
- [ ] Worker registry (`SupplierRegistry.get`), decryption per call, every call in `supplier_calls`
- [ ] Jobs `suppliers.sync` (SY1–SY4), `suppliers.sync-schedule`, `suppliers.balances` (H5), `suppliers.health` (H1–H4, SY5 stale repricing)
- [ ] Telegram kinds `supplier_sync_summary`, `supplier_health`, `supplier_balance_low`, `supplier_sync_failing`; daily summary lines
- [ ] Dev CLI `supplier:fake`; commands table in `AGENTS.md`
- [ ] Tests (sync, suspicious list, failure, stale, missing, concurrent run; balances; health and probe; dedupe keys; credentials never logged)
- [ ] Wiring checklist, docs
- [ ] Checks, reviewer, acceptance, PR with auto-merge

## PR 3 — Admin screens and E2E · Opus 5.5 `high`
- [ ] Admin `features/suppliers/`: `/suppliers`, `/suppliers/$code` (connection, offers with import dialog, sync, health), `/suppliers/policy`
- [ ] Admin catalog game page: price, basis, availability; routes drawer (tiers, usability, add route, manual route, priority, enable, archive/restore, price history)
- [ ] Admin `/pricing/reviews` (bulk accept, adjust margin, pause, `REVIEW_STALE`); `/settings/rates` step error
- [ ] Navigation "الموردون" and "مراجعة الأسعار" with count; i18n
- [ ] E2E flows and RTL screenshots (light and dark)
- [ ] Wiring checklist, docs (`docs/ROADMAP.md` S07 done, `wiring.md` patterns)
- [ ] Checks, reviewer, acceptance, PR with auto-merge
