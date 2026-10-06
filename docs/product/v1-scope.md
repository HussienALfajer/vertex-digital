# Vertex Digital — V1 Scope

Status: drafted from the owner's brief on 2026-10-06 and revised after the owner's review (code products, partial delivery, validation guard, store switches, customer notifications); awaiting the owner's final approval. Changes to this file need the owner's approval.

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
| **Owner** | Everything; suppliers, keys, pricing policy, exchange rate, staff, reports |
| **Manager** | Catalog, pricing, exchange rate, customers, reports, content; not staff or supplier keys |
| **Order operator** | Live orders room: retry, reroute, manual fulfilment, refunds within limits |
| **Deposit reviewer** | Sham Cash review queue (panel and Telegram), deposit fraud flags |
| **Support** | Tickets, customer lookup (read-only money), order and deposit status |

Staff are separate accounts with mandatory TOTP (ADR 0007). Exact permissions are set in the F02 spec.

## 3. Design principles for V1

1. **Money is sacred.** Append-only ledger, idempotency everywhere, margin guard, daily reconciliation. A bug may delay an order; it may never lose or duplicate money.
2. **Automatic by default, human on exception.** The happy path needs no staff; staff see only what the machine could not decide.
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

#### F02 — Staff accounts, roles, 2FA and audit log
- Staff accounts separate from customers; created by the owner (no self sign-up); TOTP required before any action; re-authentication for sensitive actions (refunds, rate changes, supplier keys, staff changes).
- Roles: owner, manager, order operator, deposit reviewer, support (permission map in `packages/contracts`).
- Audit log screen: every money action and staff action, filterable by actor, entity and date.

#### F03 — Wallet and ledger
- One USD wallet per customer on a double-entry, append-only ledger (ADR 0003). Balance = sum of entries.
- Wallet card: balance in USD with its SYP value at today's rate, last movements, "Deposit" action.
- Ledger timeline: every entry with its type (deposit, purchase, refund, adjustment), amount, rate where SYP was involved, reference and running balance.
- Staff adjustments (owner and manager only), with a mandatory reason and audit. No customer withdrawals in V1 (ADR 0003).

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
- Networks: TRC20 (TRON) and BEP20 (BNB Smart Chain). The customer creates a deposit intent, sends the exact amount shown to the store address (QR and copy), and submits the TXID (or pastes the explorer link).
- The worker verifies on chain: recipient, official USDT contract, exact amount, confirmations, TXID never used before; then credits the wallet 1 USDT = 1 USD (ADR 0006).
- Clear states: waiting for confirmations, credited, rejected with the reason.

#### F07 — Telegram admin bot
- Linked to staff accounts (one-time link code from the admin panel after 2FA).
- Deposit cards with receipt and Approve / Reject buttons for deposit reviewers (within an amount limit), supplier and system alerts for owner and managers, daily summary.

#### F26 — Store switches and emergency stop
- Owner and manager settings, each change re-authenticated and audited, effective at once in the store and the worker:
  - **Registration open / closed.** Closed by default: only staff-created test customers can sign in until the pilot. Every production deploy before the pilot keeps it closed, so no one can deposit real money before there is something to buy.
  - **Emergency stop** (one button, also from Telegram for the owner): stops new purchases, new deposits, or both; the store shows a calm maintenance notice; orders already paid keep being fulfilled or refunded, and no money is touched.
  - **Per-method deposit switch** (Sham Cash, USDT TRC20, USDT BEP20) and **per-supplier switch**.
- An active switch is shown as a banner in the admin panel and in the daily Telegram summary.

#### F27 — Customer notifications
- Channels in V1: **email** (free, through the outbox, ADR 0007) and an **in-site notification center** (bell with unread count, live over SSE). Web push joins in F24.
- Events: deposit credited, deposit rejected (with the reason), order delivered, order partly delivered, order refunded, `awaiting_balance` order completed or expired, ticket reply (F23). Phase 1 wires the deposit events; later features add theirs.
- Per-event email preferences in the account page; security emails (OTP, password change, new sign-in) cannot be turned off.
- Messages never contain codes, full player IDs, receipts or amounts beyond what the customer needs.

