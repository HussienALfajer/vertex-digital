# TASKS — Audit A02 Wallet, ledger and deposits (branch `fix/audit-a02-wallet`)

Plan `docs/audits/README.md`, report `docs/audits/A02-wallet.md`. Specs S02, S03, S04; ADR 0003, 0006, 0017, 0018.

- [x] Start: branch, README status `in progress`, report file, this list
- [x] Map and audit (api, database and ledger, worker, store, admin, tests, observability); known leads checked
- [x] Live browser test (store and admin screens of the group; USDT through the E2E specs, no local address)
- [x] Findings shown to the owner (decision pending: the USDT reservation grace, U4)
- [x] Fixes P0 → P3, each with its regression test (40 fixed; A02-7, A02-8, A02-9, A02-27, A02-34–36, A02-40–42 have no test of their own, the report says why; A02-28–30 deferred)
- [x] Re-test live with screenshots
- [x] `pnpm verify` (checker) and the reviewer; findings fixed
- [x] Report complete, README `merged`, ROADMAP audit line; PR with auto-merge
- [x] Deploy, production smoke test, README `deployed`

# TASKS — Audit A01 Identity and access (branch `fix/audit-a01-identity`)

Plan `docs/audits/README.md`, report `docs/audits/A01-identity.md`. Specs S01, S22 (passkeys); ADR 0007, 0008, 0016, 0037.

- [x] Start: branch, README status `in progress`, report file, this list
- [x] Map and audit (backend, database, worker, store, admin, tests, observability); known leads checked
- [x] Live browser test (store screens; admin `/login` only until the owner allows resetting the local admin)
- [x] Findings shown to the owner
- [x] Fixes P0 → P3, each with its regression test (A01-31 has none: no screen reaches it)
- [x] Re-test live with screenshots (store)
- [x] `pnpm verify` (checker) and the reviewer; findings fixed
- [x] Report complete, README `merged`, ROADMAP audit line; PR with auto-merge
- [x] Deploy, production smoke test, README `deployed`

# TASKS — S22 Quick buy and order help (F40, F41, F42)

Spec `docs/specs/S22-quick-buy-and-order-help.md`, ADR 0037. Three PRs as the spec's delivery plan says, one session each. No new money flow: every purchase is S08 M1, every gap is an S09 reservation then an S03/S04 deposit.

