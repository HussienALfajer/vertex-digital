# S08 — Orders and fulfilment engine (F11)

Status: Approved · Date: 2026-10-09 · Scope: `docs/product/v1-scope.md` §F11 (A03, A04, A05, A14; with §F26 SW7, §F27 and §F13's pay step) · ADRs: 0003, 0004, 0005, 0011, 0013, 0014, 0016, 0019, 0020, 0021, 0022

## Summary
S07 gave every product a price and its routes, but nothing can be bought. S08 is the money core of selling: a customer buys a pack with their wallet (one transaction debits the wallet, writes the paid order and queues its fulfilment), the worker routes it to the cheapest healthy profitable supplier, sends it with an idempotency key per attempt, follows it by webhook and polling, retries undelivered units on the next route after a definitive failure, and refunds what could not be delivered. Unknown outcomes are never sent elsewhere: they are polled, then held for the admin after 30 minutes. Codes are stored encrypted and revealed only to the buyer, each reveal logged. The admin gets the order list and detail with every attempt, the decisions on held and manual orders, and Telegram cards. The store gets "طلباتي" and the order page; the buy box, player validation, slide-to-pay, the live timeline and `awaiting_balance` orders are S09 (owner, 2026-10-09).

## In scope / out of scope
- In:
  - The purchase endpoint (`POST /api/orders`): paid from the wallet at once, with the price, margin guard, availability, input fields, purchase stop and idempotency checks of ADR 0004.
  - Orders, order events, fulfilment attempts, encrypted codes and their reveal log; the order write path in `packages/db/src/orders` used by the api and the worker.
  - Routing (A03) with the S07 tiers and the margin guard per attempt; retry of undelivered units on the next route (A04); partial delivery; refunds (full and of the undelivered units); cost of goods.
  - Supplier webhooks (`/api/webhooks/suppliers/:code`), polling and the hard limit (A05, A14), the attempt sweep after a crash.
  - The manual supplier's orders: Telegram card, reminder, delivery or failure from the panel.
  - The admin's decisions on held orders: poll again, confirm delivered, confirm failed, refund (re-authentication).
  - Test customers' orders limited to the `fake` and `manual` suppliers (owner, 2026-10-09).
  - Measured delivery time per product (median and p90), read in the panel.
  - Customer notifications (delivered, partly refunded, refunded, delayed) and admin Telegram messages; daily summary lines.
  - Store: "طلباتي" (`/orders`) and the order page (`/orders/[id]`) with code reveal. Admin: `/orders`, `/orders/$id`, the order policy page.
  - Dev tools: `order:place` (api) and the fake supplier's order scripting (worker).
- Out (later or never):
  - Buy box on the game page, live player validation and its quota, slide-to-pay, the live order timeline over SSE, `awaiting_balance` orders with A02 and A15, the store's delivery time and service status: S09 (F12, F13).
  - Cart, gifts and shareable receipts: S10 (F16). Each cart line will be its own order through the same write path.
  - The live orders room and the dashboard: S11 (F17, F18). S08's `/orders` with its "بحاجة لمراجعة" and "يدوي بانتظارك" tabs covers exceptions until then.
  - Supplier funding and reconciliation against supplier statements: S13 (F20). Until then `supplier_prepaid:<code>` goes negative by the cost of goods.
  - Refunding a delivered order: never through the order. A make-good for a delivered order is a wallet adjustment (`compensation`, S02) (owner, 2026-10-09).
  - Customer cancellation of a paid order: not in V1 (ADR 0004 has no such transition).
  - The real adapters' order calls: each adapter PR (Q12) maps its supplier's statuses, partial results and webhooks to the interface below.

## Access
| Action | Route kind | Who |
|---|---|---|
| Buy (create a paid order) | Customer, `Idempotency-Key`, rate limited | Signed-in customer with a verified email |
| Read own orders, an own order; reveal an own code | Customer | The same; reveal rate limited |
| Supplier webhook | Public, HMAC signature | The supplier |
| Read orders, an order with its attempts, events, journals, masked codes and reveals; delivery times | Admin | The admin |
| Poll again, confirm delivered, confirm failed, refund (held or manual attempts) | Admin, re-authentication, `Idempotency-Key` for the last three | The admin |
| Reveal a code | Admin, re-authentication | The admin |
| Change the order policy | Admin, re-authentication | The admin |
| Routing, sending, polling, webhooks processing, refunds after failures, notifications | Worker jobs | System |
| `order:place` (dev CLI) | CLI, refused in production | The developer |

A customer reaches only their own orders: the customer routes take no customer id, and another customer's order answers `NOT_FOUND`.

## Data
Tables are owned by the api `orders` module; the write path lives in `packages/db/src/orders` (like the ledger and repricing) so the worker can run it. Business tables have `id` (UUIDv7), `created_at`, `updated_at`; append-only tables have `id`, `created_at` and no update or delete grant for the app role (ADR 0014). Money is USD units (micro-dollars, ADR 0003).

### Contracts (`orders.ts` extended; `suppliers.ts`, `notifications.ts`, `telegram.ts`, `audit.ts`, `errors.ts`, `jobs.ts` extended)
- `ORDER_STATUSES` and `ORDER_TRANSITIONS` (exist). `orderCustomerStage(status)`: `processing` (`paid`, `sent_to_supplier`, `failed`), `delayed` (`needs_review`), `delivered`, `partially_refunded`, `refunded`, `cancelled` (rule O13).
- `ATTEMPT_STATUSES` (`sending`, `pending`, `unknown`, `delivered`, `failed`); `ATTEMPT_RESOLVERS` (`supplier`, `poll`, `webhook`, `admin`); `ORDER_EVENT_KINDS` (`status`, `attempt`, `note`); `ORDER_EVENT_ACTORS` (`customer`, `system`, `supplier`, `admin`); `REFUND_REASONS` (`no_route`, `routes_exhausted`, `input_rejected`, `admin`); `ROUTE_SKIP_REASONS` (S07's `ROUTE_UNUSABLE_REASONS` plus `already_tried`, `unprofitable`, `balance_below_order`, `test_customer`).
- Pure functions (100% coverage): `orderTotal(unitPrice, quantity)`, `refundAmount(unitPrice, units)`, `costOfGoods(unitCost, units)`, `routeProfitable(unitPrice, unitCost, minMargin)` (PR5), `orderCandidates(routes, order, facts)` (rule R1–R4: ordered candidates and the skip reason of every other route), `nextPollAt(sentAt, pollCount, policy)` and `pastHardLimit(sentAt, now, policy)` (rule F7), `deliveryStats(durationsMs)` (median and p90, nearest rank; null under 5), `orderNumberSchema`, `maskCode(code)`.
- `ORDER_NUMBER_ALPHABET` = S03's reference alphabet; numbers are `VO-` + 6 characters, accepted in lower case or without the dash.
- `SupplierOutcome` (in `packages/suppliers`) changes: `delivered` carries `quantity` (the units delivered, 1 ≤ quantity ≤ requested; fewer means the rest failed definitively, as SHOP2TOPUP's `partial`); `failed_definitive` gains `inputRejected?: boolean` (the supplier refused the account fields: player not found, wrong zone). An adapter answers a repeated `placeOrder` with the same key with that order's current outcome, never a duplicate error.
- Error codes: `PURCHASES_STOPPED`, `PRODUCT_UNAVAILABLE`, `PRICE_CHANGED` (`details.unitPriceUsdUnits`), `ORDER_NOT_DECIDABLE`, `ATTEMPT_NOT_RESOLVABLE`, `CODES_COUNT_MISMATCH`, `WEBHOOK_SIGNATURE_INVALID`; existing `INSUFFICIENT_BALANCE` (`details.balanceUnits`), `IDEMPOTENCY_KEY_REUSED`, `VALIDATION_FAILED` (`details.fields` per input field key, or `quantity`), `RATE_LIMITED`, `REAUTHENTICATION_REQUIRED`, `NOT_FOUND`. Each with its Arabic text.
- Queues: `orders.fulfil`, `orders.poll`, `orders.sweep`, `suppliers.webhook`. Payloads carry ids only.

### `orders` (new; business table, never deleted or archived)
- `number` text unique (`VO-XXXXXX`, CSPRNG, retried on conflict); `customer_id` FK; `is_test` boolean (the customer's flag at purchase); `product_id` FK; `game_id` FK; `kind` enum `product_kind` (the product's, copied).
- `status` enum `order_status`; `quantity` int 1–50 (≤ the product's `max_quantity` at purchase); `unit_price_usd_units` bigint (whole cents, > 0); `total_usd_units` bigint (= unit × quantity); `price_id` uuid FK `product_prices` (the price row charged); `min_margin_usd_units` bigint (the rule's minimum margin on that price row: the guard for every attempt).
- `fields` jsonb: `{ "<input field key>": "<value>" }`, validated by CT7, at most 10 entries. Field labels are read from the catalog (archived fields keep their rows).
- `display_rate_id` uuid nullable, `total_syp_units` bigint nullable: the SYP shown at purchase (`sypDisplayPrice`), for the order page only; no SYP moves.
- `delivered_quantity` int ≥ 0, `refunded_quantity` int ≥ 0, `refunded_usd_units` bigint ≥ 0 (= unit × refunded quantity); `refund_reason` enum nullable.
- `idempotency_key` uuid, `request_hash` text (SHA-256 of the canonical body); unique `(customer_id, idempotency_key)`.
- `purchase_journal_id` FK unique; `refund_journal_id` FK nullable unique.
- `paid_at`, `delivered_at` nullable (fully delivered), `finished_at` nullable (any terminal state), `review_since` nullable (entered `needs_review`).
- Checks: `delivered_quantity + refunded_quantity ≤ quantity`; `refunded_usd_units = unit_price_usd_units × refunded_quantity`; `delivered` ⇒ `delivered_quantity = quantity`; `partially_refunded` ⇒ both > 0 and their sum = `quantity`; `refunded` ⇒ `delivered_quantity = 0` and `refunded_quantity = quantity`; whole cents on the prices.
- A trigger refuses `DELETE` and `TRUNCATE`, and any `UPDATE` of a terminal order or of the identity, price and field columns. The app role has `SELECT`, `INSERT`, `UPDATE`.
- Indexes: `(customer_id, created_at desc)`, `(status, created_at)`, `(product_id, delivered_at desc) where status = 'delivered' and not is_test` (delivery stats), `(number)`.

### `order_events` (new; append-only)
- `order_id` FK; `kind` enum; `from_status`, `to_status` nullable; `actor` enum, `actor_id` uuid nullable (no FK); `attempt_id` nullable; `reason` text nullable ≤ 64 (a code such as `no_route`, `hard_limit`, `input_rejected`); `details` jsonb (never codes, never field values). Index `(order_id, created_at)`.

### `fulfilment_attempts` (new; business table)
- `id` is the idempotency key sent to the supplier (ADR 0004). `order_id` FK; `route_id` FK `product_routes`; `supplier_id` FK; `offer_id` FK `supplier_offers` (and the supplier's own offer id, copied); `quantity` int (units asked); `unit_cost_usd_units` bigint (the offer's cost at routing).
- `status` enum; `delivered_quantity` int ≥ 0 ≤ `quantity`; `supplier_order_id` text nullable ≤ 128; `failure_reason` text nullable ≤ 200 (sanitized); `input_rejected` boolean; `supplier_code` text nullable ≤ 64.
- `candidates` jsonb: every route the router saw, with tier, cost and its skip reason or rank (ADR 0005 "routing decisions are recorded"); `result` jsonb: the classified outcome without codes.
- `sent_at`, `poll_count` int, `next_poll_at` nullable, `resolved_at` nullable, `resolved_by` enum nullable, `admin_reason` text nullable 5–500, `cost_journal_id` FK nullable unique.
- Unique `(order_id, route_id)`: a route is tried once per order. Partial unique `(order_id) where status in ('sending', 'pending', 'unknown')`: one open attempt per order. Index `(status, next_poll_at)`.
- A trigger refuses `DELETE`, and any change to an attempt in `delivered` or `failed`.

### `order_codes` (new; append-only)
- `order_id` FK, `attempt_id` FK, `position` int 1–50; `ciphertext` bytea (AES-256-GCM, random 96-bit IV, key `ORDER_CODES_SECRET` (32 bytes base64, api and worker environments, separate from `SUPPLIER_KEYS_SECRET`), the code row id as associated data, a key-version prefix); `hint` text nullable (last 4 characters, only for codes of 12 characters or more). Unique `(attempt_id, position)`.

### `order_code_reveals` (new; append-only)
- `code_id` FK, `order_id` FK; `actor` enum (`customer`, `admin`); `actor_id` uuid; `ip` inet; `user_agent` text ≤ 300. Index `(code_id, created_at)`.

### `supplier_webhook_events` (new; owner `suppliers`; append-only but for its processing columns)
- `supplier_id` FK; `event_id` text ≤ 128; unique `(supplier_id, event_id)`; `body_ciphertext` bytea (the raw body encrypted with `ORDER_CODES_SECRET`, since a body may carry codes); `attempt_id` nullable; `processed_at` nullable; `result` enum nullable (`applied`, `same_result`, `unknown_key`, `conflict`, `malformed`). The app role may update only the last three columns (a trigger refuses any other change).

### `order_policy` (new; append-only; the newest row is in force; seeded)
- `first_poll_seconds` 15–600 (60); `fast_poll_seconds` 15–600 (60) until `fast_poll_minutes` 1–60 (10); `slow_poll_seconds` 60–3,600 (300); `hard_limit_minutes` 5–240 (30); `review_poll_minutes` 5–240 (30) until `review_poll_hours` 1–72 (24); `manual_reminder_minutes` 5–240 (15); `admin_id` nullable (null for the seed). Owner, 2026-10-09.

### Ledger accounts
- `sales_revenue:USD` (kind `sales_revenue`), `refunds:USD` (`refunds`), `cost_of_goods:USD` (`cost_of_goods`), `supplier_prepaid:<supplier code>` (`supplier_prepaid`, USD), created on first use by `ensureSystemAccount`.

## States and rules
The state machine is ADR 0004's table plus ADR 0013 (`packages/contracts` `ORDER_TRANSITIONS`). Every status change goes through `transitionOrder(tx, order, to, event)` in `packages/db/src/orders`: `UPDATE … WHERE id = $1 AND status = <from>`, the `order_events` row, and the audit entry when rule AU1 asks for one, in one transaction; a change that matches no row is a lost race and is not retried blindly.

### Purchase (pay step)
- O1. `POST /api/orders` takes `productId`, `quantity`, `fields` and `expectedUnitPriceUsdUnits`, with an `Idempotency-Key`. The same key and body from the same customer returns the first order (`200`); another body, `IDEMPOTENCY_KEY_REUSED`. Rate limit: 10 orders per 10 minutes per customer and 30 per 10 minutes per IP (owner, 2026-10-09: no amount cap beyond the balance and `max_quantity`).
- O2. One READ COMMITTED transaction: take the switches lock shared (S05 SW5) and refuse with `PURCHASES_STOPPED` when `purchases_stopped` is on; lock the product `FOR SHARE` (repricing takes `FOR UPDATE`, so the price read is the price in force); check O3–O5; insert the order as `paid`; post the purchase journal (M1), which locks the wallet and refuses with `INSUFFICIENT_BALANCE`; write the `paid` event, the audit entry and the `orders.fulfil` job. Any refusal rolls everything back.
- O3. The product must be `available` (S07 P6) for this customer: for a test customer, availability is computed over the test routes only (rule R4). Otherwise `PRODUCT_UNAVAILABLE` (with the availability in `details`).
- O4. `expectedUnitPriceUsdUnits` must equal the current price, else `PRICE_CHANGED` with the new price (ADR 0004). `quantity` 1 to the product's `max_quantity`.
- O5. `fields`: every unarchived input field of the game, validated by CT7 (required present, optional may be empty, no unknown key), else `VALIDATION_FAILED` with `details.fields`. Values are stored trimmed.
- O6. The order stores the price row, its minimum margin and, when a rate exists, the SYP total at today's rate and step (display only).

### Routing and sending (A03, A04)
- R1. `orders.fulfil` (one job per order, `stately`) locks the order `FOR UPDATE` and acts only on `paid`, `failed`, or `needs_review` with no open attempt (a failure applied there by F2, such as the admin's "confirmed failed"); otherwise it ends. Remaining units = `quantity − delivered_quantity − refunded_quantity`.
- R2. Candidates are the product's routes usable by S07 RT4 now, in RT5–RT6 order (healthy automatic, degraded automatic, manual; then cost, priority, supplier code), minus: routes already tried for this order; routes not profitable for the price paid (`unit price − unit cost ≥ the order's minimum margin`, ADR 0020); routes whose supplier's newest reported balance is below `unit cost × remaining units`.
- R3. With a candidate, in one transaction: insert the attempt (`sending`, the remaining units, the unit cost, the candidates with their reasons), move the order to `sent_to_supplier`, write the event. Commit, then call `placeOrder(attemptId, offer, units, fields mapped by the route's field_map)` and record the call in `supplier_calls`. The outcome is applied by rule F1. A `manual` attempt makes no call: it goes `pending` at once with the `manual_order` card (rule MN1).
- R4. **Test customers** (owner, 2026-10-09): an order of a test customer only uses routes of the `fake` and `manual` suppliers. In production, where `fake` is off, it waits for the admin on the manual route or is refunded.
- R5. With no candidate: the remaining units are refunded (M3), the order ends `refunded` (nothing delivered: `paid → refunded` by ADR 0013, or `failed → refunded`) or `partially_refunded`, with reason `no_route` (first routing) or `routes_exhausted`, and the customer is notified.
- R6. A definitive failure is final for that route and order (unique `(order_id, route_id)`); the next fulfil run tries the next candidate for the remaining units.

### Outcomes, polling and webhooks (A05, A14)
- F1. `applyOutcome(tx, attempt, outcome, resolvedBy)` locks the order, then the attempt, `FOR UPDATE`, and applies an outcome only to an open attempt (`sending`, `pending`, `unknown`):
  - `delivered` with `q` units: for a code product, exactly `q` codes, else it is treated as `unknown` with reason `codes_missing`; codes stored encrypted (one row per unit); cost of goods posted (M2); the attempt `delivered` with `delivered_quantity = q`; the order's `delivered_quantity += q`. If every unit is delivered: the order `delivered`, `delivered_at` set, the customer notified. Otherwise the order goes `failed` and `orders.fulfil` is queued for the rest (partial delivery, ADR 0004).
  - `pending`: the attempt `pending`, `supplier_order_id` kept, the first poll scheduled.
  - `failed_definitive`: the attempt `failed`. With `inputRejected`, the remaining units are refunded at once (reason `input_rejected`) without trying another route, since every route would refuse the same account; otherwise the order goes `failed` and `orders.fulfil` is queued.
  - `unknown`: the attempt `unknown`, the next poll scheduled. Never another route (ADR 0004).
- F2. From `needs_review` a result is applied the same way, using the transitions that exist there: delivered → `delivered`; partial or failed → straight to routing (`needs_review → sent_to_supplier`) or the refund (`→ refunded`, `→ partially_refunded`); `review_since` cleared.
- F3. `orders.poll` (one per attempt, `stately`, scheduled with `startAfter = next_poll_at`): a `pending` attempt calls `getOrder(attemptId)`; an `unknown` one re-sends `placeOrder` with the same key (idempotent, ADR 0004), since the supplier may never have received it. Each call is recorded in `supplier_calls`; the result goes through F1.
- F4. **Webhooks** (ADR 0005): `POST /api/webhooks/suppliers/:code` reads the raw body (at most 64 KB), refuses a supplier without the `webhooks` capability, an unavailable or unconfigured one (`404`), and a bad signature or timestamp (`401 WEBHOOK_SIGNATURE_INVALID`, logged without the body, counted); then stores the event once (unique `(supplier_id, event_id)`; a replay answers `200` and does nothing) and queues `suppliers.webhook`, answering `200` in well under a second. Rate limit 120 per minute per IP.
- F5. `suppliers.webhook` parses the stored event, finds the attempt by its key and supplier (`unknown_key` when none: kept, no change), and applies it by F1 with `resolvedBy = webhook`. An event for a closed attempt with the same result is `same_result`; with another result (delivered after failed, or failed after delivered) it is `conflict`: no state or money changes, a `note` event on the order and an `order_conflict` Telegram alert (possible double delivery, resolved by the admin and reconciliation).
- F6. **Sweep** (`orders.sweep`, every minute): re-sends attempts left `sending` for over 1 minute (a crash between R3's commit and the call) with the same key; queues polls whose `next_poll_at` passed without a job; moves orders past the hard limit (F7) to `needs_review`; sends due manual reminders (MN2); queues `orders.fulfil` for `paid` or `failed` orders with no job (a lost enqueue).
- F7. **Timing** (owner, 2026-10-09; the order policy): first poll `first_poll_seconds` (60 s) after sending unless a result arrived; then every `fast_poll_seconds` (60 s) until `fast_poll_minutes` (10) after sending, then every `slow_poll_seconds` (5 minutes). An automatic attempt still open `hard_limit_minutes` (30) after `sent_at` moves the order to `needs_review` (reason `hard_limit`): the admin is alerted (`order_needs_review`) and the customer told it is delayed. Polling then continues every `review_poll_minutes` (30) for `review_poll_hours` (24); a result still applies by F2.
- F8. A supplier that was `down` or paused after an attempt was sent does not change that attempt: polls continue with the same supplier and key.

### Manual supplier
- MN1. A manual attempt sends a `manual_order` Telegram card (order number, game and product, quantity, waiting since, a link to `/orders/<id>`; never field values or codes) and appears under "يدوي بانتظارك" (owner, 2026-10-09).
- MN2. One reminder (`manual_order_reminder`) when it is still open `manual_reminder_minutes` (15) after sending. Manual attempts have no hard limit and are never polled; they stay `sent_to_supplier` until the admin resolves them (rule D2).

### Admin decisions (owner, 2026-10-09)
- D1. Decisions apply to an order in `needs_review` or to an open manual attempt; otherwise `ORDER_NOT_DECIDABLE` / `ATTEMPT_NOT_RESOLVABLE`. All require re-authentication (S01 D5) and a reason of 5–500 characters, and write an audit entry. The three that change money or goods take an `Idempotency-Key` (the same key returns the first result).
- D2. **Confirm delivered** (`resolve` with `delivered`): the units delivered (1 to the attempt's units) and, for a code product, exactly that many codes (`CODES_COUNT_MISMATCH`), each 1–200 printable characters; applied by F1 with `resolvedBy = admin`. S11 rule MF1: a manual-supplier attempt is delivered only through the manual fulfil, with its proof and actual cost; D2 stays for held automatic attempts.
- D3. **Confirm failed** (`resolve` with `failed`): the attempt `failed` by F1 (not `inputRejected`); the remaining units go to the next route or are refunded.
- D4. **Poll again** (held automatic attempts only): queues `orders.poll` now; nothing changes until a result comes.
- D5. **Refund** (orders in `needs_review` only): the open attempt is closed `failed` (`resolvedBy = admin`) and the remaining units refunded (reason `admin`), without trying another route. The panel warns that the supplier may still deliver; a later delivery is a `conflict` (F5).
- D6. A delivered or refunded order is final. A make-good after delivery is a wallet adjustment (S02) whose reason names the order number.

### Codes
- C1. Codes are decrypted only to answer a reveal; never in emails, notifications, Telegram, receipts, logs, Sentry events, audit details, job payloads or `result` columns (ADR 0004). Adapter outcomes holding codes are never logged; the worker's log redaction covers `codes`.
- C2. **Customer reveal** (owner, 2026-10-09): the order page lists each code masked with "إظهار"; a tap calls the reveal route, which logs the reveal (time, IP, user agent) and returns the code with a copy button. The page shows "كُشف أول مرة في …". Rate limit 30 reveals per 10 minutes per customer. Responses `Cache-Control: no-store`.
- C3. **Admin reveal**: masked by default (`maskCode`: the hint or dots only); "كشف" needs re-authentication and writes an audit entry (`order.code_revealed`, the code id, never its value) and a reveal row. The panel hides it again after 30 seconds.

### Delivery time
- T1. Per product: the durations `delivered_at − paid_at` of its last 50 `delivered` orders of non-test customers within 30 days; median and p90 (nearest rank); shown only with at least 5, otherwise "لا بيانات بعد" (owner, 2026-10-09). Computed on read from the partial index; S09 shows it on the store.

### Customer view
- O13. The customer sees stages, not internal states: "قيد التنفيذ" (`paid`, `sent_to_supplier`, `failed`), "متأخر، نتحقق منه" (`needs_review`), "تم التسليم", "سُلّم جزئياً واسترد الباقي", "مُسترد" (with the reason in plain words: no available supplier, or the account details were refused), "ملغى" (S09). Never the supplier, costs, attempts or internal reasons.

### Audit
- AU1. Audit entries, in the transaction of the change: `order.paid` (customer), `order.refunded` (system or admin; units, amount, reason), `order.cost_posted` (system; attempt, supplier, units, cost), and every admin action (rules D1–D5, C3, the policy). Other status changes live in `order_events`, as S07 keeps system changes in its own tables.

## Money flows
All USD, no rate (the SYP on the order is display only).
- M1. **Purchase**: journal `purchase`, key `order:<id>:purchase`; `customer_wallet:<customer>` **−total**, `sales_revenue:USD` **+total**. Locks the wallet, refuses `INSUFFICIENT_BALANCE`. Reversed only by M3.
- M2. **Cost of goods** per delivered attempt: journal `cost_of_goods`, key `order:<id>:cost:<attempt>`; `cost_of_goods:USD` **+unit cost × delivered units**, `supplier_prepaid:<supplier>` **−the same** (sub-cent allowed: system accounts). Never reversed by the store; a supplier refund after delivery is reconciliation (S13).
- M3. **Refund** of the remaining units: journal `refund`, key `order:<id>:refund` when nothing was delivered (full) or `order:<id>:refund:<last attempt id>` (undelivered units, ADR 0004); `customer_wallet:<customer>` **+unit price × units**, `refunds:USD` **−the same**. In the transaction of the terminal state; an order has at most one refund journal (`refund_journal_id` unique, the checks of `orders`), so refunds never exceed what was paid.
- Every journal shows on the wallet timeline (S02 W5): `purchase` and `refund` with the order number and product name.

## API
Customer and admin responses `Cache-Control: no-store`; lists follow ADR 0011.

| Method and path | Access | Request | Response | Error codes |
|---|---|---|---|---|
| `POST /api/orders` | Customer, `Idempotency-Key`, 10 / 10 min | `createOrderSchema` (`productId`, `quantity`, `fields`, `expectedUnitPriceUsdUnits`) | `201` `orderSchema` (`200` on a replay) | `PURCHASES_STOPPED`, `PRODUCT_UNAVAILABLE`, `PRICE_CHANGED`, `INSUFFICIENT_BALANCE`, `VALIDATION_FAILED`, `IDEMPOTENCY_KEY_REUSED`, `RATE_LIMITED`, `NOT_FOUND`, `EMAIL_NOT_VERIFIED` |
| `GET /api/orders` | Customer | cursor (20) | page of `orderSummarySchema` (number, product and game names, cover, quantity, total, stage, created) | `VALIDATION_FAILED` |
| `GET /api/orders/:id` | Customer | — | `orderSchema` (stage, product, game, fields with labels, quantities, unit price, total USD and SYP, refunded amount and reason, timeline of stages with times, codes masked with first reveal time, region and redemption text) | `NOT_FOUND` |
| `POST /api/orders/:id/codes/:codeId/reveal` | Customer, 30 / 10 min | — | `{ code, firstRevealedAt }` | `NOT_FOUND`, `RATE_LIMITED` |
| `POST /api/webhooks/suppliers/:code` | Public, HMAC, 120 / min / IP | raw body | `200` | `WEBHOOK_SIGNATURE_INVALID` (`401`), `NOT_FOUND` |
| `GET /api/admin/orders` | Admin | `adminOrderListQuerySchema` (`status?` several, `tab?` `review` \| `manual`, `q?` order number or customer email, `productId?`, `supplier?`, `test?`, `from?`, `to?`, page) | paged `adminOrderSummarySchema` (number, customer, product, quantity, total, status, supplier of the open or last attempt, since) | `VALIDATION_FAILED` |
| `GET /api/admin/orders/counts` | Admin | — | `{ needsReview, manualWaiting }` | — |
| `GET /api/admin/orders/:id` | Admin | — | `adminOrderSchema` (customer summary, fields, events, attempts with candidates and results, journals, masked codes with reveals) | `NOT_FOUND` |
| `POST /api/admin/orders/:id/attempts/:attemptId/poll` | Admin, re-authentication | `{ reason }` | `202` `adminOrderSchema` | `ATTEMPT_NOT_RESOLVABLE`, `REAUTHENTICATION_REQUIRED`, `NOT_FOUND` |
| `POST /api/admin/orders/:id/attempts/:attemptId/resolve` | Admin, re-authentication, `Idempotency-Key` | `{ outcome: 'delivered', quantity, codes?, reason } \| { outcome: 'failed', reason }` | `adminOrderSchema` | `ATTEMPT_NOT_RESOLVABLE`, `CODES_COUNT_MISMATCH`, `VALIDATION_FAILED`, `REAUTHENTICATION_REQUIRED`, `IDEMPOTENCY_KEY_REUSED`, `NOT_FOUND` |
| `POST /api/admin/orders/:id/refund` | Admin, re-authentication, `Idempotency-Key` | `{ reason }` | `adminOrderSchema` | `ORDER_NOT_DECIDABLE`, `REAUTHENTICATION_REQUIRED`, `IDEMPOTENCY_KEY_REUSED`, `NOT_FOUND` |
| `POST /api/admin/orders/:id/codes/:codeId/reveal` | Admin, re-authentication | — | `{ code }` | `REAUTHENTICATION_REQUIRED`, `NOT_FOUND` |
| `GET` · `PUT /api/admin/orders/policy` | Admin; `PUT` re-authentication | `orderPolicySchema` | `orderPolicySchema` | `REAUTHENTICATION_REQUIRED`, `VALIDATION_FAILED` |
| `GET /api/admin/catalog/games/:id` (S06) | Admin | — | adds per product `deliveryStats` (`{ medianMs, p90Ms, count } \| null`) | — |
| `GET /api/admin/wallets/:customerId/entries` · `GET /api/wallet/entries` (S02) | — | — | `purchase` and `refund` entries carry the order number and product name | — |

Statuses: `409` for `PURCHASES_STOPPED`, `PRODUCT_UNAVAILABLE`, `PRICE_CHANGED`, `INSUFFICIENT_BALANCE`, `ORDER_NOT_DECIDABLE`, `ATTEMPT_NOT_RESOLVABLE`, `IDEMPOTENCY_KEY_REUSED`; `400` for `CODES_COUNT_MISMATCH`. S09 adds the `awaiting_balance` choice to `POST /api/orders` and the SSE timeline.

## Jobs and integrations
- `orders.fulfil` (`stately` per order; payload `{ orderId }`): R1–R6. Retries: 3 with backoff; safe twice because it acts only on the statuses of R1 under the order lock, and the open-attempt index allows one open attempt per order.
- `orders.poll` (`stately` per attempt; `{ attemptId }`): F3; safe twice (F1 applies only to open attempts; the same key at the supplier).
- `suppliers.webhook` (`{ eventId }`): F5; safe twice (`processed_at`).
- `orders.sweep` (every minute): F6, MN2.
- Supplier calls through `SupplierRegistry` with decrypted credentials, each recorded in `supplier_calls` (operations `place_order`, `get_order`), so they count toward health (S07 H1). A call's timeout is the adapter's.
- Telegram (S05 write path): `manual_order` (dedupe `manual:<attempt>`), `manual_order_reminder` (`manual-reminder:<attempt>`), `order_needs_review` ("⏳ الطلب VO-… بحاجة لمراجعة: لا جواب نهائي من WDGZone منذ 30 دقيقة", `review:<order>:<review_since>`), `order_conflict` (`conflict:<webhook event>`). None carries field values or codes. The daily summary (AL3) adds: orders delivered, partly refunded and refunded today, open reviews, manual orders waiting, and the day's median delivery time.
- Customer notifications (S05 `notifyCustomer`, in the transaction of the change; owner, 2026-10-09): `order_delivered`, `order_partially_refunded` (units and amount refunded), `order_refunded` (amount and reason), each in the center and by email unless turned off; `order_delayed` in the center only, never by email. Params: order number, product name, amounts; never codes or field values. Each links to `/orders/<id>`. The S05 stream lets an open order page refetch (NT7).
- Encryption helpers for codes and webhook bodies in `packages/db` (AES-256-GCM, as S07's credentials), used by the api (reveal, webhook intake) and the worker (codes, parsing).
- **Fake supplier** (development and E2E): `placeOrder` and `getOrder` follow a per-offer script from the state file, default `delivered` at once (code offers return generated codes). The CLI adds `--order <offer> delivered|pending|failed|invalid|unknown|partial:<n>|slow:<seconds>` (how that offer's next orders answer), and `--resolve <order number> delivered|failed --via poll|webhook` (the next poll answers it, or the CLI posts a signed webhook to the local API with the fake's stored webhook secret).
- **`order:place`** (api CLI, refused when `NODE_ENV=production`): `pnpm --filter @vertex-digital/api order:place --email <customer> --product <id> [--quantity <n>] [--field <key>=<value>]…` buys at the product's current price through the same service as `POST /api/orders` and prints the order number, until S09's buy box exists.

## Screens

### Store (phone width first, Arabic RTL, dark default)
- **`/orders` "طلباتي"** (linked from the account menu and the wallet's purchase entries): cards newest first (game cover, product, quantity, total USD with SYP at purchase, stage chip, time), "تحميل المزيد". Read in the browser with the session cookie (as the wallet). Empty: "لا طلبات بعد" with a link to the games. Loading skeletons; error with retry.
- **`/orders/[id]`**: the order number with copy, the stage with a plain sentence ("نشحن طلبك الآن"، "تأخّر المورد، نتحقق منه وسنعلمك"، "تم التسليم"…), the stage list with times, product and game, the account fields (labels and values), quantity, unit price, total, refunded amount and reason when any. Code products: one row per code, masked, "إظهار" then the code with "نسخ" and "كُشف أول مرة في …", then the region and redemption instructions. Refetched when a notification for this order arrives. Another customer's order: the store's not-found page.

### Admin (Arabic, RTL, light and dark)
Navigation adds "الطلبات" (`/orders`) with a badge of `needsReview + manualWaiting`, read every minute in the background.
- **`/orders`**: tabs "الكل"، "بحاجة لمراجعة"، "يدوي بانتظارك"، "قيد التنفيذ"، "مكتملة"، "مستردة"; table (number, customer with "تجريبي" chip, product, quantity, total, status, supplier, since); filters (product, supplier, test, dates) and search by number or email; filters and page in the URL. Empty per tab ("لا طلبات بحاجة لمراجعة"). Loading and error states.
- **`/orders/$id`**: header (number, status, customer link to the wallet, totals, delivered and refunded units); the decision panel when allowed (D1–D5: "اسأل المورد مجدداً"، "تأكّدت: تمّ التسليم" with units and code fields for code products، "تأكّدت: فشل"، "استرداد" with its warning; each with a required reason and the re-authentication dialog); the account fields; attempts newest first (supplier, offer, units, unit cost, key, supplier reference, status, resolved by, polls, times, the candidates table with each skip reason); the events timeline; journals with amounts; codes masked with "كشف" (re-authentication, hidden after 30 s) and the reveal log; the webhook events of each attempt.
- **Game page "الباقات" (S06/S07)**: a "وقت التسليم" column (median and p90, or "لا بيانات بعد").
- **`/orders/policy`** (under "الطلبات"): the policy fields with defaults, in seconds, minutes and hours, re-authentication on save.
- Every error shows its code's translation; dialogs keep their values on error.

## Audit and notifications
- Audit (AU1): `order.paid`, `order.cost_posted`, `order.refunded`; admin actions `order.poll_requested`, `order.attempt_resolved` (outcome, units, reason; code count, never codes), `order.refund_decided`, `order.code_revealed`, `order_policy.set` (before/after). Entity types `order`, `order_policy`.
- Customer notifications and Telegram messages: as in "Jobs and integrations".

## Abuse and fraud
| Threat | Control |
|---|---|
| Double tap or replayed request buying twice | `Idempotency-Key` unique per customer with the body hash; the wallet lock serializes parallel purchases |
| Buying at an old or forged price | The server reads the price in force under the product lock; `PRICE_CHANGED` otherwise; the client sends only an expectation |
| Selling below cost after a cost rise | Availability at pay; the guard again per attempt against the order's minimum margin; no unprofitable route is ever used, the units are refunded instead |
| Paying two suppliers for one sale | An unknown outcome is polled or re-sent with the same key, never routed elsewhere; one open attempt per order; a route tried once; conflicts alerted |
| Forged or replayed webhooks | HMAC with a timing-safe compare and a timestamp tolerance, unique event id, body size cap, rate limit; the webhook only reports what polling can confirm |
| A stolen customer session spending the wallet on codes | Purchase rate limit, the new sign-in email (S01), the reveal log with IP and device shown to the customer and the admin (owner, 2026-10-09: no amount cap) |
| Codes leaking from the database, logs or messages | AES-256-GCM with a separate key, codes never in logs, Sentry, Telegram, emails, receipts, audit or payloads; log redaction; webhook bodies encrypted |
| A stolen admin session issuing refunds or reading codes | Re-authentication on every decision and reveal, reasons, audit; refunds only to the customer's wallet; delivered orders cannot be refunded |
| Reading another customer's orders or codes | Routes scoped to the session's customer; `NOT_FOUND` otherwise; UUID ids |
| Test accounts spending real supplier balance | Test orders use only the `fake` and `manual` suppliers (R4) |
| Draining a supplier's balance | A route below the order's cost is skipped (R2); the S07 balance alert |
| Wrong player ID burning money | An `inputRejected` failure refunds at once (S09 adds validation before paying) |
| Order number guessing | Numbers are display only; every lookup goes by id under the customer's session or the admin |

## Edge cases
1. Two purchases from one wallet at once: the wallet lock serializes them; the second may get `INSUFFICIENT_BALANCE`.
2. A repricing commits between the customer's view and the purchase: `PRICE_CHANGED` with the new price; a repricing waiting on the product lock applies after the order and does not touch it (S07 P7).
3. The purchase stop turns on during a purchase: the shared lock means the purchase commits before the stop or is refused; paid orders continue.
4. The basis supplier goes down between payment and routing: the router takes the next profitable route, or refunds (ADR 0013).
5. The worker crashes after writing the attempt and before calling: the sweep re-sends with the same key after a minute.
6. The call times out: `unknown`; polls re-send with the same key; a supplier that had the order answers its outcome.
7. A webhook arrives before `placeOrder` returns: both go through F1 under the locks; the first result closes the attempt, the second is ignored.
8. Partial delivery of 7 of 10 codes: 7 codes stored, cost for 7, the order `failed`, the next route for 3; with none left, 3 units refunded and the order `partially_refunded`.
9. Every route fails definitively: full refund (`routes_exhausted`), the customer notified.
10. A supplier answers "delivered" for a code product without codes: treated as `unknown` (`codes_missing`), polled, then held for the admin.
11. A late delivery after the admin refunded: `conflict` alert, no money moves; the admin settles with the supplier (S13).
12. The admin confirms failed while a poll is running: both lock the order then the attempt; the first wins, the other finds the attempt closed.
13. The product, game or route is archived after payment: the order keeps its data; an archived route is unusable for new attempts; open attempts continue.
14. An input field is archived after payment: the order keeps its value; a route needing it is unusable (S07 RT3), so the next route or a refund.
15. The customer is a test customer in production with no manual route: refunded at once (`no_route`).
16. `ORDER_CODES_SECRET` missing: the api and worker refuse to start.
17. Quantity above a product's `max_quantity` lowered after payment: the order keeps its quantity.
18. A manual order waits overnight: one reminder after 15 minutes, then the daily summary's count; the customer sees "قيد التنفيذ".
19. A webhook for an unknown key (another environment, an old order): stored as `unknown_key`, nothing changes.

## Open questions
- Q12 (part): each real adapter maps its supplier's order statuses, partial results, duplicate-key answers and webhook format to the interface above in its own PR. Not a blocker for S08, which is built and accepted with the `fake` and `manual` suppliers.

## Acceptance
The owner's browser check (local, `pnpm dev`, `SUPPLIER_FAKE_ENABLED=true`, `TELEGRAM_TRANSPORT=log`, S06/S07 data: "60 UC" routed to `fake-uc-60` with a manual route, an iTunes code product routed to a fake code offer; a test customer with $50 of test funds):
1. `order:place --email <test customer> --product <60 UC> --field player_id=5123456789`: the order is `delivered` within seconds; the wallet shows the purchase entry with the order number; `/orders` and the order page show "تم التسليم"; a notification and an email arrive.
2. `supplier:fake --order fake-uc-60 failed`, then buy: the order goes to the manual route; a `manual_order` card arrives; in `/orders` "يدوي بانتظارك", "تأكّدت: تمّ التسليم" (re-authentication, a reason): delivered.
3. Archive the manual route, keep `failed`, buy: refunded in full (`routes_exhausted`); the wallet is back; the customer sees "مُسترد".
4. `--order fake-uc-60 invalid`: refunded at once with "بيانات الحساب مرفوضة", no other route tried.
5. `--order <code offer> partial:2`, buy 3 codes with no other route: 2 codes, 1 unit refunded, "سُلّم جزئياً واسترد الباقي". Reveal a code: it shows with "كُشف أول مرة في …"; the admin's order page shows it masked and reveals it with re-authentication; the audit log has the reveal without the code.
6. `--order fake-uc-60 pending`, buy, then `--resolve <number> delivered --via webhook`: delivered by the webhook. Again with `--via poll`: delivered at the next poll.
7. `--order fake-uc-60 unknown`, buy; set the policy's hard limit to 5 minutes: the order turns "بحاجة لمراجعة" with a Telegram alert and "متأخر، نتحقق منه" for the customer. "تأكّدت: فشل": the manual route or a refund follows. Repeat and "استرداد": refunded.
8. Turn on the purchase stop: `order:place` is refused with `PURCHASES_STOPPED`.
9. Change the fake cost so the held price is unprofitable (S07 step 4) and buy: refused `PRODUCT_UNAVAILABLE`.
10. The game page shows "وقت التسليم" after five delivered orders (non-test: use a second, non-test customer with a manual-deposit adjustment).

Tests:
- Contracts (100% coverage): transitions, `orderCustomerStage`, money helpers, `routeProfitable` at the boundary, `orderCandidates` (each skip reason, tiers, test customers), `nextPollAt` and `pastHardLimit` at every boundary, `deliveryStats` (under 5, nearest rank), order number parsing, `maskCode`.
- Database (real PostgreSQL): the checks and triggers of `orders`, `fulfilment_attempts` and the append-only tables; grants; `transitionOrder` lost race; one refund per order; refunds never above the total; one open attempt per order.
- Concurrency and idempotency: parallel purchases on one wallet, the same `Idempotency-Key` in parallel, purchase against a concurrent repricing and a concurrent stop, a webhook and a poll on one attempt, an admin decision against a late result, the sweep against a slow `placeOrder`.
- API, every route: success, 401, a customer session on admin routes, another customer's order (404), re-authentication where required, every error code, `no-store`, codes never in a response but the reveal; webhook signature, timestamp, replay and size.
- Worker: routing (each tier, guard, balance, already tried, test customers), every outcome, partial delivery, input rejection, polling schedule and the hard limit, review polling, the sweep, webhooks (applied, same result, unknown key, conflict), manual cards and reminder, notifications and Telegram with their dedupe keys; codes never logged (a log capture test).
- Encryption: round trip, a ciphertext moved to another row fails, a wrong key fails.
- E2E with RTL screenshots: store `/orders` (empty and with orders) and the order page (delivered top-up, codes masked and revealed, partly refunded, delayed) at phone width; admin `/orders` tabs, the order page with the decision panel and attempts, the policy page, light and dark.

## Implementation notes
- Suggested split, each leaving `main` green:
  1. Contracts, db (tables, enums, seeds, triggers, the order write path: `purchase`, `transitionOrder`, `applyOutcome`, `refundRemaining`, codes encryption), the `orders` API module (customer and admin routes, the webhook intake), `order:place`, OpenAPI and the admin client.
  2. Worker: `orders.fulfil`, `orders.poll`, `orders.sweep`, `suppliers.webhook`, Telegram kinds, notifications, daily summary lines; the fake adapter's order scripting and CLI options; the adapter interface change.
  3. Store `/orders` and the order page; admin `/orders`, the order page, the policy page and the delivery time column; E2E and screenshots.
- Module layering: `orders` sits above `catalog`, `pricing`, `suppliers`, `wallet` and `settings`, reading them through their services; the webhook intake belongs to `suppliers` and hands events to the worker.
- Update `docs/architecture.md` (the `orders` and `suppliers` rows, worker jobs), `.env.example` (`ORDER_CODES_SECRET`), `docs/deployment.md` (the key on api and worker), the commands table (`order:place`, the fake supplier's new options), and S02's timeline extras.

## Settled in implementation
PR 1 (contracts, db, api, 2026-10-09):
- The adapter interface change (`delivered.quantity`, `failed_definitive.inputRejected`, a repeated key answering the order's current outcome) ships in PR 1 with the fake adapter (an `invalid…` player is refused with `inputRejected`), since the write path applies those outcomes; the Telegram kinds and the daily summary lines move to PR 2 with the jobs that send them.
- `orders.idempotency_key` is unique across customers (the database convention for keys): another customer's key answers `IDEMPOTENCY_KEY_REUSED`, never their order. A replay of the same key and body answers even while purchases are stopped; a new purchase does not.
- The 10-entry cap of `orders.fields` is the contract's (`createOrderSchema`); PostgreSQL checks only that it is an object (a check cannot count keys).
- Column names: `fulfilment_attempts.supplier_error_code` (the supplier's own error code, not its supplier), `supplier_offer_id` (the offer id sent), `reminded_at` (rule MN2), `decision_idempotency_key` (rules D2, D3); `orders.refund_idempotency_key` (rule D5). A decision's key is replayed even when the second request waited on the order lock behind the first.
- Polling times: `firstPollAt(sentAt, policy)`, then `nextPollAt(sentAt, now, policy)` from the time of each poll (so a late worker does not poll in a burst), null once `review_poll_hours` past the hard limit; `manualReminderAt` for MN2.
- The admin list's `status` filter takes one status; the tabs (`all`, `review`, `manual`, `active`, `delivered`, `refunded`) carry the sets of statuses.
- Every product response carries `deliveryStats` (rule T1), so S09 can show it on the store without another route.
- The code reveal's audit detail names the stored row `itemId` (the audit test refuses any detail key containing "code").
- `awaiting_balance` reads as `processing` for the customer until S09 defines its stage.
- A webhook the adapter cannot parse is stored under `malformed:<SHA-256 of the body>` for the worker to mark `malformed`.
- The purchase rate limits count in `customer_rate_limits` (every request, refused or not, as S01's counters); nginx adds `vdpurchase` (POST only), `vdreveal` and `vdwebhook`.

PR 2 (worker, 2026-10-09):
- A manual attempt is written `pending` in the routing transaction (no `sending` step: there is no call), with its `manual_order` card; it is never polled and has no hard limit.
- The sweep calls no supplier itself: it queues `orders.poll` for a `sending` attempt older than a minute (the poll sends it again with its key) and for a poll a minute late, and `orders.fulfil` for a `paid` or `failed` order with no open attempt untouched for a minute; both queues are `stately`, so a job already queued makes these no-ops. At most 100 rows per step and run.
- Order calls count for health (S07 H1) by their outcome: `delivered` and `pending` are `ok`, `failed_definitive` is `refused`, `unknown` is `error`. A supplier with no adapter or credentials when an attempt is sent or polled gives `unknown` (`supplier_unavailable`) and keeps its schedule (rule F8).
- A webhook whose key is not a UUID or names no attempt of that supplier is `unknown_key`; a webhook whose adapter is gone by the time the worker reads it fails the job (retried, then alerted), since the API verified it with that adapter. A `pending` or `unknown` report on a closed attempt counts as `same_result`.
- The fake supplier's scripted `unknown` stays unknown, polled or sent again, until `--resolve` (so the hard limit can be seen, acceptance step 7); the `unknown…` player prefix still settles delivered at the first poll. A code offer orders without a `playerId`. `--resolve --via webhook` posts to `API_HOST:API_PORT` (default `127.0.0.1:3000`).
- The daily summary counts real customers' orders by the day they ended (`finished_at`); the review and manual counts and nothing else include test customers' orders, since the admin acts on those too. The day's median delivery time is the nearest-rank median of the day's deliveries (one is enough).
- `fulfilment_attempts.field_map` keeps the route's field map (names only, no values) the attempt was written with; every re-send under the attempt's key builds the same fields from it, so a map changed in the panel meanwhile cannot turn a re-send into a reused-key refusal and a second route (reviewer finding).
- A result that reaches an attempt already closed is compared by rule F5 whatever brought it: a webhook (`conflict:<webhook event>`), a poll's answer after the admin's decision or a webhook (`conflict:<attempt>:poll`), or the first call's late answer (`conflict:<attempt>:supplier`); a conflict writes a `note` (`webhook_conflict` or `late_result_conflict`) and the `order_conflict` alert, and changes no state, money or codes (reviewer finding).
- The worker's logs redact `codes` up to four levels deep (`apps/worker/src/core/config/log-redact.ts`), under the rule that outcomes are never logged.
