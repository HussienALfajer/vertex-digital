# TASKS — S09 Storefront and purchase

Spec: `docs/specs/S09-storefront-and-purchase.md` (F12, F13, F15 with A02, A08's store side, A15, F26 SW7 and F27; ADRs 0002, 0003, 0004, 0005, 0008, 0011, 0012, 0013, 0015, 0019, 0020, 0021, 0022, 0023). Three PRs, as the spec's implementation notes suggest; each leaves `main` green and runs in its own session.

## PR 1 — Contracts, db, api (public catalog, player checks, reservations, cancel, stream, admin additions), bridge · Opus 5.5 `high`
- [x] Contracts `catalog.ts`: `searchTermsSchema`, `storefrontSchema`, `storeGameSchema`, `storeProductSchema`, `searchIndexSchema`, service statuses; pure `normalizeSearchText`, `searchCatalog`, `cheapestPackCombination`, `gameServiceStatus`, `storeServiceState`, `CATALOG_IMAGE_WIDTHS`; unit tests (100%)
- [x] Contracts `orders.ts`: `awaiting_balance` stage, `CANCEL_REASONS`, `PLAYER_CHECK_STATES`, `createOrderSchema` (`whenBalanceShort`, `confirmPlayer`), player-check schemas, `ORDER_TIMELINE_STEPS` and `orderTimeline` (replaces `stageTimeline`), `reservationCharge`, reservation limits; order and admin order shapes extended; unit tests
- [x] Contracts: `validationQuotaSchema`; notification events `order_paid`, `order_cancelled` and the stream's `order` event; Telegram kind `validation_quota_reached`; error codes (`PLAYER_NOT_CONFIRMED`, `RESERVATIONS_LIMIT_REACHED`, `ORDER_NOT_CANCELLABLE`) with Arabic store and admin text; audit actions with admin labels; queues `orders.pay_waiting`, `orders.waiting_sweep`, `store.revalidate`
- [x] Db (`/db-migration`): `orders` columns (nullable journal with its check, `expires_at`, `reserved_at`, `cancel_reason`, `player_check`, `player_name`), indexes, guard trigger change (`awaiting_balance → paid` price columns); `player_checks` (grants without `UPDATE`); `suppliers.validation_daily_quota`; `supplier_calls` index; `catalog_games.search_terms`; tests
- [x] Db: order write path: reserve in `purchaseOrder` (limit of 3 under the wallet lock, PV8 states), `payWaitingOrders` (RS4 steps, RS6 charge, skip and continue), `cancelReservation`, `expireReservations`; `pg_notify('customer_orders', …)` on every status change; reads extended; concurrency tests (two credits on one reservation, pay against cancel and expiry, repricing and stop, one key with `reserve` in parallel, skip-and-continue)
- [x] Api `catalog`: public `storefront`, `games/:slug`, `search-index` (no cookie, `public, max-age=30`, no supplier data), image widths (`?w=`, WebP variants made once); admin search terms on the game edit; `store.revalidate` queued at the change points (catalog, prices, availability, health, supplier pause, rate)
- [x] Api `orders`: `POST /api/player-checks` (PV1–PV7: route choice, HMAC cache, limits counting supplier calls only, daily quota with the Telegram alert, 5 s timeout, `supplier_calls`); purchase with `reserve` and `confirmPlayer`; `POST /api/orders/:id/cancel`; responses with `timeline`, `expiresAt`, `cancelReason`, `playerName`; admin list and detail fields and statuses
- [x] Api: `orders.pay_waiting` queued at the three A02 credit points and after a reservation; the stream's `order` event (LISTEN on `customer_orders`, fan-out by customer); admin `PUT /api/admin/suppliers/:code/validation-quota` with today's usage
- [x] Rate limits: player checks (API per customer and per IP; nginx zone `vdplayercheck` in `deploy/`)
- [x] Env: `PLAYER_CHECK_SECRET` (api), `STORE_REVALIDATE_SECRET` (api, worker, store); `.env.example`, `provision.sh`, `docs/deployment.md`
- [x] Dev CLI `order:place --reserve --confirm-player`; commands table in `AGENTS.md`
- [x] Tests: `test/catalog.test.ts`, `test/orders.test.ts`, `test/player-checks.test.ts`, `test/notifications.test.ts`, `test/suppliers.test.ts` additions per the spec's API list
- [x] Bridge: build, OpenAPI export, admin client; admin and store E2E mocks follow changed shapes (`timeline`), the store's stage, step and notification texts
- [x] Wiring checklist, docs (`docs/architecture.md`, folder `CLAUDE.md` files, spec "Settled in implementation")
- [x] Review fixes: the worker creates every shared queue at start; player-check limits count only supplier calls; image sizes written whole; concurrent payment races (repricing, stop, expiry); shared test rows kept out of the worker's health and sweep tests
- [x] Checks (lint, typecheck, test, build, e2e, drift: all passed and recorded), reviewer (four blocking findings: a queue the worker never created, missing concurrent races, limits counting non-supplier answers, half-written image sizes; fixed and re-reviewed: no blocking issues), owner acceptance (2026-10-09), PR with auto-merge

## PR 2 — Worker: paying and expiring reservations, cache cleanup, store revalidation, Telegram · Opus 5.5 `high`
- [x] Jobs `orders.pay_waiting` (stately per customer, RS4 through the db write path), `orders.waiting_sweep` (every 5 minutes, at most 500)
- [x] `orders.sweep` steps: RS7 expiry (at most 100, `SKIP LOCKED`) and `player_checks` cleanup
- [x] `store.revalidate` (singleton, at most once per 10 s, 5 s timeout, 3 retries, warning only)
- [x] Notifications `order_paid` (center) and `order_cancelled` (center and email with its template); Telegram `validation_quota_reached` sending; daily summary lines (validations per supplier, reservations paid and expired)
- [x] Worker env `STORE_REVALIDATE_SECRET`, `STORE_PORT`
- [x] Worker change points queue `store.revalidate`: a successful sync, a health change, a newly stale cost
- [x] Tests (each RS4 step and outcome, expiry, cleanup, waiting sweep, revalidate singleton and failure, quota message dedupe, notifications)
- [x] Wiring checklist, docs
- [ ] Checks (lint, typecheck, test, build, e2e, drift), reviewer, owner acceptance, PR with auto-merge

## PR 3 — Store and admin screens, E2E, nginx · Opus 5.5 `high`
- [ ] Store `features/catalog/`: home (hero search, service line, category chips, game cards), `/games/[slug]` (hero, ID guide, packs, calculator), cached reads with the `catalog` tag and 5-minute life, `POST /_internal/revalidate` (loopback, secret), `sitemap.xml`, `robots.txt`, metadata, `srcset`
- [ ] Store buy box: fields with the CT7 schema, sign-in return with session storage, balance and shortfall, player check UI (PV7), slide-to-pay (threshold, keyboard, reduced motion), idempotent submit and its error views, reservation
- [ ] Store `features/orders/`: LT1 timeline, live `order` events, reservation countdown and cancel, cancel reasons, player name, expected time, success sequence; "طلباتي" live; deposit wizard `?amount` and `?order`
- [ ] Store `features/search/`: header button, `Ctrl+K` / `⌘K` / `/`, lazy dialog and index, recent searches (try/catch)
- [ ] Admin: search terms chips on the game form; validation quota and usage on the supplier page; reservation, cancel and player-check fields on the order page; statuses in the list filter
- [ ] i18n keys (store and admin)
- [ ] nginx: `/_internal/` denied, `vdplayercheck` zone
- [ ] E2E flows and RTL screenshots (store phone and desktop, dark and light; admin light and dark); game page first-load budget recorded in `apps/store/CLAUDE.md`
- [ ] Wiring checklist, docs (`docs/ROADMAP.md` S09 done, `wiring.md` "Store page with cached reads" pattern, `apps/store/CLAUDE.md`)
- [ ] Checks (lint, typecheck, test, build, e2e, drift, OpenAPI drift), reviewer, owner acceptance (the spec's 13 browser steps), PR with auto-merge