## PR 1 — quick buy (branch `feat/s22-quick-buy`)
- [x] Contracts: `quick-buy.ts` (constants `QUICK_BUY_CARDS`, `QUICK_CODE_LENGTH`, `QUICK_CAMPAIGN_PATTERN`, `QUICK_LINK_RETENTION_DAYS`, `QUICK_LINK_STATS_DAYS`, `BEST_VALUE_MIN_PACKS`, `BEST_VALUE_MIN_LEAD_BPS`; `depositGap` BG1, `gapDepositAmount` BG3, `bestValue` BV1–BV3, `parseSearchCommand` SC1–SC5; `quickBuySchema`, `quickLinkResolveSchema`, `quickLinkStatsSchema`); `createOrderSchema.quickLink`, `walletSummarySchema.reservedUsdUnits`, `savedPlayerSchema.quickBuyHidden`, admin game `bestValueEnabled`, admin product `quickCode`; catalog packs `perHundredUsdUnits` and `bestValue`; error `QUICK_LINK_NOT_FOUND` with its Arabic text; audit `catalog_game.updated` with `bestValueEnabled`; unit tests at 100%
- [x] DB (`/db-migration`): `catalog_products.quick_code` (generated, backfilled, unique, pattern check), `catalog_games.best_value_enabled`, `quick_link_events` (append-only, `order_id` unique, kind check), `saved_players.quick_buy_hidden`, `orders (customer_id, game_id, paid_at)` index if none serves QB2; `TABLE_OWNERS`, `NOT_BUSINESS_RECORDS`; the attribution row in the purchase transaction (DL4, replay writes nothing); `orders.sweep` deletes link events older than 90 days; tests (backfill unique, guards, replay); drift
- [x] API: `GET /api/quick-buy` (QB1–QB3, private prices), `PATCH /api/saved-players/:id` `quickBuyHidden`, `GET /api/q/:code` (public, rate limit, one open per address, code and hour via PostgreSQL counters, targets DL2; nginx zone), `POST /api/orders` `quickLink` (DL4), `GET /api/wallet` `reservedUsdUnits`, public and private catalog `perHundredUsdUnits`/`bestValue`, admin game `bestValueEnabled` (audit, revalidation), admin product `quickCode`, `GET /api/admin/quick-links` (DL5, test customers excluded, net of refunds); tests
- [x] Worker: `orders.sweep` link-event retention; tests
- [x] Bridge: OpenAPI export and admin client
- [x] Store: home "اشحن مجدداً" row and quick-buy sheet (QB4–QB6, `next/dynamic`), `/q/[code]` per-request route with the forwarded address, buy box link preselection (DL3) and campaign in session storage, the gap block in buy box and sheet (BG1, BG2, BG5) and cart, deposit form `?gap=` (BG3), best value on the game page (BV2, BV3 browser recompute), search commands (SC1–SC5), "معرّفاتي" quick-buy switch; i18n, states, phone width; budgets held or raised with the reason
- [x] Admin: product list and editor quick-link card (copy, QR PNG/SVG, campaign builder), game form "شارة أفضل قيمة", `/catalog/quick-links` table with navigation; i18n, states
- [x] E2E flows and RTL screenshots (store: home row and sheet, gap block and deposit strip, best value, search commands; phone and desktop, dark and light; admin: link card, quick-links table, light and dark)
- [x] Wiring checklist (quick-buy strings in their own catalog `features/quick-buy/messages.ar.json`; home, content and cart budgets raised by 2 KB with the reason in `e2e/store.spec.ts`; nginx zone `vdquick` for `/q/` and `/api/q/`)
- [x] Checks (lint, typecheck, test, build, drift, OpenAPI, changed E2E), reviewer (3 blocking findings fixed: the open counter's failure logged without the query's parameters, the reservation page's deposit link in `orders.spec.ts`, a rate-limit test for `/api/q/:code`; the link cookie is `Secure` from `STORE_URL`)
- [x] Owner acceptance (2026-10-21), PR with auto-merge

## PR 2 — passkeys (branch `feat/s22-passkeys`)
- [x] Contracts: `passkeySchema`, `passkeyNameSchema` (1–40, printable, no bidi controls), `PASSKEY_LIMIT` (10), `PASSKEY_GRANT_MINUTES` (5), `authorizePasskeySchema`; errors `PASSKEYS_LIMIT_REACHED` (and `REAUTHENTICATION_REQUIRED` for customers) with Arabic text; audit `customer.passkey_added`, `customer.passkey_removed`, `customer.passkeys_cleared`; email template `customer_passkey_added`; admin profile passkeys schema; unit tests
- [x] DB (`/db-migration`): `customer_passkeys` (plugin columns, `credential_id` unique, `customer_id` indexed FK, name check); `TABLE_OWNERS` (`auth`), listed as not business records (credentials); drift
- [x] API: the auth module's own Better Auth plugin on SimpleWebAuthn (`@better-auth/passkey` 1.7.7 neither requires user verification nor tells a counter regression apart: spec implementation notes) on the customer instance only (rp id = store host, origin `STORE_URL`, user verification required, resident keys preferred); `POST /api/account/passkeys/authorize` (C11 limit, grant row `passkey-grant:<session>`); registration refused without a live grant, at 10; addition: row, audit, email, grant deleted in one transaction; remove audited (rename is not: spec notes); sign-in through the session hooks (C15, sign-in log, `customer_new_sign_in`), per-address limit, no ALTCHA; counter regression refused and alerted (A13); a password reset clears passkeys with `customer.passkeys_cleared`; admin profile passkeys read; tests (grant missing/expired/used, limit, reset, archived, rename/remove other customer's → not found)
- [x] Worker: the `customer_passkey_added` email template; test
- [x] Bridge: OpenAPI export and admin client
- [x] Store: account section "الدخول بالبصمة" (password dialog, list, rename, remove; hidden without WebAuthn), sign-in button and email autofill (`@simplewebauthn/browser` through `next/dynamic`); i18n, states, phone width; budgets held or raised with the reason
- [x] Admin: profile devices tab passkeys list (read only); i18n, states
- [x] E2E with a virtual authenticator (store: section and sign-in, phone and desktop, dark and light; admin: devices tab, light and dark)
- [x] Wiring checklist, checks (lint, typecheck, test, build, drift, OpenAPI, changed E2E), reviewer (1 blocking finding fixed: a passkey sign-in racing a reset; re-review clean)
- [x] Owner acceptance (2026-10-25), PR with auto-merge