### Phase 2 — Selling

#### F08 — Catalog
- Games and apps (with category, cover, per-game accent color, ID guide image, region notes), products (packs) with official price and display order.
- **Two product kinds:**
  - **Direct top-up:** delivered to an account. Each game defines its **input fields** (player ID, and where needed zone ID, server or region, phone number), with type, format, required flag and the guide image; fields are mapped to the supplier's requirements (SHOP2TOPUP publishes them per category).
  - **Code:** a gift card or voucher PIN (iTunes, Google Play, PSN, Steam, Razer Gold…) delivered as a code; quantity allowed; region and redemption instructions per product.
- Product availability: active, paused (manual or by margin guard), out of stock (no healthy supplier).
- Admin: create and edit games and products, reorder, archive.

#### F09 — Suppliers, product mapping and price sync
- Supplier connections: SHOP2TOPUP (primary), WDGZone (backup), Manual, Fake (development and tests) (ADR 0005). API keys entered in the admin panel and stored encrypted; balance shown per supplier.
- Mapping: each store product maps to one or more supplier offers, with priority and per-offer enable switch.
- Price sync: supplier costs refreshed on a schedule; changes beyond a threshold go to the **price change review queue** (accept new price, adjust margin, pause).

#### F10 — Pricing engine
- Price = cost of the preferred route + margin rule (per category, game or product: percent and/or fixed, minimum margin), rounded up to whole cents.
- Margin guard: a product is never sold below the cost of the route that will fulfil it; a product with no profitable route is paused automatically.
- Savings vs official price computed and shown when the official price is known.

#### F11 — Orders and fulfilment engine
- Order state machine (ADR 0004): `awaiting_balance` → `paid` → `sent_to_supplier` → `delivered`, with `failed` → retry on backup supplier → `refunded`, and `needs_review` for unknown outcomes.
- Smart routing to the cheapest healthy supplier with automatic fallback (ADR 0005); idempotent supplier orders; webhooks with polling fallback.
- Automatic refund to the wallet when every route fails.
- **Partial delivery** (quantity above 1): delivered units are kept; the undelivered units are retried on the next route or refunded, so the customer pays only for what arrived (ADR 0004).
- **Code delivery:** codes received from the supplier are stored encrypted, shown only to the buying customer on the order page (reveal and copy, each reveal logged), never in emails, push messages, shareable receipts, logs or the Telegram bot; staff see them masked and reveal them only with permission and audit.
- Measured delivery time per product (median and p90 of recent orders).
- Admin: order list and detail with the full attempt history; refund (order operator and up).

#### F12 — Store home and game pages
- Home: games grid, featured banners (F21), live service status, real anonymized live activity (F25 data).
- Game page: packs with USD and SYP prices, savings vs official price, real measured delivery time, live service status, "how many do I need" calculator (cheapest combination of packs for a target amount), ID guide image.
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
- Actions: retry, reroute to another supplier, manual fulfil (with delivery proof), refund; each with permission, reason and audit. Unknown-outcome orders (`needs_review`) are resolved here.

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
- Customers open tickets, optionally linked to an order or deposit, with attachments; staff reply from the admin panel; email notification on reply.

#### F24 — PWA and web push
- Installable PWA with offline shell; web push (VAPID, self-hosted) for order delivered, deposit credited or rejected, ticket replies.

#### F25 — Live activity
- Real, anonymized activity feed on the store ("PUBG 660 UC delivered in 14 s"), built from actual delivered orders with a delay and no personal data (no names, IDs or locations); can be turned off.

## 5. Automations (fixed rules in V1)

