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
- [ ] checks, reviewer, endpoint check at `/api/docs`, PR and merge

## PR 2 — `feat/s26-shop-selling`: catalog, purchase, margin and support (server)
- [ ] contracts: storefront and game schemas with selling prices only (PR4 contract tests), purchase schema, selling price math (PR2 rounding up, PR3 guard), compensation and stats schemas, `TICKET_ESCALATION_TOO_EARLY`, `ORDER_NOT_COMPENSABLE`
- [ ] db: `shop_order_sales`, `shop_daily_stats`, `orders.shop_customer_id`, ticket columns (migration); shop purchase in `packages/db/src/orders` (PR6, `purchaseOrder`'s lock order, the shop wallet paying), finish in `orderFinished` (PR8 refund and margin release; lock the merchant's wallet before the shop customer's, as transfers do), compensation (PR10); journals balance, held margin returns to zero, races (confirm against purchase, transfer against purchase)
- [ ] api: public storefront and game reads cached by `shop:<id>` with old-slug redirects, purchase (PR5, PR7, PR12), orders and codes for the shop customer, closed-shop sales at `price_list_id_at_close`, admin compensation, tickets (TK1–TK5) with escalation, statistics (SP3) and the visit counter, the sticker PNG (SP2), manifest data and icons (SP1)
- [ ] notifications and push per shop for orders, compensation and tickets; Telegram for an escalated ticket and the return-ratio alert
- [ ] reconciliation: held margin equals the open shop orders' margins
- [ ] store revalidation on settings, hidden games, selling prices and state
- [ ] bridge: OpenAPI export and admin client
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
- [ ] admin: shops page and shop page (approve, reject, states, limits, rate history, customers, freeze, settle), the order page's shop compensation, escalated tickets with the shop tag
- [ ] E2E flows and RTL screenshots (merchant phone, admin light and dark)
- [ ] the local seed's shop
- [ ] checks, reviewer, browser check of the spec's Acceptance, PR and merge
- [ ] production deploy, health checks, the deploy log
