# TASKS — S21 Merchant tools (F30–F39)

Spec `docs/specs/S21-merchant-tools.md`, ADR 0036 (amends 0035, 0022, 0024). Three PRs as the spec's delivery plan says, one session each. Every PR is deployable alone and leaves retail customers unchanged.

## PR 1 — merchant core: selling prices, dashboard, alerts, levels (branch `feat/s21-merchant-core`)
- [x] Contracts: `merchant-tools.ts` (`sellingPrice` SP3, `saleProfit` SP6, `levelFor` LV3, `damascusMonth`, `monthRange`, `SYP_STEPS`, `MERCHANT_LEVELS_MAX`, `WATCHES_MAX`; `sellingSettingsSchema`, `sellingPriceInputSchema`, `merchantDashboardSchema`, `watchesSchema`, `alertSettingsSchema`, `merchantLevelSchema`, `merchantLevelInputSchema`); `effectiveListId` with the level (LV5, amends S20 AT1); notification events `merchant_level_changed`, `merchant_watch_digest`, `merchant_daily_digest`, `merchant_low_balance`; errors `MERCHANT_LEVELS_LIMIT_REACHED`, `MERCHANT_LEVEL_THRESHOLD_TAKEN`, `WATCHES_LIMIT_REACHED` with Arabic texts; audit `merchant_level.*`, `merchant.level_changed`; jobs list; unit tests at 100%
- [x] DB (`/db-migration`): `merchant_selling_settings`, `merchant_selling_prices`, `merchant_order_sales`, `merchant_watches`, `merchant_watch_states`, `merchant_alert_events` (append-only), `merchant_alert_settings`, `merchant_levels`, `merchant_profiles.level_id` and `level_changed_at`; `orders (customer_id, finished_at)` index if missing; `NOT_BUSINESS_RECORDS` and `TABLE_OWNERS`; drift
- [x] DB write paths: the effective list with the level (LV5) wherever S20 reads it; the sale row in the purchase and checkout transactions (SP4); the level recomputation (LV4: customer `FOR UPDATE`, AT3 when the list changes, audit, notification); LS5 extended (a list named by a live level); revocation clears the level (LV7); low-balance alert in the purchase transaction and its clearing (AL5, AL6); tests (level vs purchase in parallel, sale rows, AL5 once)
- [x] API `merchant-tools` module: dashboard (DB1–DB6), selling settings and prices, watches with suggestions, alerts list, alert settings, games; `NOT_MERCHANT`, frozen reads only; level queued after purchase, checkout, refund and grant (in `packages/db`). `PUT /api/orders/:id/sale` (SP5) moves to PR 2 with the order page that edits it; the DB write path `setOrderSale` is ready
- [x] API `merchants`: admin levels (list, create, edit, archive under an advisory lock, re-authentication, audit, requeue all, LV6); level in the admin customer profile and merchants list (column and filter)
- [x] Worker: `merchants.level` (singleton per merchant) and `merchants.level-schedule` (1st 00:10 Damascus), `merchants.watch-alerts` (hourly :05; AL2, AL3, AL6, archived products dropped), `merchants.daily-digest` (09:00; area `merchants`: the contracts' `<area>.<action>` test refuses a hyphen), sweep of alert events older than 90 days; email templates and push; daily summary line; tests (twice is a no-op)
- [x] Bridge: OpenAPI export and admin client
- [x] Store: account menu "أدوات التاجر", `/merchant` shell and dashboard (period switch, cards, top products, level card, empty state), `/merchant/prices`, `/merchant/alerts`; i18n, states, phone width
- [x] Admin: `/merchants/levels`, merchants list level column and filter, profile merchant card (level, months' purchases, follows count); i18n, states
- [x] E2E flows and RTL screenshots (store dashboard, prices, alerts: phone and desktop, dark and light; admin levels and profile card: light and dark)
- [x] Wiring checklist, checks (lint, typecheck, test, build, drift, OpenAPI, changed E2E; store budgets kept: the merchant pages read their own catalog), reviewer (2 blocking findings fixed: the level recomputation reads an archived level and cancels reservations off the effective list on every run; the low-balance re-arm reads the posting position, migration 0085; re-review clean)
- [x] Owner acceptance (2026-10-21), PR with auto-merge

## PR 2 — counter tools: POS, bulk, codes, verification, branded receipt (branch `feat/s21-counter-tools`)
- [ ] Contracts: `parseBulkLines`, bulk check schemas, `codeReleaseRequestSchema`, `orderPrintSchema`, `publicVerificationSchema`, `receiptSettingsSchema`, `CODE_RELEASE_PURPOSES`, `merchant_logo` file kind, merchant player-check settings, constants (QT1, bulk 50, recent and saved IDs), errors `BULK_LINES_INVALID`, `PLAYER_CHECK_QUOTA_EXCEEDED`, `CODES_NOT_DELIVERED`, audit `merchant.logo_removed`; unit tests
- [ ] DB (`/db-migration`): `orders.verification_code` (backfilled, unique, guarded), `order_code_reveals.purpose`, `checkouts.line_count` 1–50 and `source`, `merchant_receipt_settings`, `merchant_settings` quota columns; QT1 and QT3 in `packages/db/src/orders`; tests
- [ ] API: recent players, merchant saved-ID limits, bulk check with the merchant quota (BK4), 50-line checkouts for merchants, code releases and `.xlsx` export (CR1–CR3), print data, public verification (rate limit, nginx zone), receipt settings, logo upload and admin removal, branded receipt link (BR1, BR2); tests
- [ ] Bridge: OpenAPI export and admin client
- [ ] Store: `/merchant/pos`, `/merchant/bulk`, order page print and release actions, `/orders/[id]/print`, `/v/[code]`, `/merchant/receipt`, QR on receipts
- [ ] Admin: merchant settings quota, order code releases, profile branding with "حذف الشعار"
- [ ] E2E flows and RTL screenshots
- [ ] Wiring checklist, checks, reviewer, owner acceptance (spec steps 2, 3, 4), PR with auto-merge

## PR 3 — documents: price list and statement (branch `feat/s21-documents`)
- [ ] Contracts: `priceListQuerySchema`, `statementSchema`, `merchant_statement_ready`, `STATEMENT_MONTH_INVALID`; tests
- [ ] API: price list rows and PNG (sharp and Pango, 60 rows, 20 / hour), statements list, month (balance equation, A13 alert) and `.xlsx`; tests
- [ ] Worker: `merchant-tools.statement-emails` (1st 08:00 Damascus) and its template; tests
- [ ] Bridge: OpenAPI export and admin client
- [ ] Store: `/merchant/price-list` with print page and PNG download, `/merchant/statements` and the month page with print and Excel
- [ ] E2E flows and RTL screenshots
- [ ] Wiring checklist, checks, reviewer, owner acceptance (spec step 8), PR with auto-merge; `docs/ROADMAP.md` S21 done