## PR 3 — order help and alerts (branch `feat/s22-order-help-alerts`)
- [x] Contracts: `product-alerts.ts` (`PRODUCT_ALERTS_MAX`, `PRODUCT_ALERT_DAYS`, kinds and statuses, `alertDue` PA3–PA5, `productAlertSchema`, `createProductAlertSchema`, list query); `support.ts` (`ORDER_PROBLEMS`, `ORDER_PROBLEM_WINDOW_DAYS`, `orderProblemsFor` OP2–OP4, `orderProblemAllowed`, `createTicketSchema.orderProblem`, ticket rows and admin filter `problem`); errors `ORDER_PROBLEM_UNAVAILABLE`, `PRODUCT_ALERTS_LIMIT_REACHED`, `PRODUCT_ALERT_INVALID` with Arabic text; notification events `product_available`, `product_price_dropped` (push-only) and their push texts; `ticket.opened` details `orderProblem`; queue `catalog.product-alerts`; admin product `waitingAlerts`; unit tests at 100%
- [x] DB (`/db-migration`): `support_tickets.order_problem` (enum, check with category); `product_alerts` (partial unique active, `(status, product_id)` index); `TABLE_OWNERS`, `NOT_BUSINESS_RECORDS`; the alert write paths shared by the API and the worker; `orders.sweep` deletes ended alerts older than 90 days; tests; drift
- [x] API: `POST /api/support/tickets` `orderProblem` (OP2, OP3, subject and body, audit, Telegram label); `GET /api/admin/support/tickets?problem=`, rows and thread `orderProblem`; `GET`/`POST`/`DELETE /api/product-alerts` (PA1, 30 an hour, 30 active, own only); admin product `waitingAlerts`; tests
- [x] Worker: `catalog.product-alerts` every 15 minutes at :07 (PA3–PA6, batches of 500, each alert its own transaction under `SKIP LOCKED`, dedupe key); sweep retention; push texts; Telegram `ticket_opened` problem label; tests
- [x] Bridge: OpenAPI export and admin client
- [x] Store: order page "مشكلة في الطلب؟" card, hint sheet and form (`next/dynamic`); alert buttons (folded list, buy box unavailable and bell); "تنبيهاتي" page and menu links; notification texts; i18n, states, phone width; budgets held or raised with the reason
- [x] Admin: support queue problem chip and filter, thread side panel line; product list and editor "بانتظار التوفر: N"; i18n, states
- [x] E2E flows and RTL screenshots (store: problem card, hint sheet, form, alert buttons, "تنبيهاتي"; phone and desktop, dark and light; admin: queue chip and filter, waiting count, light and dark)
- [x] Wiring checklist, checks (lint, typecheck, test, build, drift, OpenAPI, changed E2E), reviewer (blocking findings fixed: a `failed` order treated as in progress and the refund hint only after a refund; tests for private-list baselines, the rebase, hidden packs, paused games, archived customers and the parallel 30th alert; `orderProblem` in the OpenAPI body; alert buttons on a folded list that opens itself)
- [x] Owner acceptance (2026-10-26), PR with auto-merge; `docs/ROADMAP.md` S22 done

# TASKS — Faster checks (branch `chore/test-speed`)

The model vertex-hub adopted on 2026-10-26 (its PR #172), adapted here; `docs/testing.md`.

- [x] Measure before: api and worker suites, the whole E2E suite of admin and store
- [x] Vitest: `isolate: false` for the api and the worker; `process.env` and spies restored after each file; the query guards patched once per process with a list per file (probe files proved both fail every file in one worker, then deleted)
- [x] Workers sized to the machine (`testWorkers()`, shared with `scripts/setup-local-db.mjs`); missing worker databases created by the global setups as the owner role; `DATABASE_POOL_MAX` for the test apps
- [x] An advisory lock per suite for the length of a run (`holdTestDatabases`) in the db, api and worker global setups
- [x] Playwright: `trace: 'on-first-retry'`; every timeout was the trace's load, none left to fix (two whole runs each)
- [x] `pnpm verify`; `.verify/` git-ignored
- [x] The `test-guard` hook and `Bash(pnpm verify*)`
- [x] Agent rules and docs: checker, feature-slice, db-migration, supplier-adapter, AGENTS.md, CLAUDE.md, `docs/testing.md`, folder `CLAUDE.md` files, workflow, architecture, README, roadmap
- [x] CI: `TURBO_*` env on the turbo jobs, `remoteCache.signature`, the cache comment, `TEST_WORKERS` passed through
- [x] Measure after, `pnpm verify`, reviewer (fixed: the worker's Sentry module mock, now a spy, and `vi.mock` refused in both suites; the remote-cache secrets on the turbo steps only, read-only for pull requests; the connection budget stated as measured); `client.test.ts` connect limits sized for parallel suites; the staff scan skips `.data`
- [x] PR with auto-merge (#174), Auto-fix; CI's first run caught a race in `suppliers.spec.ts` (typing before the refused field took the focus), fixed with a wait for the focus
- [x] api CI shards only if Tests is still the longest job in this PR's CI run: not needed. In #174's runs Tests took 2 min 31 s (every suite ran) and 55 s, the longest E2E shard 4 min 54 s and 3 min 58 s; E2E sets the PR's time
