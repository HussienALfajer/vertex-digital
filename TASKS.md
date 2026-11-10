# TASKS — S26 Merchant shops with customer wallets (F45)

Spec: `docs/specs/S26-merchant-shops.md` (Approved 2026-11-10) · ADR 0040 (amends 0003, 0007, 0035, 0036).
No production deploy before PR 4 merges (the shop has no screens until then); the deploy carries all four PRs.

## PR 1 — `feat/s26-shop-wallets`: shops, the shop customer realm and shop wallets (server)
- [x] Better Auth proof first (ADR 0040): proven on 1.7.7 with a scoped adapter around the memory adapter (2026-11-11): the same email in two shops, a wrong-shop password fails as a wrong one, a shop's session refused on another shop. The session lookup joins its user, so sessions carry `shop_id` and are scoped too; no shop in context throws
- [x] contracts: `shops.ts` (shop states and transitions, slug rules and reserved words, the contrast check and the 12 colors, rate rules with the 10% band, transfer and return math, caps), schemas with `.meta({ id })`, error codes (`SHOP_*`, `RETURN_REQUEST_*`) with their texts, audit actions, actor `shop_customer` and entity types with labels, the job `shop.return-requests-expire`, ledger and journal kinds (statement, wallet and ledger-summary labels), merchant events and shop emails (push texts, templates, sender name); unit tests at 100% coverage
- [x] db through `/db-migration` (migrations 0112–0113): `merchant_shops`, `merchant_shop_slugs`, `merchant_shop_rates`, `merchant_shop_hidden_games`, the shop auth tables (sessions carry `shop_id`, keyed to their user's shop), `shop_transfers`, `shop_return_requests`, `shop_settlements` (WL9: a cash settlement is an `adjustment` journal, which C9 needs a row for); ledger kinds and `ledger_accounts.shop_customer_id`; guards (states table, return requests end once, shop customers never deleted), append-only triggers and revokes; `TABLE_OWNERS`. `shop_order_sales`, `shop_daily_stats`, `orders.shop_customer_id` and the ticket columns move to PR 2 with their code
- [x] db write paths (`packages/db/src/shops`): transfer (WL1–WL4, merchant wallet then shop wallet), return request and its ends (WL5, WL6; the shop's lock before the request's), expiry batch, settlement (WL9), close (SH7) called by `revokeMerchant`; wallets in `postJournal`; ledger summary `owedToShopCustomersUnits`; reconciliation C9 for shop transfers and settlements; tests with races and replays
- [x] api `shops` module: merchant request and settings (SH1–SH3, ST1–ST6), hidden games, customers (CA1, CA3, CA6–CA9), invitations, transfers with the 15-minute password or passkey check, return requests; admin review, states, limits, settlement, customer freeze; shop customer auth (CA2, CA4), me and wallet, return confirm and decline; realm separation tests (shop A, shop B, Vertex, admin)
- [x] `revokeMerchant` closes the shop in its transaction (SH7)
- [x] worker: `shop.return-requests-expire`, the shop realm in `auth.purge-expired`; tests
- [x] notifications and emails for transfers, returns, invitations, OTP, reset, shop decisions; Telegram for a request and a closed shop with balances (the shop customers' notification center and push move to PR 2 with the orders)
- [x] reconciliation: C9 checks every shop transfer and settlement against its journal; no `shop_transfer` journal without its row
- [x] rate limits (API, and nginx: the shop auth paths and the transfer check on `vdsignin`, transfers and return requests on `vdpurchase`; the deploy re-runs `provision.sh`), ALTCHA on sign-up and code requests
- [x] bridge: OpenAPI export and admin client
- [x] docs: architecture (module, jobs, auth), API, db and contracts folder rules, spec details settled, ADR 0040 (sessions scoped), ROADMAP
- [x] checks, reviewer (3 blocking findings fixed: a closed shop's slug kept while it holds balances, a full shop answering every sign-up alike, C3 over shop wallets), endpoint check at `/api/docs`, PR and merge

## PR 2 — `feat/s26-shop-selling`: catalog, purchase, margin and support (server)
Settled while planning (2026-11-11): the undelivered units' refund posts `refunds:USD` −buy·n like every refund (the spec's `sales_revenue` is the same reversal; C7 reads it); a compensation gets its own append-only `shop_compensations` row (C9 needs a row per `adjustment` journal); shop customers get their own notification center and push devices (`shop_customer_notifications`, `shop_push_subscriptions`); shop orders write no `merchant_order_sales` row (the merchant's dashboard and statement kinds come with PR 4); the merchant's own order reads, reveals, releases, receipts and tickets leave shop orders out; a shop customer's code reveal is logged as `customer` with the shop customer's id. The admin's support queue and order page for shop tickets and compensation screens stay in PR 4 (the queue joins customers, so shop tickets stay out until then); the shop receipt (PR11) comes with PR 3's order page.
- [ ] contracts: `shop-selling.ts` (PR2 selling price rounding up, ST4 SYP, PR3 guard, the order and refund amounts, PR10 compensation, TK2 escalation, the return-ratio alert, storefront, game, purchase, order, compensation, stats, manifest, sticker schemas with selling prices only), shop notification events and params, error codes `TICKET_ESCALATION_TOO_EARLY`, `ORDER_NOT_COMPENSABLE`, audit actions, the ticket author `merchant`; unit tests at 100%
- [ ] db (migration): `shop_order_sales`, `shop_compensations`, `shop_daily_stats`, `shop_customer_notifications`, `shop_push_subscriptions`, `orders.shop_customer_id`, ticket columns (`shop_id`, `shop_customer_id`, `escalated_at`, `last_merchant_message_at`, nullable `customer_id`); guards (append-only, fixed sale row but its release once, orders' shop customer fixed)
- [ ] db write paths: `purchaseShopOrder` (PR5–PR7; `purchaseOrder`'s lock order with the shop customer's wallet paying), the refund of a shop order (merchant's wallet locked first) and the margin release in `orderFinished` (PR8), shop order notifications (PR9), `compensateShopOrder` (PR10), `notifyShopCustomer` (center, email, push) with PR 1's emails moved onto it; reads for the shop customer's orders and codes; the merchant's own order reads skip shop orders; tests: every journal balances, held margin back to zero, races (transfer against purchase, confirm against purchase), replays
- [ ] reconciliation: C4 kinds, C6/C7 for shop orders, the held-margin check (C10)
- [ ] api: public storefront and game (cached by `shop:<id>`, old slugs answer `301`), purchase, orders, codes, player check (the shop customer's quota and the shop's), notifications and push devices, tickets (TK1–TK5) for the shop customer and the merchant with escalation and its Telegram, admin compensation, statistics (SP3) and the visit counter, sticker PNG (SP2), manifest and icons (SP1), the return-ratio alert
- [ ] store revalidation of `shop:<id>` on settings, hidden games, selling prices and state
- [ ] worker: push to shop devices
- [ ] bridge: OpenAPI export and admin client
- [ ] docs: spec details settled, architecture, folder rules, ROADMAP
- [ ] checks, reviewer, endpoint check at `/api/docs`, PR and merge

## PR 3 — `feat/s26-shop-store`: the shop under `/s/[slug]`
- [ ] the shop layout (brand color, logo or letter mark, bottom bar, footer, `noindex`, robots), home, game with the buy box, wallet with return requests, orders and order page, support with escalation, account
- [ ] sign-in, sign-up (ALTCHA, OTP), verify, reset, invitation in the shop's branding
- [ ] PWA per shop (manifest, scoped service worker, install) and push
- [ ] i18n keys, error texts, loading, empty and error states
- [ ] E2E flow and RTL screenshots (phone, light and dark)
- [ ] checks, reviewer, browser check, PR and merge

## PR 4 — `feat/s26-shop-panels`: merchant area and admin panel, then the deploy
- [ ] merchant area "متجري": request with live preview, settings, customers with transfer and return, shop orders, shop tickets, statistics, sticker, statement kinds (WL10)
- [ ] admin: shops page and shop page (approve, reject, states, limits, rate history, customers, freeze, settle), the order page's shop compensation, escalated tickets with the shop tag (the admin queue's and ticket page's API for shop tickets: the shop customer, the shop tag, admin replies telling the shop customer and the merchant)
- [ ] the merchant dashboard's sales and profit and the statement kinds with the shop's delivered orders (WL10)
- [ ] E2E flows and RTL screenshots (merchant phone, admin light and dark)
- [ ] the local seed's shop
- [ ] checks, reviewer, browser check of the spec's Acceptance, PR and merge
- [ ] production deploy, health checks, the deploy log
