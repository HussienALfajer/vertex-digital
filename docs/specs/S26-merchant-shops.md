# S26 — Merchant shops with customer wallets (F45)

Status: Approved (owner, in chat, 2026-11-10) · Date: 2026-11-10 · Scope: `docs/product/v1-scope.md` §F45 (Phase M) · ADRs: 0003, 0004, 0006, 0007, 0008, 0011, 0012, 0020, 0026, 0029, 0035, 0036, 0038, 0039, 0040 (new)

## Summary
A merchant sells today only at the counter. S26 gives an approved merchant a **shop**: a public link `/s/<slug>` (with a QR sticker) in the merchant's name, logo and brand color, where the merchant's retail customers hold their own wallet, see the merchant's selling prices in SYP at the merchant's own exchange rate, and buy top-ups that Vertex fulfils automatically. The merchant funds a customer's wallet from the merchant's own balance after collecting cash, returns balance with the customer's confirmation, answers the shop's tickets first, and earns the margin on each delivered order. Vertex stays the seller of record to the merchant, so the fulfilment, the margin guard and the supplier flows are unchanged.

## Owner decisions (interview, 2026-11-10)
1. **Model:** a full shop with customer wallets (not order requests the merchant pays).
2. **Customer accounts:** both ways: the merchant creates the account at the counter, or the customer signs up from the shop's link. Each account belongs to one shop only, apart from Vertex's accounts.
3. **Sign-in:** a verified email for every account (the merchant's invitation or the sign-up OTP verifies it), with a password.
4. **Same email elsewhere:** allowed: an email may hold a Vertex account and an account in each shop, each with its own password; nothing tells anyone the email is registered elsewhere.
5. **Wallet currency:** USD, like every wallet; the shop shows it SYP first at the shop's rate, USD beside it. A rate change changes the SYP figure.
6. **Shop exchange rate:** free, with a warning and a typed confirmation when it is more than 10% from the store's rate. With none set, the shop follows the store's rate.
7. **Funding:** the merchant moves balance from the merchant's wallet to a customer's wallet. Limits: a customer's balance at most $200, a merchant's transfers to customers at most $1,000 a Damascus day; the admin changes both per shop.
8. **Returning balance:** the merchant asks to return an amount, the customer confirms it in the shop, and it moves back to the merchant's wallet. The merchant pays the customer cash outside the system. Both steps are recorded.
9. **Margin:** the customer is charged the selling price at purchase. The merchant's margin reaches the merchant's wallet only when the order finishes, for delivered units only. A failed or undelivered unit refunds its full selling price to the customer. A compensation after delivery: Vertex returns its price (the merchant's purchase price), and the merchant returns the margin.
10. **Frozen or revoked merchant:** the customers keep buying with their balance at the merchant's last prices. New transfers and sign-ups stop. The admin sees the balances and can settle them.
11. **Eligibility:** an approved merchant requests a shop; the admin approves each one and sets its limits.
12. **Branding:** the merchant's name and logo lead. One brand color (12 ready colors, or any color that passes the contrast check), in light and dark themes. A small "يعمل بـ VERTEX DIGITAL" line in the footer, with no link to the Vertex store.
13. **Support:** the merchant answers the shop's tickets first and escalates delivery problems to the admin. The customer can escalate a ticket the merchant left unanswered for 24 hours.
14. **Catalog:** everything the merchant can buy is shown at the merchant's selling prices, except the games the merchant hides; the merchant's pinned games come first.
15. **Slug:** the merchant proposes it (Latin letters) with the request; the admin approves it. A change goes through a ticket, and the old slug redirects to the new one forever.
16. **Extras in V1:** the shop as an installable app (PWA) with the merchant's name and logo and order push notifications; a printable QR sticker; shop statistics in the merchant area; a text announcement from the merchant on the shop's home page.

Defaults chosen in the spec (flag in review if wrong):
- A shop order counts toward the merchant's monthly tier purchases at the merchant's purchase price (S23); it is the merchant's purchase from Vertex.
- A transfer asks for the merchant's password, or a passkey, once per 15 minutes.
- A return request expires after 24 hours.
- The announcement is at most 200 characters, with no links.
- At most 2,000 customers per shop.
- F44 cash products are not sold in shops; credit and bills are, with the retail section limits.

## In scope / out of scope
- In:
  - The shop request, its review, the shop's states and the admin's limits (SH1–SH8).
  - The shop's settings: slug, brand color, logo (the receipt logo of S21), exchange rate, announcement, hidden games (ST1–ST6).
  - Shop customer accounts and their own authentication, invitations and sign-up (CA1–CA9).
  - Shop wallets, transfers, returns, limits (WL1–WL10).
  - The shop's catalog and prices, the purchase and the order's life, the margin's release, refunds and compensation (PR1–PR12).
  - Shop tickets with escalation (TK1–TK5), notifications, PWA and push, the sticker, statistics.
  - The admin's shops page, settlement of a closed shop's balances, reports and reconciliation.
- Out, later or never:
  - Custom domains.
  - Carts, reservations (`awaiting_balance`), gifts, saved player IDs beyond the last 10 per game, quick links, share links and passkeys for shop customers.
  - Direct deposits (Sham Cash, USDT) by shop customers: only the merchant funds a wallet.
  - Cash products (F44 cash).
  - Merchant staff accounts.
  - More than one brand color, custom fonts or CSS.
  - Search engine indexing of shops.
  - Moving a customer between shops, or between a shop and Vertex.

## Access
| Action | Route kind | Who |
|---|---|---|
| Request a shop, read and change its settings | Merchant | A merchant with accepted terms, not frozen; changes while the shop is `requested`, `active` or `suspended` |
| Create a customer, invite again, transfer, request a return | Merchant | The shop's merchant, not frozen, shop `active`; a transfer needs a password or passkey check within 15 minutes |
| Read the shop's customers, orders, tickets, statistics | Merchant | The shop's merchant, in any shop state but `rejected` |
| Reply to and escalate a shop ticket | Merchant | The shop's merchant |
| Read the shop's home, games and prices | Public, cached per shop | Anyone, shop `active`, `suspended` (read-only banner) or `closed` |
| Sign up | Shop public, ALTCHA | Anyone, shop `active` |
| Sign in, verify email, reset password | Shop public, rate limited | The shop's customers |
| Read own wallet, orders, tickets; buy; confirm a return; open, reply to and escalate a ticket | Shop customer | A signed-in, verified customer of this shop, not frozen; purchases while the shop is `active` or `closed` with balance |
| Review requests, approve a slug, change limits, suspend, resume, close, settle balances, freeze a shop customer | Admin; re-authentication for limits, close and settle | The admin |
| Read every shop, its customers, orders, wallets and tickets | Admin | The admin |

A shop customer's session never reaches a Vertex customer route, and a Vertex session never reaches a shop customer route. A session for shop A is signed out on shop B's routes.

## Data
All tables follow ADR 0011: UUIDv7 ids, `timestamptz`, `bigint` money units, indexed foreign keys.

**`merchant_shops`** (one per merchant, archived, never deleted)
- `id`, `merchant_id` → `customers.id` unique, `slug` text unique (3–30, `^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$`, not reserved), `status` enum `shop_status` (`requested`, `active`, `suspended`, `closed`, `rejected`), `display_name` (the merchant's approved trade name, copied on approval), `brand_color` text (`^#[0-9a-f]{6}$`), `announcement` text null (1–200), `rate_mode` enum (`store`, `own`), `customer_balance_cap_usd_units` (default 200 USD), `daily_transfer_cap_usd_units` (default 1,000 USD), `customer_limit` integer (default 2,000), `price_list_id_at_close` uuid null (SH7), `reject_reason`, `suspend_reason` (the category the shop shows: `review`, `complaints`, `payments`, `other`), `suspend_note` (the admin's text, never shown to customers; settled in PR 1), `requested_at`, `decided_at`, `closed_at`, timestamps.
- Checks: caps whole cents, positive; a reason with `rejected` and `suspended`.

**`merchant_shop_slugs`** (append-only): `slug` primary key, `shop_id`, `merchant_id`, `created_at`. Every slug a shop ever held (written on approval and on the admin's slug change), so an old slug redirects and is never taken by another merchant; the same merchant's new request may take it again (SH7).

**`merchant_shop_rates`** (append-only): `id`, `shop_id`, `rate_syp_per_usd` numeric (>0), `store_rate_id` → `exchange_rates.id` (the store rate when set), `confirmed_far` boolean, `created_at`. The newest row is in force while `rate_mode = own`.

**`merchant_shop_hidden_games`**: `(shop_id, game_id)` primary key, `created_at`. Deleted when unhidden (a preference, not a business record; `NOT_BUSINESS_RECORDS`).

**Shop auth tables** (a separate Better Auth instance, ADR 0040): `shop_customers` (`id`, `shop_id`, `name`, `email` lowercased, `email_verified`, `phone` E.164, `created_by` enum (`merchant`, `self`), `frozen_at`, `terms_version_id`, `privacy_version_id`, timestamps, `archived_at`; unique `(shop_id, email)`), `shop_customer_sessions` (with `shop_id`, keyed to its user's shop: Better Auth reads a session with its user in one query, so the adapter scopes sessions as well as users; settled by the PR 1 proof), `shop_customer_accounts`, `shop_customer_verifications`. Rate limits reuse `customer_rate_limits` with a `shop:` key prefix. The instance's secret is derived from `CUSTOMER_AUTH_SECRET`, so no new value is provisioned.

**Ledger** (ADR 0003, amended by 0040)
- New account kinds: `shop_customer_wallet` (USD, one per shop customer, `shop_customer_id` set on, and only on, it; same rules as `customer_wallet`: whole cents, never below zero) and `shop_margin_held` (system, USD, one account `shop_margin_held:USD`).
- New journal kinds: `shop_transfer` (funding and return) and `shop_margin` (release at finish, and the margin part of a compensation).
- `ledger_accounts` gets `shop_customer_id` → `shop_customers.id` null, with the check that it is set exactly on `shop_customer_wallet`.

**`shop_transfers`** (append-only)
- `id`, `shop_id`, `shop_customer_id`, `cause` (`transfer`, `return`), `direction` (`to_customer`, `to_merchant`), `amount_usd_units` (whole cents), `entered_currency` (`usd`, `syp`), `entered_amount_units`, `rate_syp_per_usd` numeric null (with SYP), `journal_id` unique, `return_request_id` null, `idempotency_key` uuid unique, `created_at`.

**`shop_settlements`** (append-only, settled in PR 1): `id`, `shop_id`, `shop_customer_id`, `target` (`merchant`, `cash_refund`), `amount_usd_units`, `journal_id` unique, `idempotency_key` uuid unique, `admin_id`, `created_at`. One row per settlement (WL9), whichever journal it posts: reconciliation C9 needs a row for every `adjustment` journal, and a cash settlement is one. The journal key is `shop-settle:<customer>:<idempotency key>`.

**`shop_return_requests`**: `id`, `shop_id`, `shop_customer_id`, `amount_usd_units`, `status` (`pending`, `confirmed`, `declined`, `expired`, `cancelled`), `expires_at`, `decided_at`, `idempotency_key` unique, timestamps. A guard allows only `pending` → another state, once. At most one `pending` per customer (partial unique index).

**`shop_order_sales`** (one per shop order, fixed after insert except `margin_released_usd_units` once)
- `order_id` → `orders.id` primary key, `shop_id`, `shop_customer_id`, `unit_sell_usd_units` (whole cents), `unit_buy_usd_units` (the order's unit price), `quantity`, `sell_currency` (`usd`, `syp`), `unit_sell_entered_units`, `rate_syp_per_usd` numeric, `margin_released_usd_units` null, `created_at`.
- The order itself is the merchant's order (`orders.customer_id` = the merchant, the merchant's effective list and price) with `orders.shop_customer_id` (new nullable column, fixed) naming the buyer.

**`shop_daily_stats`**: `(shop_id, damascus_date)` primary key with `visits`, `sign_ups`; counters only, no personal data, no IPs.

**Tickets:** `support_tickets` gets `shop_id` null and `shop_customer_id` null (exactly one of `customer_id` or `shop_customer_id`), and `escalated_at` null. Messages carry the author kind `merchant` besides `customer` and `admin`.

## States and rules

### Shop states
| From | To | By | Effect |
|---|---|---|---|
| — | `requested` | Merchant | Slug, color and rate saved; the admin is told (Telegram, panel queue) |
| `requested` | `active` | Admin | Limits set; `display_name` copied; the merchant is told |
| `requested` | `rejected` | Admin, reason | The merchant may request again after 7 days |
| `active` | `suspended` | Admin, reason | Read-only shop: no sign-up, transfer, return or purchase; balances kept |
| `suspended` | `active` | Admin | |
| `active`, `suspended` | `closed` | Admin, re-auth; automatically on merchant revocation | SH7 |
| `closed` | — | | Final |

- **SH1** A merchant has at most one shop. A `rejected` shop row is archived when the merchant requests again.
- **SH2** Slug rules: lowercase Latin letters, digits and inner hyphens, 3–30 characters. It may not be a reserved word (`admin`, `api`, `vertex`, `digital`, `support`, `help`, `login`, `shop`, `store`, and the store's top-level route names) and may not be a slug any shop ever held (`merchant_shop_slugs`). A taken slug is refused with `SLUG_TAKEN`.
- **SH3** The admin may edit the slug before approving. After approval only the admin changes it (the merchant asks through a ticket). The old slug stays in `merchant_shop_slugs` and `/s/<old>` redirects permanently to `/s/<new>`.
- **SH4** A merchant freeze (S12) does not suspend the shop: the merchant cannot transfer or request returns, and the customers keep buying (decision 10).
- **SH5** A shop customer can buy only while the merchant's account still exists as a merchant or the shop is `closed` (SH7).
- **SH6** Suspending writes `suspend_reason`. The shop shows "المتجر متوقف مؤقتاً" with the reason category, never the admin's text.
- **SH7** On merchant revocation (`revokeMerchant`), in the same transaction, the shop becomes `closed`, and `price_list_id_at_close` stores the merchant's effective list at that moment. A `closed` shop keeps selling to customers with a balance at the merchant's selling settings and that stored list, until the admin settles every balance (WL9). It allows no transfer, return request or sign-up. Re-granting merchant status does not reopen it: the merchant requests a new shop (the old slug stays reserved for that merchant's new request only).
- **SH8** The admin's per-shop limits: the customer balance cap ($1–$5,000), the daily transfer cap ($10–$50,000) and the customer limit (1–20,000). A lowered balance cap never takes money from a wallet; it stops transfers above it.

### Shop settings
- **ST1** The brand color is a hex color. It is accepted when white text on it has a contrast ratio of at least 4.5:1 and it reaches at least 3:1 against both theme backgrounds (`brand/identity.md` tokens). Otherwise it is refused with `VALIDATION_FAILED` naming the reason. The 12 ready colors pass by construction (a contracts test). The shop's other tokens stay the design system's.
- **ST2** The logo is the merchant's receipt logo (S21, ≤1 MB, the files pipeline). The shop shows it in color; receipts keep printing it in black and white. Without a logo the shop shows the shop name's first letter on the brand color.
- **ST3** Exchange rate: `rate_mode = store` follows the store's current rate. `own` uses the newest `merchant_shop_rates` row. Saving a rate more than 10% from the store's current rate (either way) needs `confirmFar: true` and the typed word «أؤكد» in the screen. Every rate change appends a row and an audit entry. With no store rate and `rate_mode = store`, the shop shows USD only and transfers take USD only.
- **ST4** SYP display: a USD amount × the shop's rate, rounded up to the merchant's SYP step (S21 SP1; the store's display step by default). A price set in SYP shows as set.
- **ST5** The announcement is plain text of 1–200 characters. A URL, `www.` or an email address in it is refused. Phone numbers are allowed. The admin can clear it (audited).
- **ST6** Hidden games: any game; hidden games and their packs never show or sell in the shop. At most 2,000 hidden.

### Shop customer accounts
- **CA1** The merchant creates an account with name, email and phone (E.164). The customer receives an invitation email with a link valid 72 hours to set a password, which also verifies the email. "إعادة إرسال الدعوة" at most 3 times a day per customer.
- **CA2** Self sign-up on `/s/<slug>/sign-up`: name, email, phone, password (the S01 password rules), acceptance of the shop terms. ALTCHA and the sign-up rate limits of S01 per IP and per shop. The email is verified by OTP before the customer is signed in for buying.
- **CA3** The email is unique per shop (`(shop_id, email)`). A second account with the same email in the same shop is refused with `EMAIL_TAKEN` only to the merchant. The self sign-up answers as S01 does (no enumeration).
- **CA4** Sign-in by email and password, with the S01 limits and lockouts. Password reset by email, scoped to the shop.
- **CA5** The shop's terms: the store's merchant-shop terms page (a versioned content page, F21), shown with the shop's name. The privacy page is the store's.
- **CA6** A shop at its customer limit refuses new accounts with `SHOP_CUSTOMER_LIMIT_REACHED` (the sign-up says the shop is not accepting new customers).
- **CA7** The admin may freeze and unfreeze a shop customer (reason, audited). A frozen customer cannot buy, confirm a return or receive a transfer. The merchant sees "موقوف" without the reason.
- **CA8** The merchant edits a customer's name and phone. The email can change only by the customer, with OTP on the new address.
- **CA9** A shop customer's account is archived, never deleted. Archiving needs a zero balance and no open order or pending return.

### Wallets, transfers and returns
- **WL1** A transfer moves an amount from the merchant's wallet to the customer's wallet: one `shop_transfer` journal (merchant `customer_wallet` −X, `shop_customer_wallet` +X). Key `shop-transfer:<idempotency key>`.
- **WL2** The merchant enters the amount in USD (whole cents) or SYP (whole pounds) at the shop's current rate. X = the SYP amount ÷ rate, rounded **down** to whole cents. The screen shows X before confirming. The rate and the entered amount are stored. Minimum $0.10.
- **WL3** Under the locks (merchant customer row, the merchant wallet, then the shop customer's wallet): the merchant's balance covers X; the customer's balance + X ≤ the shop's balance cap; the merchant's transfers to customers today (Damascus) + X ≤ the daily cap. Refusals: `INSUFFICIENT_BALANCE`, `SHOP_BALANCE_CAP_EXCEEDED` (with the largest allowed amount), `SHOP_DAILY_TRANSFER_CAP_EXCEEDED` (with what is left today).
- **WL4** A transfer needs the shop `active`, the merchant not frozen, the customer verified and not frozen. Since a transfer is real money, it needs a password or passkey check within the last 15 minutes (`REAUTHENTICATION_REQUIRED`).
- **WL5** A return request: the merchant asks for X ≤ the customer's current balance. The customer sees it at the top of the shop and in the notification center. "تأكيد" moves X back: customer −X, merchant +X, `shop_transfer` journal, key `shop-return:<request id>`. "رفض" declines it. It expires after 24 hours (a job). At most one pending request per customer.
- **WL6** Confirming re-checks the customer's balance under the wallet lock. If the balance fell below X (a purchase in between), the confirm is refused with `INSUFFICIENT_BALANCE` and the request stays pending until it expires or the merchant cancels it.
- **WL7** Returns do not restore the daily transfer cap and are not limited by it.
- **WL8** A shop customer cannot transfer to anyone, withdraw, or deposit by any method. The only credits are a transfer, a refund, a compensation and an admin adjustment.
- **WL9** Settlement of a closed shop: the admin moves a customer's whole balance either back to the merchant's wallet (the merchant agreed to pay the customer cash; `shop_transfer`, key `shop-settle:<customer>:<n>`) or to the store's `adjustments` account (the owner pays the customer cash outside the system, as ADR 0003's exceptional cash refund). Each needs re-authentication, a reason and an audit entry, and the customer is notified. When every balance is zero and no order is open, the shop is fully settled (shown in the panel).
- **WL10** The merchant's statement (S21 ST) lists transfers out, returns in and margin credits as their own kinds. The dashboard's sales and profit include the shop's delivered orders.

### Catalog, price and purchase
- **PR1** The shop shows every game and pack the merchant can buy (the merchant's effective list, or `price_list_id_at_close` once closed; S23 early access included), minus hidden games, minus F44 cash products. Pinned games come first (S21 amendment 4), then the store's categories.
- **PR2** A pack's unit selling price in USD is the merchant's selling price (S21 SP1–SP3). A per-product price wins. A SYP price converts at the shop's rate: ÷ rate, rounded **up** to whole cents. Otherwise the merchant's purchase price × (1 + markup), rounded **up** to whole cents. Without a markup and an own price, the selling price equals the purchase price.
- **PR3** **Margin guard:** a pack whose selling price is below the merchant's current purchase price is not sold in the shop ("غير متوفر حالياً"). The merchant's prices page already flags it ("تحت التكلفة"). Margin = (sell − buy) × units ≥ 0.
- **PR4** The shop never shows the merchant's purchase price, the margin, the list's name or Vertex's retail price.
- **PR5** The purchase: one product, quantity within the product's customer limit, the game's fields and the player check (S09, the shop customer's quota of 10 an hour; a confirmation for an unfound or unchecked ID), the slide to confirm. The request carries the expected unit selling price in USD. A different current price is refused with `PRICE_CHANGED` and the new price.
- **PR6** In one transaction (copying `purchaseOrder`'s lock order, with the shop customer's wallet as the paying wallet): the merchant's order at the merchant's list price, `orders.shop_customer_id`, the `shop_order_sales` row, the fulfilment job, the audit entry, and one `purchase` journal: `shop_customer_wallet` −sell×qty, `sales_revenue` +buy×qty, `shop_margin_held` +margin. Key `order:<id>:purchase`. The merchant's wallet is not touched. `afterMerchantPurchase` counts buy×qty for the merchant's tier (default above).
- **PR7** Store switches (F26), the shop's state and a frozen shop customer refuse the purchase (`PURCHASES_STOPPED`, `SHOP_UNAVAILABLE`, `ACCOUNT_FROZEN`). F44 credit and bills apply their retail section limits to the shop customer (per shop customer; the per-number counts are global as in S25).
- **PR8** **Finish:** when the order reaches a terminal state, in `orderFinished`'s transaction: for the undelivered units, one refund journal (`sales_revenue` −buy×n, `shop_margin_held` −margin×n, `shop_customer_wallet` +sell×n). For the delivered units, one `shop_margin` journal (`shop_margin_held` −margin×d, the merchant's `customer_wallet` +margin×d), key `shop-margin:<order id>`, none when the margin is 0. `margin_released_usd_units` is set once. A frozen merchant's wallet still receives it.
- **PR9** The shop customer receives the order's notifications (S08, S15 push) through the shop's channel. The merchant gets no notification per order; the order appears in the merchant's shop orders. Shop orders are kept out of the merchant's own order list and receipts, and are shown in "طلبات المتجر".
- **PR10** **Compensation after delivery** (the 7-day report window, Q10): the admin compensates a shop order through the order's page (re-authentication, reason). It posts Vertex's part as an adjustment (`adjustments` −buy×n, `shop_customer_wallet` +buy×n). With the merchant's margin released, it posts the margin part (merchant `customer_wallet` −margin×n, `shop_customer_wallet` +margin×n, `shop_margin` journal, key `shop-margin-back:<compensation id>`) when the merchant's balance covers it. Otherwise the admin chooses to post Vertex's part only (the shop ticket tells the merchant what is owed) or to cover the margin as an adjustment. Audited, the customer and the merchant are notified.
- **PR11** The receipt and verification (S21 F35) of a shop order carry the shop's name and logo and the selling price; the verification page reads as for a merchant's order.
- **PR12** Codes (code products): the shop customer reveals them in the order like a customer (S08 reveal log); quantity within the product's customer limit.

### Tickets
- **TK1** A shop customer opens a ticket from the shop (order problem buttons of S22 included). It goes to the merchant's "تذاكر المتجر". The merchant is told in the notification center and by push.
- **TK2** The merchant replies and may escalate to the admin at any time with a note. The customer may escalate after 24 hours without a merchant reply ("طلب تدخل الإدارة"). Escalation sets `escalated_at` and puts the ticket in the panel's support queue with the shop's tag.
- **TK3** After escalation the admin, the merchant and the customer all see and reply in the ticket. The customer sees the replier as "المتجر" or "فريق الدعم".
- **TK4** The merchant sees the shop customer's name, email, phone and orders. The admin sees everything.
- **TK5** Ticket limits are S12's per shop customer.

### Shop pages, PWA, sticker, statistics
- **SP1** `/s/<slug>/manifest.webmanifest` with the shop name, the logo (192 and 512 px, generated by the server from the logo, or the letter mark) and the brand color. The service worker scope is `/s/<slug>/`. Push (S15) for the shop customer's order and balance events.
- **SP2** The sticker: a server-rendered PNG (A6 and 80 mm), with the logo, the shop name, the brand color, the QR to `https://digital.vertexmedia.pro/s/<slug>` and "اشحن ألعابك من متجرنا". At most 20 an hour.
- **SP3** Statistics: by Damascus day and month, visits to the shop's pages (a counter per page view of `/s/<slug>`, bots excluded by user agent, no personal data), sign-ups, active customers (bought in the period), orders, sales (selling price), margin released, transfers and returns.
- **SP4** Every `/s/*` page sends `noindex`. Shops are not in the sitemap, and the robots file disallows `/s/`.

## Money flows
| Event | Journal (kind, key) | Postings (USD units) | Reversed by |
|---|---|---|---|
| Transfer to a customer | `shop_transfer`, `shop-transfer:<key>` | merchant `customer_wallet` −X · `shop_customer_wallet` +X | A confirmed return (a new journal) |
| Return confirmed | `shop_transfer`, `shop-return:<request>` | `shop_customer_wallet` −X · merchant `customer_wallet` +X | A new transfer |
| Shop purchase | `purchase`, `order:<id>:purchase` | `shop_customer_wallet` −S · `sales_revenue` +B · `shop_margin_held` +(S−B) | Refund at finish (PR8) |
| Undelivered units at finish | `refund`, the order's refund key | `refunds` −B·n · `shop_margin_held` −(S−B)·n · `shop_customer_wallet` +S·n | None (final) |
| Margin release at finish | `shop_margin`, `shop-margin:<order>` | `shop_margin_held` −(S−B)·d · merchant `customer_wallet` +(S−B)·d | Compensation's margin part |
| Cost of goods | unchanged (ADR 0027) | | |
| Compensation, Vertex's part | `adjustment`, `shop-compensation:<id>` | `adjustments:compensation` −B·n · `shop_customer_wallet` +B·n (the margin too when the store covers it) | A reversing adjustment |
| Compensation, margin part | `shop_margin`, `shop-margin-back:<id>` | merchant `customer_wallet` −(S−B)·n · `shop_customer_wallet` +(S−B)·n | None |
| Settlement to the merchant | `shop_transfer`, `shop-settle:<customer>:<n>` | `shop_customer_wallet` −all · merchant `customer_wallet` +all | None |
| Settlement as a cash refund | `adjustment` | `shop_customer_wallet` −all · `adjustments` +all | None |

Settled in PR 2: a refund posts `refunds` −B·n like every order's refund (the reversal of the sales revenue; C7 reads it); each compensation has its append-only `shop_compensations` row (C9 needs a row for every `adjustment` journal), and the admin's margin choice is `merchant`, `store` or `none`.

S = sell × quantity, B = buy × quantity (the order's price), both whole cents. Every rate is stored on its row (`shop_transfers`, `shop_order_sales`). `shop_margin_held:USD` is zero for every finished order: the nightly reconciliation (S13) checks that the held account equals the open shop orders' margins, and that the sum of `shop_customer_wallet` balances equals the shop wallets' postings.

## API
| Method and path | Access | Request | Response | Error codes |
|---|---|---|---|---|
| `GET /api/merchant/shop` | Merchant | — | `merchantShopStateSchema`: `{ shop }`, the `merchantShopSchema` (state, settings, limits, today's transfer total) or `null` | |
| `GET /api/merchant/shop/slug-available` · `GET·PUT /api/merchant/shop/hidden-games` · `PATCH /api/merchant/shop/customers/:id` | Merchant | slug / `{ gameIds }` / name and phone | availability / ids / row | |
| `POST /api/merchant/shop/transfer-check` | Merchant | `{ password }` | `{ checkedUntil }` (15 minutes for this session; a session signed in within 15 minutes counts too) | `INVALID_PASSWORD`, `RATE_LIMITED` |
| `POST /api/merchant/shop` | Merchant, `Idempotency-Key` | `requestShopSchema` (slug, color, rate mode and rate) | `merchantShopSchema` | `SLUG_TAKEN`, `SHOP_STATE_INVALID`, `VALIDATION_FAILED` |
| `PATCH /api/merchant/shop` | Merchant | `shopSettingsSchema` (color, announcement, rate with `confirmFar`) | `merchantShopSchema` | `SHOP_RATE_CONFIRMATION_REQUIRED`, `VALIDATION_FAILED` |
| `PUT /api/merchant/shop/hidden-games` | Merchant | `{ gameIds }` | `{ gameIds }` | `NOT_FOUND`, `VALIDATION_FAILED` |
| `GET /api/merchant/shop/customers` | Merchant | list query (search, sort, cursor; ADR 0011) | page of `shopCustomerRowSchema` (with balance) | |
| `POST /api/merchant/shop/customers` | Merchant, `Idempotency-Key` | `createShopCustomerSchema` | `shopCustomerRowSchema` | `EMAIL_TAKEN`, `SHOP_CUSTOMER_LIMIT_REACHED`, `SHOP_UNAVAILABLE` |
| `POST /api/merchant/shop/customers/:id/invite` | Merchant | — | `204` | `RATE_LIMITED`, `CUSTOMER_STATE_INVALID` |
| `POST /api/merchant/shop/customers/:id/transfers` | Merchant, `Idempotency-Key`, re-check | `shopTransferSchema` (currency, amount, expected USD) | `shopTransferResultSchema` | `INSUFFICIENT_BALANCE`, `SHOP_BALANCE_CAP_EXCEEDED`, `SHOP_DAILY_TRANSFER_CAP_EXCEEDED`, `REAUTHENTICATION_REQUIRED`, `ACCOUNT_FROZEN`, `PRICE_CHANGED` (rate changed) |
| `POST /api/merchant/shop/customers/:id/return-requests` · `DELETE …/:requestId` | Merchant, `Idempotency-Key` | `{ amountUsdUnits }` | `returnRequestSchema` | `INSUFFICIENT_BALANCE`, `RETURN_REQUEST_PENDING` |
| `GET /api/merchant/shop/orders` · `/tickets` · `/stats` | Merchant | list query / period | pages and `shopStatsSchema` | |
| `POST /api/merchant/shop/tickets/:id/messages` · `/escalate` | Merchant | message / note | ticket | `TICKET_CLOSED` |
| `GET /api/merchant/shop/sticker.png` | Merchant | `size` | PNG | `RATE_LIMITED` |
| `GET /api/shops/:slug` | Public, cached (tag `shop:<id>`, `catalog`) | — | `shopStorefrontSchema` (name, logo, color, announcement, state, categories and games) | `NOT_FOUND` (or `301` for an old slug) |
| `GET /api/shops/:slug/games/:game` | Public, cached | — | `shopGameSchema` (packs with selling USD, SYP, availability) | `NOT_FOUND` |
| `POST /api/shops/:slug/auth/*` | Shop public (Better Auth shop instance) | `sign-up`, `send-verification-otp`, `request-password-reset` (ALTCHA), `reset-password` (Nest routes); `sign-in/email`, `sign-out`, `email-otp/verify-email`, `invitation` (Better Auth) | session | S01's codes |
| `GET /api/shops/:slug/me` · `/wallet` · `/orders` · `/orders/:number` · `/notifications` | Shop customer | — / list query | profile, balance and timeline, orders | |
| `POST /api/shops/:slug/orders` | Shop customer, `Idempotency-Key` | `shopPurchaseSchema` (product, quantity, fields, expected unit USD, confirmations) | `orderSchema` | `INSUFFICIENT_BALANCE`, `PRICE_CHANGED`, `PRODUCT_UNAVAILABLE`, `PURCHASES_STOPPED`, `SHOP_UNAVAILABLE`, `ACCOUNT_FROZEN`, the player-check codes |
| `POST /api/shops/:slug/return-requests/:id/confirm` · `/decline` | Shop customer, `Idempotency-Key` | — | `returnRequestSchema` | `INSUFFICIENT_BALANCE`, `RETURN_REQUEST_STATE_INVALID` |
| `GET·POST /api/shops/:slug/tickets…` | Shop customer | S12's shapes | tickets | S12's codes, `TICKET_ESCALATION_TOO_EARLY` |
| `GET /api/admin/shops` · `/:id` | Admin | list query | shops with state, customers, total balances, held margin | |
| `POST /api/admin/shops/:id/approve` · `/reject` · `/suspend` · `/resume` · `/close` | Admin (close: re-auth) | slug and limits / reason | shop | `SHOP_STATE_INVALID`, `SLUG_TAKEN` |
| `PATCH /api/admin/shops/:id` | Admin, re-auth | limits, slug, clear announcement | shop | `SLUG_TAKEN`, `VALIDATION_FAILED` |
| `POST /api/admin/shops/:id/customers/:cid/settle` | Admin, re-auth, `Idempotency-Key` | `{ to: 'merchant' \| 'cash_refund', reason }` | settlement | `SHOP_STATE_INVALID`, `CUSTOMER_STATE_INVALID` |
| `POST /api/admin/shop-customers/:id/freeze` · `/unfreeze` | Admin | reason | customer | |
| `POST /api/admin/orders/:id/shop-compensation` | Admin, re-auth, `Idempotency-Key` | units, reason, margin choice | compensation | `INSUFFICIENT_BALANCE` (margin part), `ORDER_NOT_COMPENSABLE` |

New error codes: `SHOP_STATE_INVALID`, `SHOP_UNAVAILABLE`, `SHOP_RATE_CONFIRMATION_REQUIRED`, `SHOP_BALANCE_CAP_EXCEEDED`, `SHOP_DAILY_TRANSFER_CAP_EXCEEDED`, `SHOP_CUSTOMER_LIMIT_REACHED`, `RETURN_REQUEST_PENDING`, `RETURN_REQUEST_STATE_INVALID`, `TICKET_ESCALATION_TOO_EARLY`, `ORDER_NOT_COMPENSABLE` (not a shop order, not finished, past the 7-day window, or more units than delivered and not yet compensated). Existing codes are reused as named.

Settled in PR 2 (server): shop customers have their own notification center and push devices (`shop_customer_notifications`, `shop_push_subscriptions`, `push.send-shop`), every shop event with its email and push; a shop order writes no `merchant_order_sales` row (the merchant's dashboard and statement kinds with shop orders come with PR 4, WL10); a shop customer's code reveal is logged as `customer` with the shop customer's id; the player-check cache row of a shop customer names the merchant; a shop's pages are cached by the store under `shop:<id>` and `catalog`. The admin's queue and ticket page for escalated shop tickets, and the order page's compensation dialog, come with PR 4 (the API refuses shop tickets on the Vertex admin routes until then); the shop order's receipt (PR11) with PR 3's order page. A shop ticket answered by the merchant is not auto-closed after 7 days (S12 TK6 reads the admin's last reply): a follow-up if wanted.

## Jobs and integrations
- `shop.return-requests-expire` (every 10 minutes): pending past `expires_at` → `expired`, `SKIP LOCKED`, one per transaction; the merchant is told.
- The customer's escalation is computed on read (24 hours since the customer's last message without a merchant reply): no job.
- Order finish: `orderFinished` handles PR8 for orders with a `shop_order_sales` row. No new job.
- Emails (outbox, `queueEmail`): invitation, OTP, reset, a transfer and a return received, a return request, order delivered and failed, ticket replies. Sender name «<shop name> عبر VERTEX DIGITAL», reply-to none. Push (S15) per shop customer device, scoped to the shop's service worker.
- Telegram to the admin: a shop request, an escalated ticket, a shop closed by revocation with a non-zero total balance.
- Store revalidation: `queueStoreRevalidate('shop:<id>')` on a settings, hidden-games, selling-price or state change. The `catalog` tag also revalidates shops.
- Reconciliation (S13): the two new checks of "Money flows".

## Screens
Store (Next.js, phone width first, RTL, design-system components; the shop's layout replaces the Vertex header, footer and bottom bar under `/s/[slug]`):
- **`/s/[slug]`**: logo and name, the announcement, the balance pill (SYP first) when signed in, a pending return request card, search, pinned games, categories and game rows. Suspended: a banner and no buy buttons. Not found: the store's 404 without Vertex links.
- **`/s/[slug]/games/[game]`**: packs with SYP first and USD after "≈", the buy box (fields, player check, slide). The "top up the gap" box says «اطلب من المتجر شحن رصيدك» with the shop's WhatsApp when the receipts show it.
- **`/s/[slug]/wallet`**: the balance, the timeline (transfers, purchases, refunds, returns), and the return requests with confirm and decline.
- **`/s/[slug]/orders`**, **`/orders/[number]`**: live tracking (S09), codes, the receipt, problem buttons.
- **`/s/[slug]/support`**: tickets, with escalate after 24 hours.
- **`/s/[slug]/account`**: name, phone, email change, password, notifications and push, install the app, sign out.
- **`/s/[slug]/sign-in`**, **`/sign-up`**, **`/verify`**, **`/reset`**, **`/invite/[token]`**: S01's forms in the shop's branding.
- Bottom bar: الرئيسية، طلباتي، رصيدي، حسابي. Footer: «يعمل بـ VERTEX DIGITAL» and the terms and privacy links (shop-branded pages).
- Loading: the storefront skeletons; empty states for no orders, no tickets, an empty wallet («رصيدك صفر: اشحن من المتجر»).

Merchant area (`/merchant/shop/*`, a new section "متجري"):
- **Request** (no shop): slug with a live availability check, color with the 12 swatches and a hex field showing the contrast result, the rate, and a live preview of the shop's header and a pack card in both themes. After the request: its state and the reason when rejected.
- **الإعدادات**: the same fields, the announcement, the logo link to the receipt settings, hidden games (the S21 game picker), the shop link with copy, share and QR, and the sticker downloads.
- **الزبائن**: a table (cards on a phone) with search; name, phone, balance (SYP · USD), last order, state. "زبون جديد". Per customer: "شحن رصيد" (amount in SYP or USD, the computed USD, today's remaining cap, the password check, the slide to confirm), "طلب إرجاع", invite again, orders.
- **طلبات المتجر**: orders with the customer, pack, state, selling price and margin (released or pending).
- **تذاكر المتجر**: the queue with unanswered first, reply, escalate.
- **الإحصاءات**: today, this month and the last 30 days (SP3), with a small daily chart.

Admin panel:
- **المتاجر** (`/shops`): requests first, then shops by state; columns: merchant, slug, state, customers, total balances, held margin, today's transfers. Approve (edit the slug, set limits) and reject with a reason.
- **Shop page**: state actions, limits, the rate history, customers with balances, freeze and settle, orders, tickets, audit.
- Support queue: escalated shop tickets with the shop tag. The order page: the shop line and "تعويض زبون المتجر".

## Audit and notifications
- Audit (same transaction): shop request, approval, rejection, suspension, resume, close, slug change, limits, rate change (with `confirmed_far`), color, announcement (merchant and admin), hidden games, customer created, invitation sent, transfer, return requested, confirmed, declined, cancelled and expired, settlement, shop customer freeze and unfreeze, compensation, ticket escalation.
- Notifications:
  - Shop customer (email, center, push): a transfer received, a return request, a return done, order delivered, partly delivered or failed with its refund, a compensation, a ticket reply.
  - Merchant (center, push): shop approved, rejected, suspended or closed; a return confirmed, declined or expired; a new shop ticket; an escalation by the customer; a compensation's margin part.
  - Admin (Telegram): a request, an escalated ticket, a closed shop with balances.

## Abuse and fraud
- **Stolen merchant session draining to an accomplice customer:** a password or passkey check within 15 minutes per transfer session, the daily cap, the customer balance cap, an email to the merchant for each transfer, and the transfers in the audit and on the statement.
- **Money laundering through transfers and returns:** returns need the customer's own signed-in confirmation; the caps; no deposit or withdrawal by shop customers; the admin's report of transfer and return volume per shop, with a Telegram alert when a shop's returns exceed 50% of its transfers over 7 days with at least $200 returned.
- **Fake customers to inflate statistics or abuse player checks:** ALTCHA on sign-up, the sign-up limits per IP and shop, verified email, the customer limit, the player-check quota per shop customer and per shop (300 a day).
- **Selling below cost:** PR3 refuses it at render and at purchase under the products lock; the purchase recomputes both prices.
- **Leaking the merchant's cost or Vertex's prices:** shop responses carry only selling prices (contract tests on the response shapes). The merchant's list never reaches the public cache: the shop's cached pages hold selling prices, which are the merchant's public prices.
- **Impersonation:** the shop name is the admin-approved trade name; the admin approves the slug, can clear the announcement and suspend the shop; reserved slugs; the logo goes through the files pipeline (type and size checks, re-encoded).
- **Phishing in the shop:** the announcement allows no links or emails; the game fields are the catalog's; no free HTML; the CSP is the store's (ADR 0015).
- **Cross-shop and cross-realm sessions:** every shop route checks that the session's `shop_id` equals the path's shop; tests for another shop's customer, a Vertex session and the merchant reaching another merchant's customers (403 or 404).
- **Double submits and races:** idempotency keys on transfers, returns, purchases, settlements and compensations; the wallet locks in a fixed order (merchant, then shop customer); the one-pending-return index; concurrency tests (two transfers against the cap, a confirm racing a purchase).
- **A merchant escaping a margin compensation:** the margin part posts only when the balance covers it; otherwise the admin decides and the debt is recorded in the ticket. The merchant's statement shows margin credits, so the admin sees the history.

## Edge cases
1. The merchant changes a price, or the rate moves, between the page and the slide: `PRICE_CHANGED` with the new price, nothing charged.
2. The merchant's purchase price rises above the selling price while a customer is on the page: the purchase is refused as unavailable and the page refreshes.
3. A transfer and a purchase by the same customer at the same moment: both serialize on the customer's wallet lock, and the cap counts the balance after the purchase's debit if it committed first.
4. Two transfers by the merchant at once against the daily cap: the merchant's wallet lock serializes them, and the second sees the first in today's sum.
5. A return confirmed while an order is paying: WL6.
6. The order fails after the merchant was revoked: the refund goes to the shop customer as usual, and no margin is released for failed units.
7. A partly delivered order: the margin is released for the delivered units only, and the rest is refunded at the selling price.
8. Shop rate changes after a transfer: the stored rate stays on the transfer; the balance shows at the new rate.
9. The store's rate is missing with `rate_mode = store`: the shop shows USD only (ST3); SYP-priced packs are unavailable.
10. A shop customer with the same email signs in to the wrong shop: the sign-in fails as a wrong password would; nothing reveals the other account.
11. An invitation for an email that self-registered in the meantime: `EMAIL_TAKEN` to the merchant.
12. The merchant hides a game with an order in progress: the order continues; the game disappears from the shop.
13. The admin lowers the balance cap below a customer's balance: the balance stays and only new transfers stop (SH8).
14. A shop closed with pending return requests: they are cancelled at close (the customer is told), and settlement takes over.
15. A shop customer's ticket after the shop is closed: it goes straight to the admin (escalated at once).
16. A slug change while customers have the PWA installed: the old scope's manifest and pages redirect to the new slug; the installed app keeps working through the redirect.
17. The 7-day report on an order whose margin was released, with the merchant's balance at zero: PR10's admin choice.
18. A merchant with a pending tier change: shop prices follow the merchant's effective list at the moment of each purchase.

## Open questions
- None blocking. The defaults listed under the owner decisions stand unless the owner changes them at approval.
- Technical risk, settled in PR 1 before any other work: Better Auth must support emails unique per shop through a scoped adapter (ADR 0040). If it cannot, stop and ask the owner. The fallback is decision 4 reversed (one email, one shop account system-wide), which changes CA3 and edge case 10.

## Acceptance
- End to end in the browser (fake supplier, local seed):
  1. A merchant requests a shop with a slug, a color and an own rate; the admin approves it with limits.
  2. The merchant creates a customer, who sets a password from the invitation; a second customer signs up from `/s/<slug>`.
  3. The merchant transfers 10,000 SYP (USD computed at the shop rate) and hits the balance cap on a second transfer.
  4. The customer buys a pack at the selling price with the brand color and logo shown. Delivered: the merchant's balance rises by the margin. A failed order refunds the full selling price.
  5. A return request is confirmed. A ticket is escalated after 24 hours (clock moved in the test).
  6. The merchant is revoked: the shop is closed, the customer still buys, the admin settles the balance.
  7. The shop is installed as an app, a push arrives on delivery, and the sticker downloads.
- Tests:
  - API: success, 401, 403 and other shops' and other merchants' records for every endpoint, including a Vertex session on shop routes and a shop session on Vertex routes.
  - Unit (contracts): price rounding (SYP up, transfer down), the contrast check and the 12 colors, slug rules, the margin math.
  - db: every journal in "Money flows" balances; idempotency; concurrency (cap races, confirm against purchase); the held account returns to zero; the guards on the new append-only tables.
  - Worker: return expiry, PR8 at each terminal state.
  - E2E with RTL screenshots: the shop's home, game, wallet and order pages on a phone in light and dark; the merchant's request, customers and transfer; the admin's shops page.
