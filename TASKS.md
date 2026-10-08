# TASKS — S07 Suppliers, mapping and price sync

Spec: `docs/specs/S07-suppliers.md` (F09 with F10, CT9; ADRs 0003, 0004, 0005, 0008, 0011, 0016, 0019, 0020, 0021). Three PRs, as the spec's implementation notes suggest; each leaves `main` green and runs in its own session. The `shop2topup` and `wdgzone` adapters follow later through `/supplier-adapter` (Q12).

## PR 1 — Contracts, db, repricing write path, `suppliers` API module, `pricing` additions, bridge · Opus 5.5 `high`
- [x] Contracts `suppliers.ts`: codes, health states, call operations and results, credential fields, sync triggers and statuses, policy schema; schemas for every request and response; pure `routeUnusableReason` (RT4), `routeTier`, `orderRoutes`, `priceBasis` (RT5–RT6, P1); unit tests (100%)
- [x] Contracts `pricing.ts`: price change causes, review statuses, price / review / decide schemas; pure `needsReview` (P3), `costChangeBasisPoints`; `rates.ts`: `maxDisplayStepSypUnits` (P9); `catalog.ts`: `productAvailability` with routes and held price (P6), product price fields; `settings.ts`: four supplier switches; unit tests (100%)
- [x] Contracts: error codes with Arabic admin text; audit entity types and actions with admin labels; queue `suppliers.sync`
- [x] Db (`/db-migration`): 12 tables, enums, checks, partial unique indexes, append-only triggers and grants, run and review guards, seeds (0026 generated, 0027 hand-written); `TABLE_OWNERS`; tests
- [x] Db: credential encryption (AES-256-GCM, supplier id as associated data, key version); tests
- [x] Db: repricing write path and routing state `packages/db/src/pricing` (P1–P6, P9 read); tests on real PostgreSQL
- [x] Api `suppliers` module (suppliers, credentials, threshold, sync request, runs, offers, cost history, import, routes, policy) and catalog products with price and availability; `test/suppliers.test.ts` (incl. 100-row import, parallel mapping, parallel decisions)
- [x] Api `pricing` additions: reviews, decide, adjust margin, price history; rule changes reprice (P5); rates refuse `DISPLAY_STEP_TOO_LARGE` (P9); a supplier's pause reprices (SP3)
- [x] Env: `SUPPLIER_KEYS_SECRET` (required in production, derived locally), `SUPPLIER_FAKE_ENABLED` (refused in production); `.env.example`, `provision.sh`, `docs/deployment.md`; no nginx change (admin routes, "sync now" limited in the API)
- [x] Bridge: build, OpenAPI export, admin client; admin E2E mocks follow the new product shape
- [x] Docs: `docs/architecture.md`, folder `CLAUDE.md` files, `docs/deployment.md`, spec "Settled in implementation"
- [x] Wiring checklist, `wiring.md` patterns
- [x] Checks (lint, typecheck, test, build, e2e, drift: all passed and recorded), reviewer (five blocking findings, fixed with tests), owner acceptance (2026-10-08, P9's 1-pound minimum confirmed), PR with auto-merge

## PR 2 — Worker: registry, sync, balances, health, messages, fake scripting · Opus 5.5 `high`
- [ ] Suppliers: `SupplierOffer` gains optional `group`, `kind`, `requiredFields`; fake catalog (~10 offers, groups, kinds, fields) with scripted overrides from `FAKE_SUPPLIER_STATE_FILE`
- [ ] Contracts: `supplierHealth` (H1–H5) and the probe rule with unit tests; queues `suppliers.sync-schedule`, `suppliers.balances`, `suppliers.health`; Telegram kinds (db enum migration)
- [ ] Worker env: `SUPPLIER_KEYS_SECRET` derived exactly as the API's, `SUPPLIER_FAKE_ENABLED` refused in production
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
