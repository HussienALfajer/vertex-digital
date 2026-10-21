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
- [ ] Contracts, DB (`customer_passkeys`), API (plugin, grant, limits, reset clears, sign-in hooks, email), store (account section, sign-in button and autofill), admin (profile devices tab), E2E with the virtual authenticator
- [ ] Wiring checklist, checks, reviewer, owner acceptance, PR with auto-merge

## PR 3 — order help and alerts (branch `feat/s22-order-help-alerts`)
- [ ] Contracts, DB (`support_tickets.order_problem`, `product_alerts`), API (ticket problem, alerts CRUD, waiting count, admin filter), worker (`catalog.product-alerts`, sweep, notifications, Telegram label), store (problem card, hints, form, alert buttons, "تنبيهاتي"), admin (queue chip and filter, thread line, waiting count), E2E
- [ ] Wiring checklist, checks, reviewer, owner acceptance, PR with auto-merge; `docs/ROADMAP.md` S22 done