| ID | Trigger | Automatic result |
|---|---|---|
| A01 | USDT deposit TXID submitted | Verify on chain until confirmed or rejected; credit the wallet once (F06) |
| A02 | Deposit credited | Pay and fulfil the customer's `awaiting_balance` orders, oldest first, while the balance allows (F13) |
| A03 | Order paid | Route to the cheapest healthy profitable supplier and send, in the worker (F11) |
| A04 | Supplier attempt failed definitively (whole order or some units) | Retry the undelivered units on the next profitable route; when none is left, refund them to the wallet and notify (F11, F27) |
| A05 | Supplier webhook or poll result | Move the order to delivered, partly delivered or failed; notify the customer (F27); record delivery time (F11) |
| A06 | Price sync (schedule) | Update costs; changes beyond the threshold go to the review queue; margin guard pauses products without a profitable route (F09, F10) |
| A07 | Supplier balance below its threshold | Telegram alert to owner and managers (F07, F09) |
| A08 | Supplier error rate or latency over limits | Mark the supplier degraded or down, exclude it from routing, show service status on the store (F09, F12) |
| A09 | Sham Cash deposit submitted | Telegram card with Approve / Reject to deposit reviewers; reminder when it waits past the target review time (F05, F07) |
| A10 | Deposit fraud signal (reused transaction number or receipt, mismatch, velocity) | Flag the deposit; block approval through Telegram; require panel review (F05) |
| A11 | Nightly | Reconciliation report; Telegram alert on any mismatch (F20) |
| A12 | SYP rate lock older than 15 minutes | The quote expires; a new quote at the current rate is needed (F04) |
| A13 | Unhandled error in any app | Sentry event; Telegram alert with rate limiting (ADR 0002) |
| A14 | Order in `sent_to_supplier` beyond the product's expected time | Poll the supplier; past the hard limit, mark `needs_review` and alert order operators (F11, F17) |
| A15 | `awaiting_balance` order past its expiry | Cancel it (no money was taken) and notify the customer (F13, F27) |
| A16 | Deposit credited or rejected | Notify the customer by email and in the notification center (F05, F06, F27) |
| A17 | Emergency stop turned on or off | Store and worker refuse new purchases and/or deposits at once; Telegram notice to owner and managers (F26) |

## 6. Explicitly out of V1

| Deferred | Why |
|---|---|
| Wallet withdrawals | Funds are for purchases; withdrawals invite fraud and money laundering. Exceptional cash refunds are done by the owner, recorded in the ledger (ADR 0003) |
| English UI | Arabic-only at launch; i18n from day one keeps English cheap later (Phase 4) |
| Resellers, tiers and reseller API | Phase 4 |
| Telegram purchase bot (customers) | Phase 4; the admin bot (F07) is in V1 |
| Loyalty points and referrals | Phase 4 |
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
| 1. Money core | F01–F07, F26, F27 | Test customers can sign up and fund wallets; staff can review deposits safely; registration stays closed |
| 2. Selling | F08–F16 | Test customers buy and receive top-ups automatically; registration still closed |
| 3. Operations | F17–F25 | Staff run the store from the panel; nightly reconciliation; PWA |
| Pilot | Registration opened (F26), quiet launch with low limits | Real orders, real suppliers, limits raised as confidence grows |
| 4. Growth | Resellers and reseller API, Telegram purchase bot, loyalty and referrals, mobile credit, Sham Cash automation, English UI | — |

## 8. V1 success metrics (two months after launch)

1. ≥ 95% of orders delivered without staff action.
2. Median delivery under 60 seconds for automated products.
3. Every failed order refunded to the wallet within 5 minutes of the last failure, automatically.
4. Sham Cash deposits reviewed in under 10 minutes (median) during working hours.
5. Zero unexplained mismatches in nightly reconciliation; zero sales below cost.
6. Zero approved fraudulent deposits from reused receipts or transaction numbers.
7. Store pages load (LCP) under 2.5 s on a slow 4G connection.
8. Fewer than 5% of orders lead to a "where is my order?" ticket.
