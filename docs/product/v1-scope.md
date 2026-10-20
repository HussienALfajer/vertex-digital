# Vertex Digital — V1 Scope

Status: Approved by the owner on 2026-10-06 (drafted from the brief, revised after the owner's review: code products, partial delivery, validation guard, store switches, customer notifications), and on 2026-10-07 to one admin account without staff or roles (ADR 0016) and to notify customers of wallet adjustments (S02), and on 2026-10-08 to detect USDT transfers automatically besides the TXID (S04, ADR 0018), and on 2026-10-12 to add purchases from the panel and the supplier catalog browser and import (S16, ADR 0030), and on 2026-10-20 to add merchants, price lists and the store growth features (Phase M, F28–F42), moved forward from Phase 4. Changes to this file need the owner's approval.

## 1. Business context

Vertex Digital sells digital top-ups to customers in Syria and Syrians abroad: game currencies (PUBG Mobile UC, Free Fire diamonds and others), chat-app credits and subscriptions, and gift cards. Goods come from wholesale suppliers through their APIs; Vertex Digital earns the margin between the supplier cost and its price.

Customer journey the system must cover:

```
Sign up (email + OTP, phone) → Deposit to wallet (Sham Cash or USDT) → Choose a game and pack
→ Enter player ID (validated live) → Pay from wallet → Automatic fulfilment through a supplier
→ Delivered (or retried on a backup supplier, or refunded to the wallet) → Receipt
```

Operations journey:

```
Supplier catalog sync → Map supplier products to store products → Price with a margin
→ Review deposits → Watch live orders, fix exceptions → Reconcile daily → Report
```

### Problems V1 must solve (what competitors get wrong)

1. Customers don't know if their order is moving: no status, no delivery time, support chats full of "where is my order?".
2. Wrong player IDs burn money: the customer only finds out after paying.
3. Manual deposits are slow and opaque: no reference, no ETA, receipts lost in chats.
4. Prices are unclear: SYP prices change without notice, no way to compare with the official price.
5. Failed orders are refunded late or never; stores sell at a loss when supplier prices move.
6. Fraud with reused or edited deposit receipts.
7. Stores look cheap and untrustworthy; slow on Syrian connections.

## 2. People

| Who | Uses the system for |
|---|---|
| **Customer** | Deposits, purchases, saved player IDs, order tracking, receipts, support tickets |
| **Admin** (the owner) | Everything: deposit review, orders and refunds, catalog, suppliers and keys, pricing, exchange rate, customers, tickets, content, settings, reports |

There is one admin account with full access and no staff or roles (ADR 0016). It is separate from customer accounts and requires TOTP (ADR 0007).

## 3. Design principles for V1

1. **Money is sacred.** Append-only ledger, idempotency everywhere, margin guard, daily reconciliation. A bug may delay an order; it may never lose or duplicate money.
2. **Automatic by default, human on exception.** The happy path needs no admin action; the admin sees only what the machine could not decide.
3. **Show the truth.** Real measured delivery times, real service status, real review ETA, real activity. Never fake numbers.
4. **Fast on slow connections.** Server-rendered pages, small bundles, cached catalog, works on a weak 3G/4G signal.
5. **Clear before clever.** Every price in USD and SYP, every state named, every error tells the customer what to do next.
6. **Arabic RTL first.** Arabic-only UI in V1 (English names and search terms understood); i18n from day one so English can be added later.

## 4. Features

IDs are stable; specs live in `docs/specs/<id>-<name>.md`. Phase numbers refer to §7.

### Phase 1 — Money core

#### F01 — Customer accounts
- Sign up with email and password, verified by a 6-digit email OTP (ADR 0007). ALTCHA on sign-up, sign-in, OTP request and password reset.
- Required at sign-up: full name and phone number (Syrian by default, international allowed; format-validated, stored in E.164, not OTP-verified). Other profile fields are set in the spec.
- Sign in, sign out, forgot password by email OTP, change password and email, active sessions with "sign out everywhere".
- Account page: profile, phone, security, notification preferences.

#### F02 — Admin account, 2FA and audit log
- One admin account with full access, separate from customers (ADR 0016); created and recovered by CLI on the server only (no sign-up, no reset by email); TOTP required before any action; re-authentication for sensitive actions (refunds, wallet adjustments, rate changes, supplier keys, switches).
- No staff, roles or permission map in V1.
- Audit log screen: every money action and admin action, filterable by actor, action, entity and date.

#### F03 — Wallet and ledger
- One USD wallet per customer on a double-entry, append-only ledger (ADR 0003). Balance = sum of entries.
- Wallet card: balance in USD with its SYP value at today's rate, last movements, "Deposit" action.
- Ledger timeline: every entry with its type (deposit, purchase, refund, adjustment), amount, rate where SYP was involved, reference and running balance.
- Admin adjustments, with a mandatory reason, re-authentication and audit. No customer withdrawals in V1 (ADR 0003).

#### F04 — Exchange rate and SYP display
- Admin-set USD→SYP rate with history; every transaction stores the rate it used.
- SYP shown next to USD everywhere, rounded to clean numbers by a configured step.
- SYP deposit quotes lock the rate for 15 minutes, with a visible countdown.

#### F05 — Sham Cash deposits (manual review)
- Deposit wizard: amount (USD or SYP), the store's Sham Cash account as QR and copy buttons, a unique reference code to put in the transfer note, receipt paste or upload, then a status page with the real review ETA.
- Review queue in the admin panel: receipt, reference, amount, customer history, duplicate and fraud signals; approve (with the Sham Cash transaction number) or reject with a reason.
- Duplicate and fraud detection: transaction number unique, receipt image hash reuse, reference mismatch, amount mismatch, new-account and velocity rules.
- Approval credits the wallet in one transaction with the audit entry, then resumes waiting orders (A02).

#### F06 — USDT deposits (automatic)
- Networks: TRC20 (TRON) and BEP20 (BNB Smart Chain). The customer creates a deposit intent, sends the exact amount shown to the store address (QR and copy). The worker detects the transfer on its own; the customer may also submit the TXID (or paste the explorer link) to start verification at once (owner, 2026-10-08).
- The worker verifies on chain: recipient, official USDT contract, exact amount, confirmations, TXID never used before; then credits the wallet 1 USDT = 1 USD (ADR 0006).
- Clear states: waiting for the transfer, waiting for confirmations, in review (amount or network mismatch), credited, rejected with the reason.

#### F07 — Telegram admin bot
- Linked to the admin account (one-time link code from the admin panel after 2FA).
- Deposit cards with receipt and Approve / Reject buttons (within an amount limit), supplier and system alerts, daily summary; all to the admin.

#### F26 — Store switches and emergency stop
- Admin settings, each change re-authenticated and audited, effective at once in the store and the worker:
  - **Registration open / closed.** Closed by default: only admin-created test customers can sign in until the pilot. Every production deploy before the pilot keeps it closed, so no one can deposit real money before there is something to buy.
  - **Emergency stop** (one button, also from Telegram): stops new purchases, new deposits, or both; the store shows a calm maintenance notice; orders already paid keep being fulfilled or refunded, and no money is touched.
  - **Per-method deposit switch** (Sham Cash, USDT TRC20, USDT BEP20) and **per-supplier switch**.
- An active switch is shown as a banner in the admin panel and in the daily Telegram summary.

#### F27 — Customer notifications
- Channels in V1: **email** (free, through the outbox, ADR 0007) and an **in-site notification center** (bell with unread count, live over SSE). Web push joins in F24.
- Events: deposit credited, deposit rejected (with the reason), wallet adjusted by the admin (amount and category, S02), order delivered, order partly delivered, order refunded, `awaiting_balance` order completed or expired, ticket reply (F23). Phase 1 wires the deposit events; later features add theirs.
- Per-event email preferences in the account page; security emails (OTP, password change, new sign-in) cannot be turned off.
- Messages never contain codes, full player IDs, receipts or amounts beyond what the customer needs.

### Phase 2 — Selling

#### F08 — Catalog
- Games and apps (with category, cover, per-game accent color, ID guide image, region notes), products (packs) with official price and display order.
- **Two product kinds:**
  - **Direct top-up:** delivered to an account. Each game defines its **input fields** (player ID, and where needed zone ID, server or region, phone number), with type, format, required flag and the guide image; fields are mapped to the supplier's requirements.
  - **Code:** a gift card or voucher PIN (iTunes, Google Play, PSN, Steam, Razer Gold…) delivered as a code; quantity allowed; region and redemption instructions per product.
- Product availability: active, paused (manual or by margin guard), out of stock (no healthy supplier).
- Admin: create and edit games and products, reorder, archive.

#### F09 — Suppliers, product mapping and price sync
- Supplier connections: WDGZone (automatic), Manual, Fake (development and tests) (ADR 0005, 0031). API keys entered in the admin panel and stored encrypted; balance shown per supplier.
- Mapping: each store product maps to one or more supplier offers, with priority and per-offer enable switch.
- Price sync: supplier costs refreshed on a schedule; changes beyond a threshold go to the **price change review queue** (accept new price, adjust margin, pause).
- **Supplier catalog browser** (S16): the supplier's category tree with images, counts and a state per category; import a category as a new game (paused, mapped, priced) or link it to a game; ignore; new-pack notices; stock with low-stock alerts; the supplier's wallet transactions and order history matched to our orders.

#### F10 — Pricing engine
- Price = cost of the preferred route + margin rule (per category, game or product: percent and/or fixed, minimum margin), rounded up to whole cents.
- Margin guard: a product is never sold below the cost of the route that will fulfil it; a product with no profitable route is paused automatically.
- Savings vs official price computed and shown when the official price is known.

#### F11 — Orders and fulfilment engine
- Order state machine (ADR 0004): `awaiting_balance` → `paid` → `sent_to_supplier` → `delivered`, with `failed` → retry on backup supplier → `refunded`, and `needs_review` for unknown outcomes.
- Smart routing to the cheapest healthy supplier with automatic fallback (ADR 0005); idempotent supplier orders; webhooks with polling fallback.
- Automatic refund to the wallet when every route fails.
- **Partial delivery** (quantity above 1): delivered units are kept; the undelivered units are retried on the next route or refunded, so the customer pays only for what arrived (ADR 0004).
- **Code delivery:** codes received from the supplier are stored encrypted, shown only to the buying customer on the order page (reveal and copy, each reveal logged), never in emails, push messages, shareable receipts, logs or the Telegram bot; the admin sees them masked and reveals one only with re-authentication and audit.
- Measured delivery time per product (median and p90 of recent orders).
- Admin: order list and detail with the full attempt history; refund.
- **Admin purchases** (S16): walk-in (no customer), on behalf of a customer from their wallet, and gifts or compensation from the owner's funds (owner drawings, daily cap).

#### F12 — Store home and game pages
- Home: games grid, featured banners (F21). No service status line (owner, 2026-10-19: a slow supplier is the panel's business; the store marks only a game that cannot be bought). Live activity (F25) is not shown in the store (owner, 2026-10-19: the store no longer shows live activity; the API route, the panel switch and its preview stay).
- Game page: packs with USD and SYP prices, savings vs official price, real measured delivery time, an "unavailable" mark when no pack can be bought, "how many do I need" calculator (cheapest combination of packs for a target amount), ID guide image.
- Server-rendered and cached for speed and SEO (Cache Components); fresh prices on price change.

#### F13 — Purchase flow and live order tracking
- Buy box: pack, the game's input fields (F08) with live player validation (shows the in-game name when the supplier supports it), quantity, total in USD and SYP.
- **Validation guard:** validation runs only for signed-in, verified customers, after the customer stops typing or leaves the field (never per keystroke); results are cached per game and account for a set time; per-customer and per-IP limits protect the supplier's daily validation quota and stop the store being used as a free name-lookup service. When the quota or the supplier is unavailable, the customer sees a clear warning and confirms the ID manually.
- Slide-to-pay confirmation (no accidental purchases); idempotent submission.
- Live order timeline over SSE: paid → sent → delivered (or retrying, refunded), with times.
- "Balance too low": the order is saved as `awaiting_balance` with its price, the customer is sent to deposit, and the order completes automatically after the deposit is credited (A02), or expires.

#### F14 — Saved player IDs and one-tap recharge
- Save player IDs per game with a label ("My account", "Brother"), validated name stored.
- One-tap recharge: repeat a previous order or buy a pack for a saved ID in one step (still slide-to-pay).

#### F15 — Smart search
- `Ctrl+K` / search button: Arabic and English names, common misspellings and transliterations (ببجي, pubg, فري فاير), games and packs, recent searches.

#### F16 — Cart, gift top-up and shareable receipt
- Cart: several packs for one or more player IDs, paid in one wallet debit; each line is its own order.
- Gift top-up: buy for someone else's player ID with a short message and a shareable gift card image or link.
- Shareable receipt: a public, non-guessable receipt page and image (no personal data beyond what the customer chooses to show, and never a code from a code product).

### Phase 3 — Operations

#### F17 — Live orders room
- Real-time board of orders by state, with filters and alerts for stuck orders (A14).
- Actions: retry, reroute to another supplier, manual fulfil (with delivery proof), refund; each with a reason and audit. Unknown-outcome orders (`needs_review`) are resolved here.

#### F18 — Admin dashboard
- Today: sales, profit, orders by state, deposits waiting, supplier balances and health, exchange rate, alerts.

#### F19 — Customers administration
- Customer search and profile: wallet, orders, deposits, tickets, devices, notes.
- Limits (per-deposit, daily deposit, daily purchase), freezing (no deposits or purchases, balance kept), unfreezing; all audited.

#### F20 — Daily reconciliation
- Nightly job: ledger invariants (every journal balances, wallet sums), orders vs ledger, supplier spend vs supplier balance movement, deposits vs credits. Mismatches reported in the admin panel and on Telegram.

#### F21 — Content
- FAQ, terms and policies pages, home banners, announcement bar; edited in the admin panel, published to the store with cache revalidation.

#### F22 — Reports
- Sales and profit by day, game, product and supplier; deposits by method; refunds and failure rates; top customers. Excel export.

#### F23 — Support tickets
- Customers open tickets, optionally linked to an order or deposit, with attachments; the admin replies from the admin panel; email notification on reply.

#### F24 — PWA and web push
- Installable PWA with offline shell; web push (VAPID, self-hosted) for order delivered, deposit credited or rejected, ticket replies.

#### F25 — Live activity
- Not shown in the store (owner, 2026-10-19: the store no longer shows live activity; the API route, the panel switch and its preview stay).
- Real, anonymized activity feed on the store ("PUBG 660 UC delivered in 14 s"), built from actual delivered orders with a delay and no personal data (no names, IDs or locations); can be turned off.

### Phase M — Merchants and store growth

Added by the owner on 2026-10-20, moved forward from Phase 4 and started before the pilot opens. Selling retail to customers and wholesale to shops across Syria is the business goal; these features serve both. Each spec settles the details; the owner's answers so far are in `docs/open-questions.md` (Resolved).

#### F28 — Merchant accounts and the merchant application
- Two account types: **customer** (default, retail) and **merchant**. The account type decides what a person sees (merchant tools); the price list (F29) decides what they pay. A merchant gets the wholesale list by default; the admin may assign another list.
- A verified, not frozen customer with no open application applies from the account page. The form:
  - Shop: trade name; activity (mobile phones and accessories shop, gaming lounge or internet café, services shop or bookshop, wholesale distributor, online store or social media page, other); years in business (under 1, 1–3, over 3); governorate (the 14 Syrian governorates, or outside Syria); city or area; street address.
  - Contact: contact person's name (from the account); WhatsApp number (E.164, the account phone by default); Telegram username (optional).
  - Business: expected monthly purchases (under $200, $200–500, $500–2,000, $2,000–5,000, over $5,000); products of interest (game top-ups, gift cards, chat apps and subscriptions; several allowed); sales channels (shop counter, WhatsApp or Telegram, social media pages, online store; several allowed).
  - Proof (optional): one photo of the shop front (the receipt image pipeline), a link to the shop's page.
  - Acceptance of the merchant terms (a versioned content page, F21), and "how did you hear about us" (optional).
- The application's state is always shown: under review, more information requested (the customer edits and resubmits), approved, or rejected with the reason; reapplying after a rejection waits a cooling-off period set in the spec.
- **Approval only by the admin**, in the panel (applications queue beside the customer's history and fraud signals), with a Telegram notice. Approval switches the account type, the price list and the merchant deposit limits in one transaction, audited, and notifies the customer. The admin can also revoke merchant status (back to retail, balance untouched) with a reason.
- **Merchant deposit limits:** a merchant limits tier, editable in the panel, default $2,000 per deposit and $5,000 per 24 hours (owner, 2026-10-20, S20); per-customer overrides (S12) still apply.

#### F29 — Price lists
- Four kinds of price: **retail** (every customer, the current pricing), **wholesale** (merchants; default 5%, owner 2026-10-20), **cost** (accounts the admin chooses, never requested; default cost + 1%, owner 2026-10-20; shown to the customer as "special price", never as "cost"), and **custom**: named lists the admin creates and assigns to one or many accounts (owner, 2026-10-20), inheriting from a parent list and overriding only what they change.
- A list is a set of margin rules (global, category, game, product; ADR 0020) with an optional fixed price per product. The margin guard holds per list: no list ever sells below its route's cost plus that list's minimum margin.
- Prices are repriced for every list on every cost or rule change; the price review queue (A06) stays on the retail price.
- Each order records the list and the price row it was charged at; reports split sales and profit by list and by merchant.
- Lists and assignments are changed only with re-authentication and audited. The panel shows a product × list price matrix with each cell's margin and warnings.
- Wholesale, cost and custom prices are private to their account: never in the publicly cached catalog, a share link, a receipt sent to someone else or another customer's response.

#### F30 — Merchant dashboard
- Today and this month: sales, spending, estimated profit, balance, top products.

#### F31 — Merchant's own selling prices
- The merchant sets the price they charge their own customers per product, in SYP or USD; profit per order and per period is computed from it; used by F34, F35 and F36.

#### F32 — Point-of-sale mode
- A fast counter screen for merchants: product grid, keyboard shortcuts, recent player IDs, a purchase in two taps (still confirmed).

#### F33 — Bulk orders
- Paste a list (or upload a CSV) of player IDs and packs, check it, pay it once, and follow each line's status.

#### F34 — Codes in quantity and thermal printing
- Buy several codes of one pack at once; print them on a 58 or 80 mm thermal printer with the redemption steps; every print and export is logged like a reveal (F11).

#### F35 — Receipt verification QR and the merchant-branded receipt
- Every receipt carries a QR code whose page confirms the order was delivered, with no personal data and never a code (store-wide).
- A merchant's printed or shared receipt carries their shop name, and their own selling price instead of the price they paid.

#### F36 — Printable daily price list
- A PDF or image of the merchant's prices (or their own selling prices, F31) in SYP, to hang in the shop or send on WhatsApp.

#### F37 — Merchant alerts
- Price changes, products back in stock or out of stock, and a low balance.

#### F38 — Monthly statement
- A monthly account statement (PDF and Excel): deposits, orders, refunds, opening and closing balance.

#### F39 — Merchant volume levels
- Levels by monthly purchases (for example bronze, silver, gold), each with its own price list, upgraded automatically; thresholds and lists set in the panel.

#### F40 — Quick buy
- "Top up again" row on the home page: each saved player ID with its last pack, bought with one slide.
- Direct buy links (for example `/q/<pack>`), choosing the customer's saved ID, for ads, WhatsApp and shop QR codes.
- "Top up the gap": when the balance is short, the exact missing amount in USD and SYP, and the deposit form filled with it.
- "Best value" badge: the price per 100 units of each pack, the best one marked.
- Passkey sign-in (fingerprint or face on the phone) besides the password.
- Commands in search: "660 لأخي" opens the purchase ready, with the pack and the saved ID.

#### F41 — Order problem buttons
- On an order: ready buttons ("لم يصل"، "المعرّف خاطئ"…) that open a support ticket (F23) linked to the order with its details.

#### F42 — Availability and price-drop alerts
- "Notify me when available" and "when the price drops" per pack, by web push and in the notification center.

## 5. Automations (fixed rules in V1)

| ID | Trigger | Automatic result |
|---|---|---|
| A01 | USDT transfer to a store address detected, or a TXID submitted | Verify on chain until final; credit the wallet once on an exact match, otherwise send to review (F06) |
| A02 | Deposit credited | Pay and fulfil the customer's `awaiting_balance` orders, oldest first, while the balance allows (F13) |
| A03 | Order paid | Route to the cheapest healthy profitable supplier and send, in the worker (F11) |
| A04 | Supplier attempt failed definitively (whole order or some units) | Retry the undelivered units on the next profitable route; when none is left, refund them to the wallet and notify (F11, F27) |
| A05 | Supplier webhook or poll result | Move the order to delivered, partly delivered or failed; notify the customer (F27); record delivery time (F11) |
| A06 | Price sync (schedule) | Update costs; changes beyond the threshold go to the review queue; margin guard pauses products without a profitable route (F09, F10) |
| A07 | Supplier balance below its threshold | Telegram alert to the admin (F07, F09) |
| A08 | Supplier error rate or latency over limits | Mark the supplier degraded or down, exclude it from routing; the store shows only games that cannot be bought (F09, F12; owner, 2026-10-19) |
| A09 | Sham Cash deposit submitted | Telegram card with Approve / Reject to the admin; reminder when it waits past the target review time (F05, F07) |
| A10 | Deposit fraud signal (reused transaction number or receipt, mismatch, velocity) | Flag the deposit; block approval through Telegram; require panel review (F05) |
| A11 | Nightly | Reconciliation report; Telegram alert on any mismatch (F20) |
| A12 | SYP rate lock older than 15 minutes | The quote expires; a new quote at the current rate is needed (F04) |
| A13 | Unhandled error in any app | Sentry event; Telegram alert with rate limiting (ADR 0002) |
| A14 | Order in `sent_to_supplier` beyond the product's expected time | Poll the supplier; past the hard limit, mark `needs_review` and alert the admin (F11, F17) |
| A15 | `awaiting_balance` order past its expiry | Cancel it (no money was taken) and notify the customer (F13, F27) |
| A16 | Deposit credited or rejected | Notify the customer by email and in the notification center (F05, F06, F27) |
| A17 | Emergency stop turned on or off | Store and worker refuse new purchases and/or deposits at once; Telegram notice to the admin (F26) |

## 6. Explicitly out of V1

| Deferred | Why |
|---|---|
| Wallet withdrawals | Funds are for purchases; withdrawals invite fraud and money laundering. Exceptional cash refunds are done by the owner, recorded in the ledger (ADR 0003) |
| English UI | Arabic-only at launch; i18n from day one keeps English cheap later (Phase 4) |
| Reseller API, merchant staff (cashier) accounts and the merchant mini-store | Declined for now (owner, 2026-10-20) |
| Merchant credit lines; merchants as cash-in points and prepaid wallet vouchers | Later, after the merchant features (owner, 2026-10-20): ledger transfers between accounts need their own anti-fraud and anti-money-laundering design |
| Telegram purchase bot (customers) | Phase 4; the admin bot (F07) is in V1 |
| Loyalty points, cashback and referrals | Declined (owner, 2026-10-20) |
| Delivery-time guarantee, price history chart, Eid and scheduled gifts, group gifts, season calendar, renewal reminders, Telegram customer notifications, onboarding steps, account story page | Proposed on 2026-10-20 and declined by the owner |
| Syrian mobile credit (Syriatel, MTN) | Phase 4 |
| Sham Cash automation | No API today; manual review with fraud checks in V1 (Phase 4) |
| Other payment methods (cards, other e-wallets) | Not available or not needed at launch |
| Phone OTP | Paid SMS; phone is format-validated only |
| Coupons and discounts | Pricing engine first; promotions later |
| Native mobile apps | PWA covers install and push |
| Cloudflare or any CDN blocked in Syria | ADR 0008 |
| Live chat | Tickets in V1 |

## 7. Build phases

| Phase | Contents | Outcome |
|---|---|---|
| 0. Foundation | Repo scaffold, CI, design system (store and admin), both auth skeletons, ALTCHA, security baseline, deployment skeleton, Sentry | A deployable empty store and panel |
| 1. Money core | F01–F07, F26, F27 | Test customers can sign up and fund wallets; the admin can review deposits safely; registration stays closed |
| 2. Selling | F08–F16 | Test customers buy and receive top-ups automatically; registration still closed |
| 3. Operations | F17–F25 | The admin runs the store from the panel; nightly reconciliation; PWA |
| M. Merchants and store growth | F28–F42 (owner, 2026-10-20: started before the pilot) | Merchants apply and buy at their lists; shops get counter, bulk and print tools; quicker retail buying |
| Pilot | Registration opened (F26), quiet launch with low limits | Real orders, real suppliers, limits raised as confidence grows |
| 4. Growth | Telegram purchase bot, mobile credit, Sham Cash automation, English UI | — |

## 8. V1 success metrics (two months after launch)

1. ≥ 95% of orders delivered without admin action.
2. Median delivery under 60 seconds for automated products.
3. Every failed order refunded to the wallet within 5 minutes of the last failure, automatically.
4. Sham Cash deposits reviewed in under 10 minutes (median) during working hours.
5. Zero unexplained mismatches in nightly reconciliation; zero sales below cost.
6. Zero approved fraudulent deposits from reused receipts or transaction numbers.
7. Store pages load (LCP) under 2.5 s on a slow 4G connection.
8. Fewer than 5% of orders lead to a "where is my order?" ticket.
