# TASKS — S11 Live operations

Spec: `docs/specs/S11-live-operations.md` (F17, F18; ADRs 0003, 0004, 0005, 0011, 0016, 0019, 0020, 0022, 0025). Two PRs, as the spec's implementation notes suggest; each leaves `main` green.

## PR 1 — Contracts, db, api, worker guards, bridge (`feat/s11-live-ops-api`) · Opus 5.5 `high`
- [x] Contracts `orders.ts`: `ATTEMPT_KINDS`, `LIVE_COLUMNS`, `liveColumn`, `slowAfterSeconds`; live board, card, stream event, reroute options/request, fulfil, delivery proof schemas; admin attempt shape gains `kind`, `chosenByAdmin`, `proofFileId`, `deliveryReference`
- [x] Contracts `dashboard.ts` (new, re-exported): `damascusDayBounds` (reuse the daily summary's helper if present), `deltaPercent`, `ATTENTION_KINDS`, `attentionItemSchema`, `dashboardSchema`
- [x] `STORED_FILE_KINDS` (db `files.ts`) + `delivery_proof`; error codes `ROUTE_NOT_ELIGIBLE`, `LOSS_NOT_CONFIRMED`, `PROOF_INVALID` with Arabic admin text; audit `order.rerouted`, `order.fulfilled_manually`, `order.proof_uploaded` with labels; 100% coverage of the pure rules
- [x] Db (`/db-migration`): `fulfilment_attempts` `kind` enum, nullable route fields with the kind check, cost checks (`≥ 0`, `> 0` for routed, journal ⇔ delivered and cost > 0), `proof_file_id` unique FK, `delivery_reference`, `chosen_by_admin`; file kind `delivery_proof`; tests of the checks, triggers unchanged
- [x] Db write paths in `packages/db/src/orders`: `rerouteOrder` (RR1–RR3, eligibility rechecked under the lock, two transitions from `sent_to_supplier`, `orders.poll` or `manual_order` card in the transaction), `fulfilOrderManually` (MF1–MF5, zero cost posts no journal), refund extension RF1; concurrency tests (reroute vs late poll and webhook, fulfil vs late result, two fulfils with different keys, same key replayed, reroute vs cost change)
- [x] Api `orders` admin: `GET /orders/live` (LR1, LR2, filters, caps), `GET /orders/:id/routes` (RR2), `POST /reroute`, `POST /proof` (re-encoded, audited), `GET /proofs/:fileId` (`no-store`), `POST /fulfil`, refund RF1, resolve refusal MF1; attempts' new fields on the order detail
- [x] Api admin stream `GET /api/admin/stream` (LR4: forward `customer_orders` events, `resync`, heartbeat, 3 streams, 30 connects/min, session re-check)
- [x] Api `dashboard` read module (DB1–DB9) reading other modules through their services; `TABLE_OWNERS`/architecture test
- [x] Tests: `test/live-operations.test.ts` (every route: success, 401, 403, re-auth, every error code, `no-store`)
- [x] Worker: sweep, fulfil and poll ignore `admin_fulfil` attempts; a rerouted `sending` attempt is sent by its poll with its key; tests
- [x] Bridge: build, OpenAPI export, admin client; admin E2E mocks follow changed shapes; the order page hides "تأكّدت: تمّ التسليم" on manual attempts (MF1) until PR 2 adds the manual fulfil
- [x] nginx: admin host `/api/admin/stream` buffering off and long read timeout, proof uploads up to 11 MB (`deploy/`)
- [x] Wiring checklist, docs (`docs/architecture.md` admin stream and dashboard module, S08 D2 note → MF1, folder `CLAUDE.md` files, spec "Settled in implementation")
- [x] Checks (lint, typecheck, build, e2e, drift: passed and recorded on 135698275a6c; test: all packages pass except 3 Windows-only worker failures in `telegram-jobs.test.ts` that predate this branch, left to CI), reviewer (two blocking findings: an open manual attempt's cost could be rewritten without its proof; the access and error matrix was incomplete; both fixed), owner acceptance (2026-10-10), PR with auto-merge

## PR 2 — Admin screens, E2E (`feat/s11-live-ops-screens`) · Opus 5.5 `high`
- [ ] Admin stream hook (`features/live/` or `lib/`), reconnect, `resync`, indicator
- [ ] Dashboard home page `/`: attention list, KPI row with deltas and the 7-day line, live counts, deposits, suppliers table, rate; skeletons, error, stale note; refetch rules DB9
- [ ] `/orders/live`: filters in the URL, four columns (tabs below tablet), cards with ticking time, amber/red, "+N أخرى", sound toggle (`localStorage`), tab title count, side sheet with actions; navigation item
- [ ] Dialogs: reroute (route table, warning), manual fulfil (units, codes, cost with live profit/loss, loss checkbox, proof upload with preview), extended refund; on `/orders/$id` too; attempts show "اختاره الأدمن", "تنفيذ يدوي", reference, proof thumbnail; i18n keys
- [ ] E2E flows (mocked stream event moving a card) and RTL screenshots light and dark
- [ ] Wiring checklist, docs (`docs/ROADMAP.md` S11 done, `apps/admin/CLAUDE.md`, `wiring.md` patterns)
- [ ] Checks, reviewer, owner acceptance, PR with auto-merge
