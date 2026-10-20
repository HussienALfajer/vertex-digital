# TASKS — S20 Merchant accounts and price lists

Spec `docs/specs/S20-merchant-accounts-and-price-lists.md`, ADR 0035. Three PRs as the spec's delivery plan says (owner, 2026-10-20), one session each. Every PR is deployable alone.

## PR 1 — lists in the database and the engine (branch `feat/s20-price-lists-engine`; no screens; every account stays on retail)
- [x] Contracts: `PRICE_LIST_KINDS`, `ROOT_PRICE_LIST_IDS`, `PRICE_KINDS`, `priceKindOf`, `PRICE_SOURCES`, `ACCOUNT_TYPES`, `effectivePriceListId`, `listChain` (depth ≤ 5), `resolveListEntry` (LS4: list-first, fixed before rules, guarding rule), `listPrice` (LP1–LP4: rule, fixed, fallback, retail cap); `PRICE_CHANGE_CAUSES` gains `list_change`, `CANCEL_REASONS` gains `price_list_changed` (labels in admin, store and the email); unit tests at 100%
- [x] DB (`/db-migration`, 0075–0078): `price_lists` (seeded roots with fixed ids, one live list per root kind), `margin_rules.price_list_id` (backfilled retail, per-list unique indexes, wholesale and cost global rules seeded by `seedRootListRules` from `pricing:reprice-lists`, not the migration (reviewer: the release before reads every live rule)), `price_list_fixed_prices`, `product_prices` gains `price_list_id`, `source`, `fixed_price_id` (backfilled, index per list), `orders.price_list_id` (backfilled, `orders_guard` on `awaiting_balance → paid`), `customers.account_type` and `price_list_id`; guards (roots never archived); migration backfill tests; drift
- [x] DB write paths: `repriceProducts` prices every unarchived list (RP1, retail first, Q21 per list), the review hold for all lists and accept reprices all (RP2), causes (RP3); the effective list of a customer; `prepareLine` and checkout at the effective list's row, `orders.price_list_id` stored (PO2); reservations paid on the order's list or cancelled with `price_list_changed` (PO3); availability per list (PO1); admin orders by mode (PO4); concurrency tests (a sync and a list change in parallel, purchase vs reprice)
- [x] API: catalog, pricing reviews and orders read the retail list where they read "the price"; `pnpm --filter @vertex-digital/api pricing:reprice-lists` (RP4, idempotent); seed-local; tests (purchase at the effective list, `PRICE_CHANGED`, PO3, public catalog unchanged)
- [x] Worker: sync and health read retail's rows and reprice every list through `repriceProducts`; the cancel-reason email label. RP5's `fixed_price_fallback` notice moves to PR 2 with the fixed-price writer (nothing sets a fixed price before it)
- [x] Bridge: OpenAPI export and admin client (the two enum additions); E2E mocks need no change
- [x] AGENTS.md commands table: the reprice command
- [ ] Wiring checklist, checks, reviewer (2 findings fixed: the release before misreads seeded list rules and list rows, so the rules arrive with `pricing:reprice-lists` and unseeded lists are not priced; tests for PO4 and the public catalog), acceptance, PR with auto-merge

## PR 2 — lists, rules, fixed prices, matrix, assignment, private prices: server and screens (branch `feat/s20-price-lists`)
- [ ] RP5 (moved from PR 1): `fixed_price_fallback` Telegram message kind and notice on entering `fixed_price_fallback`, dedupe `fixed-fallback:<list>:<product>:<Damascus date>`; daily summary line
- [ ] Contract step for PR 1's defaults: drop the retail `DEFAULT` of `margin_rules`, `product_prices` and `orders.price_list_id` once no deployed code relies on it (a release after PR 1)
- [ ] Contracts: `priceListSchema`, `createPriceListSchema`, `fixedPriceSchema`, `priceMatrixQuerySchema`, `priceMatrixSchema`, `customerPricesSchema`, rule input `priceListId`; errors `PRICE_LIST_IN_USE`, `PRICE_LISTS_LIMIT_REACHED`, `PRICE_LIST_NAME_TAKEN`, `PRICE_LIST_ARCHIVED` with Arabic texts; audit actions `price_list.*`, `customer.price_list_changed`; notification `price_list_changed`
- [ ] API pricing: lists (create under the advisory lock with ≤ 20, rename, archive per LS5), rules per list, fixed prices (archive-and-insert), matrix with warnings, preview with `priceListId`, each re-authenticated and audited (LS6), each repricing in its transaction (RP3)
- [ ] API: `PUT /api/admin/customers/:id/price-list` (AT2, AT3: customer `FOR UPDATE`, reservations cancelled, notification); `GET /api/catalog/games/:slug/prices` (`private, no-store`, session only); `GET /api/me` gains `priceKind`; receipts and share links hide non-retail prices; `store.revalidate` only for retail changes; tests (401/403, re-authentication, LS5, the public catalog identical for every list, a purchase racing an assignment)
- [ ] Bridge: OpenAPI export and admin client; E2E mocks for changed shapes
- [ ] Error texts, audit labels and notification templates so typecheck holds
- [ ] Admin: `/pricing/lists`, `/pricing/lists/$id` (rules scoped to the list with the parent's shown, fixed prices with the resulting price, assigned accounts), `/pricing/matrix` (sources, warnings, held targets, warnings-only filter), the profile's pricing card with "تغيير قائمة الأسعار", breakdown labels; navigation, i18n, states
- [ ] Store: game page and buy box overlay for non-retail kinds (skeleton, label, retry, no buy until read), cart lines at private prices, receipt and share hiding, search without prices for non-retail accounts
- [ ] E2E flows and RTL screenshots (admin light and dark, store phone dark and light)
- [ ] Wiring checklist, checks, reviewer, acceptance, PR with auto-merge

## PR 3 — merchants: server and screens (branch `feat/s20-merchants`)
- [ ] Contracts: `merchants.ts` (form enums, application schemas, `applicationTransition`, `merchantSettingsSchema`), `ACCOUNT_TYPES`, `effectiveDepositLimitSettings` merchant tier (MD1), `merchant_terms` page, `merchant_shop_photo` file kind, errors, audit actions, notifications, Telegram `merchant_application`; unit tests
- [ ] DB (`/db-migration`): `merchant_profiles`, `merchant_applications` with its guard, `merchant_application_events`, `merchant_settings` (seeded); drift
- [ ] API `merchants` module: application (create idempotent, resubmit, withdraw, photo), terms acceptance (MT2), admin queue, decisions (MA4–MA7), merchants list, settings; deposit tier (MD1–MD3), order rate (PO5), `MERCHANT_TERMS_REQUIRED` on purchase, checkout, reservation and on-behalf orders; reports breakdown by list and merchant; dashboard attention item; tests
- [ ] Worker: `merchants.expire-applications` (every 15 minutes), Telegram notices and daily summary lines; tests
- [ ] Bridge: OpenAPI export and admin client
- [ ] Store: account merchant card, `/account/merchant` four-step form with states and timeline, `/merchant-terms`, terms acceptance sheet
- [ ] Admin: applications queue and page, merchants list, profile merchant actions, `/settings/merchants`, report labels
- [ ] E2E flows and RTL screenshots
- [ ] Wiring checklist, checks, reviewer, acceptance, PR with auto-merge; `docs/ROADMAP.md` S20 done
