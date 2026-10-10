# S11 — Live operations (F17, F18)

Status: Approved · Date: 2026-10-10 · Scope: `docs/product/v1-scope.md` §F17, §F18 (A14) · ADRs: 0003, 0004, 0005, 0011, 0016, 0019, 0020, 0022, 0025

## Summary
S08 gave the admin an order list, an order page and four decisions on held orders, but nothing moves on screen and the panel's home page is empty. S11 adds the **live orders room** (`/orders/live`): four columns of open and just-finished orders that update over a new admin SSE stream, slow orders turning amber past their product's measured delivery time, an optional sound when an order needs the admin, and a side sheet with every action. It adds three actions: **reroute** a held or manual order to a route the admin picks, **manual fulfil** with a required screenshot and the actual cost, and **refund** of an order waiting on the manual supplier. The panel's home page becomes the **dashboard**: today's sales and profit against yesterday at the same hour, orders by state, deposits waiting, suppliers' balances and health, the exchange rate and a "needs your attention" list (owner, 2026-10-10).

## In scope / out of scope
- In:
  - Admin SSE stream (`GET /api/admin/stream`) with order status events.
  - The live board read (`GET /api/admin/orders/live`) and the `/orders/live` screen with filters, slow-order colors, sound and tab-title count.
  - Reroute to an admin-chosen eligible route (orders in `needs_review`, open manual attempts).
  - Manual fulfil with a delivery proof image, an optional reference and the actual unit cost (the same two cases); it replaces S08's "confirm delivered" for manual attempts.
  - Refund of an order with an open manual attempt (S08 D5 extended).
  - The dashboard read (`GET /api/admin/dashboard`) and the panel home page.
- Out (later or never):
  - Reports by period, by game, product and supplier, and Excel export: S13 (F22). The dashboard shows today, yesterday to the same hour and a 7-day sales line only.
  - Reconciliation of `supplier_prepaid:manual` and supplier funding: S13 (F20).
  - Customers administration (profiles, limits, freezing): S12.
  - Rerouting or refunding while an automatic attempt is still running before the hard limit: never (ADR 0004; the order reaches `needs_review` after 30 minutes).
  - Selecting an unprofitable route on reroute: never (owner, 2026-10-10).
  - Showing the delivery proof to the customer: never; it is the admin's record.
  - Bulk actions on several orders, a stored alerts table, a history of Telegram alerts on the dashboard: not in V1.

## Access
| Action | Route kind | Who |
|---|---|---|
| Open the admin stream; read the live board, the dashboard, an order's route options | Admin | The admin |
| Upload a delivery proof | Admin, re-authentication | The admin |
| Reroute, manual fulfil, refund (extended) | Admin, re-authentication, `Idempotency-Key` | The admin |
| Send a rerouted attempt, apply its outcome | Worker jobs (S08 `orders.poll`, F1) | System |

Every route lives under `/api/admin/` and requires the TOTP-complete admin session (ADR 0016). Customer sessions get `401`/`403`.

## Data
Money is USD units (micro-dollars, ADR 0003). The changes are to S08's tables; no new business table.

### Contracts (`orders.ts`, `dashboard.ts` new, `files.ts`, `audit.ts`, `errors.ts` extended)
- `ATTEMPT_KINDS` (`routed`, `admin_fulfil`).
- `LIVE_COLUMNS` (`at_supplier`, `manual`, `review`, `finished`) and `liveColumn(order, openAttempt)`: `review` for `needs_review`; `manual` for `sent_to_supplier` with an open attempt of the `manual` supplier; `at_supplier` for `paid`, `failed` and any other `sent_to_supplier`; `finished` for `delivered`, `partially_refunded`, `refunded` finished within 60 minutes; null otherwise (`awaiting_balance`, `cancelled`, older finished orders).
- `slowAfterSeconds(deliveryStats)` (rule LR3): `max(120, ceil(p90Ms / 1000))`, or 600 when the stats are null.
- `damascusDayBounds(now)` (reuse the daily summary's helper if it exists, else add it here): today's start, the same instant yesterday, yesterday's start, and the starts of the last 7 days, in `Asia/Damascus`.
- `deltaPercent(today, yesterday)`: null when yesterday is 0.
- Schemas: `liveBoardQuerySchema`, `liveBoardSchema`, `liveOrderCardSchema`, `adminStreamEventSchema`, `rerouteOptionsSchema`, `rerouteOrderSchema`, `fulfilOrderSchema`, `deliveryProofSchema`, `dashboardSchema`, `attentionItemSchema` (`kind`, `count`, `oldestAt?`, `target` path, `params`).
- `ATTENTION_KINDS` (rule DB6).
- `STORED_FILE_KINDS` gains `delivery_proof`.
- Error codes: `ROUTE_NOT_ELIGIBLE` (`details.reason`: a `ROUTE_SKIP_REASONS` value), `LOSS_NOT_CONFIRMED` (`details.unitCostUsdUnits`, `details.unitPriceUsdUnits`), `PROOF_INVALID` (missing, of another kind, or already used); existing `ORDER_NOT_DECIDABLE`, `ATTEMPT_NOT_RESOLVABLE`, `CODES_COUNT_MISMATCH`, `FILE_INVALID` (or the upload error the catalog image route already uses), `REAUTHENTICATION_REQUIRED`, `IDEMPOTENCY_KEY_REUSED`, `VALIDATION_FAILED`, `RATE_LIMITED`, `NOT_FOUND`. Each with its Arabic text.
- 100% coverage for the pure functions above.

### `fulfilment_attempts` (S08; changed by migration)
- `kind` enum `attempt_kind`, required, default `routed` (existing rows `routed`).
- `route_id`, `offer_id`, `supplier_offer_id` nullable; a check requires them for `routed` and forbids them for `admin_fulfil`. The unique `(order_id, route_id)` is unchanged (nulls never collide).
- `admin_fulfil` attempts belong to the `manual` supplier row (`supplier_id`), are inserted already `delivered` with `resolved_by = 'admin'` and `admin_reason`, and are never polled or swept.
- `unit_cost_usd_units` check becomes `≥ 0` (was `> 0`), and `> 0` stays for `routed`. The `delivered ⇔ cost_journal_id` check becomes `cost_journal_id is not null ⇔ (status = 'delivered' and unit_cost_usd_units > 0)`: a zero-cost manual fulfil posts no journal.
- `proof_file_id` uuid FK `stored_files` nullable, unique; `delivery_reference` text nullable 1–200; a check: `proof_file_id` is set when `kind = 'admin_fulfil'`, or when a `manual`-supplier attempt was resolved `delivered` by the admin after this migration (the API enforces the second case; old rows keep null).
- `chosen_by_admin` boolean default `false`: set on an attempt created by reroute; its `candidates` jsonb records every route with its eligibility at that moment and the chosen one.
- The S08 triggers stay: no delete, no change once `delivered` or `failed`.

### `stored_files` (S03; changed)
- Kind `delivery_proof`: re-encoded like a deposit receipt (`RECEIPT_MAX_DIMENSION`, metadata stripped, JPEG/PNG/WebP in, at most 10 MB in), served only to the admin with `Cache-Control: no-store`.

### Ledger accounts
- `supplier_prepaid:manual` (exists from S08 M2) also takes manual fulfil costs.

## States and rules
The order state machine is unchanged (ADR 0004, 0013). Every change still goes through `transitionOrder` and `applyOutcome` in `packages/db/src/orders`; the new write paths `rerouteOrder` and `fulfilOrderManually` live there too.

### Live room
- LR1. **Board:** `GET /api/admin/orders/live` returns the four columns of `liveColumn`, each with its total count and at most 100 cards: `at_supplier`, `manual` and `review` oldest first (by `paid_at`), `finished` newest first. Filters: `supplier` (the open or last attempt's), `gameId`, `test` (`all` default, `hide`, `only`). The response also carries the count of `awaiting_balance` orders and `generatedAt`.
- LR2. **Card:** order id and number, game and product names, quantity, total, status, the "تجريبي" flag, customer email, the open (or last) attempt's supplier name and status, `paid_at`, the open attempt's `sent_at`, `review_since`, `finished_at`, and `slowAfterSeconds` for `at_supplier` cards (null for the others). Never field values or codes.
- LR3. **Slow orders** (A14; owner, 2026-10-10): an `at_supplier` card turns amber ("متأخر") when `now − paid_at > slowAfterSeconds`, from the product's delivery stats (S08 T1): its p90 with a floor of 2 minutes, 10 minutes when the product has fewer than 5 measured orders. `review` cards are red. The colors are computed in the panel from the card's times, so they change without a refetch.
- LR4. **Live updates:** the panel opens `GET /api/admin/stream` (SSE). The API's LISTEN connection (S05 NT6) already receives `customer_orders` (`<customer>:<order>:<status>`, the `orders_notify` trigger of S09 LT2); it also forwards every such event to the admin's open streams as `order` `{ orderId, status }`. A dropped LISTEN connection sends `resync`. A heartbeat comment every 25 seconds. At most 3 open admin streams (a 4th closes the oldest), 30 connects a minute, the session checked at connect and every 5 minutes; the stream closes when the session ends.
- LR5. The board refetches (debounced 1 second) on any `order` event, on `resync`, on reconnect and on `visibilitychange`; it also refetches every 60 seconds so the `finished` column drops orders older than an hour. The header shows "مباشر" while the stream is open and "إعادة الاتصال…" otherwise.
- LR6. **Sound and tab title** (owner, 2026-10-10): the page title starts with `(n)` where n is `review + manual`. When a refetch shows an order id new to the `review` or `manual` column, the panel plays a short sound if the "صوت" toggle is on. The toggle is off by default and remembered in the browser (`localStorage`, read in try/catch); turning it on is the user gesture browsers require.
- LR7. **Side sheet:** clicking a card opens the order in a side sheet (number, status, product, customer, quantities, the open attempt with its supplier, status, polls and times, the last 5 events) with the actions allowed for it (rules RR, MF, RF and S08 D2–D5) and a link to `/orders/$id`. After an action, the sheet shows the new state and the board refetches.

### Reroute (owner, 2026-10-10)
- RR1. Allowed for an order in `needs_review`, or an order in `sent_to_supplier` whose open attempt belongs to the `manual` supplier; otherwise `ORDER_NOT_DECIDABLE`. Re-authentication, a reason of 5–500 characters, an `Idempotency-Key`.
- RR2. **Options:** `GET /api/admin/orders/:id/routes` lists every unarchived route of the product with: supplier, offer, tier, unit cost, the margin at the order's unit price, the supplier's health and newest balance, and either `eligible` or its skip reason. Eligibility is S08 R2 for this order and its remaining units: usable now (S07 RT4), not already tried for this order, profitable against the order's minimum margin, the supplier's newest balance at least `unit cost × remaining units` (not checked for `manual`), and for a test customer only `fake` and `manual` (R4). The open attempt's route counts as tried.
- RR3. **Reroute** (`POST /api/admin/orders/:id/reroute` with `routeId` and `reason`), one transaction: lock the order then its open attempt `FOR UPDATE`; recheck RR1 and the chosen route's eligibility (`ROUTE_NOT_ELIGIBLE` with the reason otherwise); close the open attempt `failed` (`resolved_by = 'admin'`, the reason, not `input_rejected`); move the order to `sent_to_supplier` (from `needs_review` directly; from `sent_to_supplier` through `failed`, two transitions in the transaction); insert the new attempt for the remaining units with `chosen_by_admin = true` and the candidates; write the events and the audit entry. A `routed` attempt on an automatic supplier is inserted `sending` and `orders.poll` is queued at once (a poll of a `sending` attempt sends it with its key, S08 PR 2 notes); on the `manual` supplier it is inserted `pending` with the `manual_order` card (S08 MN1).
- RR4. The panel warns before confirming on a `needs_review` order: "قد يسلّم المورد الحالي لاحقاً فتدفع لموردين". A later result for the closed attempt is a conflict (S08 F5): no state or money change, the `order_conflict` alert.
- RR5. The new attempt follows S08 from there: outcomes, polling, the 30-minute hard limit, refunds.

### Manual fulfil (owner, 2026-10-10)
- MF1. Allowed in the same two cases as RR1 (`ORDER_NOT_DECIDABLE` otherwise), with re-authentication, a reason, an `Idempotency-Key`. For an open manual attempt it replaces S08 D2: `POST …/attempts/:attemptId/resolve` with `outcome: 'delivered'` on a `manual`-supplier attempt answers `ATTEMPT_NOT_RESOLVABLE` (`details.use = 'fulfil'`); `outcome: 'failed'` is unchanged. D2 stays as it was for held automatic attempts (the supplier did deliver; its cost is the attempt's).
- MF2. **Proof:** the admin first uploads one image (`POST /api/admin/orders/:id/proof`, re-authentication, multipart), stored as a `delivery_proof` file and answered with its id. Fulfil requires `proofFileId`: a `delivery_proof` file not used by another attempt (`PROOF_INVALID`). An optional `reference` (1–200 characters: the operation number at the other source). An unused proof file stays unreferenced; it is never shown anywhere.
- MF3. **Units and codes:** `quantity` 1 to the remaining units; for a code product exactly `quantity` codes of 1–200 printable characters (`CODES_COUNT_MISMATCH`), stored encrypted as S08 C1.
- MF4. **Cost:** `unitCostUsdUnits` required, whole cents, from $0 to $100,000; the form defaults to the product's manual route's offer cost when one exists, else empty. When it is above the order's unit price, `acceptLoss: true` is required (`LOSS_NOT_CONFIRMED` otherwise); the panel shows the loss and asks for a ticked confirmation.
- MF5. **Write**, one transaction: lock the order then its open attempt; recheck MF1. For an open manual attempt: set its `unit_cost_usd_units` to the entered cost (allowed only while the attempt is open), its proof and reference, and apply `delivered` with `quantity` and the codes by S08 F1 (`resolved_by = 'admin'`). For a `needs_review` order: close the open automatic attempt `failed` (`resolved_by = 'admin'`, the reason), then insert an `admin_fulfil` attempt for `quantity` units with the cost, proof and reference, and apply `delivered` to it by F1/F2. Cost of goods is posted by M2 when the cost is above zero. Remaining units follow S08 (the order goes `failed` and `orders.fulfil` routes them, or they are refunded). The customer gets `order_delivered` as with any delivery.
- MF6. The panel warns on a `needs_review` order as RR4; a later supplier delivery is a conflict.

### Refund (S08 D5 extended)
- RF1. `POST /api/admin/orders/:id/refund` is also allowed for an order in `sent_to_supplier` with an open `manual`-supplier attempt (owner, 2026-10-10): the attempt is closed `failed` (`resolved_by = 'admin'`), the order goes through `failed` to `refunded` or `partially_refunded` in the same transaction, the remaining units refunded (M3, reason `admin`), without another route. Other cases keep S08's rules: `needs_review` only, `ORDER_NOT_DECIDABLE` otherwise. A running automatic attempt before the hard limit is never refunded.

### Dashboard (owner, 2026-10-10)
- DB1. `GET /api/admin/dashboard` answers the panel home page. "Today" is the `Asia/Damascus` calendar day so far; "yesterday" is yesterday from its start to the same clock time. Money and order counts cover **real customers only** (not `is_test`); the attention list and the live counts include test orders, since the admin acts on them (as the daily summary, S08 PR 2 notes).
- DB2. **Sales and profit** by orders finished in the period (`finished_at`): sales = Σ `delivered_quantity × unit_price_usd_units`; cost = Σ over their delivered attempts `delivered_quantity × unit_cost_usd_units`; profit = sales − cost; margin % = profit ÷ sales (null when sales are 0). Also delivered orders (count of `delivered` and `partially_refunded`), refunds (count of `refunded` and `partially_refunded`, Σ `refunded_usd_units`), and today's median delivery time (nearest rank over today's deliveries, as the daily summary). Each of sales, profit, delivered and refunds carries yesterday's value and `deltaPercent`.
- DB3. **Sales line:** sales per day for the last 6 full days and today (7 points), by the same definition.
- DB4. **Now:** the live column counts (LR1, test included), the `awaiting_balance` count, and the value still owed to customers in open paid orders (Σ `unit_price × (quantity − delivered − refunded)` over `paid`, `sent_to_supplier`, `failed`, `needs_review`, real customers).
- DB5. **Deposits:** Sham Cash deposits waiting review (count, oldest `submitted_at`, flagged count), USDT deposits waiting confirmation (count), unmatched USDT transfers open, and today's credited deposits (count and USD) per method.
- DB6. **Attention list** ("يحتاج انتباهك"): computed on read from the existing tables, each item with its count, its oldest time when meaningful and a panel link, hidden at zero, in this order: `orders_review` (→ `/orders/live`); `orders_manual` (→ `/orders/live`); `deposits_overdue` (Sham Cash waiting past the S03 target of 15 minutes inside review hours) and `deposits_flagged` (→ `/deposits`); `usdt_unmatched` (→ `/deposits/transfers`); `supplier_down`, `supplier_degraded`, `supplier_balance_low`, `supplier_sync_failing`, `validation_quota_reached` (per supplier, → `/suppliers/<code>`); `price_reviews` (→ `/pricing/reviews`); `rate_stale` (older than 48 hours, S03; → `/rates`); `switches_active` (each stop or pause on, → `/settings/switches`); `order_conflicts` (conflict notes in the last 7 days, the newest five order numbers, → each order page); `telegram_unlinked` (→ `/settings/telegram`). Each source reuses the owning module's existing query or service; the definitions of "failing", "low" and "reached" are the ones those modules already use for their Telegram alerts.
- DB7. **Suppliers:** each unarchived supplier with its name, health state and since when, paused or not, newest balance and when it was read, the low-balance threshold and whether the balance is below it (no balance for `manual`), and the last sync's status and time.
- DB8. **Exchange rate:** the SYP rate in force, when it was set, and the stale flag (48 hours).
- DB9. The page refetches every 60 seconds, on focus, and (debounced 10 seconds) on admin stream `order` events. One request, one response: the API runs the reads in parallel on indexed queries; no cache.

### Audit
- AU1. New admin actions, in the transaction of the change: `order.rerouted` (closed attempt, new attempt, route, supplier, reason), `order.fulfilled_manually` (attempt, kind of case, units, unit cost, loss accepted, proof file id, reference present, code count, reason; never codes), `order.proof_uploaded` (file id). The extended refund keeps `order.refund_decided`; S08's `order.refunded` and `order.cost_posted` are written as before. Reading the board, the dashboard or the stream is not audited.

## Money flows
- MF-M1. **Manual fulfil cost** (rule MF5), when the unit cost is above zero: S08 M2 unchanged in shape: journal `cost_of_goods`, key `order:<id>:cost:<attempt>`; `cost_of_goods:USD` **+unit cost × units**, `supplier_prepaid:manual` **−the same**. The admin's own spending at another source shows as a negative `supplier_prepaid:manual`, reconciled in S13. A zero cost posts nothing.
- MF-M2. **Reroute:** no money at the reroute. The new attempt's cost is posted by M2 when it delivers; undelivered units are refunded by M3.
- MF-M3. **Refund of a manual order** (rule RF1): S08 M3 unchanged (key `order:<id>:refund` or `order:<id>:refund:<last attempt>`), one refund journal per order.
- The dashboard and the board read only.

## API
Responses `Cache-Control: no-store`.

| Method and path | Access | Request | Response | Error codes |
|---|---|---|---|---|
| `GET /api/admin/stream` | Admin, SSE | — | `text/event-stream`: `order` `{ orderId, status }`, `resync` (LR4) | `RATE_LIMITED` |
| `GET /api/admin/orders/live` | Admin | `liveBoardQuerySchema` (`supplier?`, `gameId?`, `test?`) | `liveBoardSchema` | `VALIDATION_FAILED` |
| `GET /api/admin/orders/:id/routes` | Admin | — | `rerouteOptionsSchema` (remaining units, unit price, minimum margin, routes with eligibility) | `ORDER_NOT_DECIDABLE`, `NOT_FOUND` |
| `POST /api/admin/orders/:id/reroute` | Admin, re-authentication, `Idempotency-Key` | `rerouteOrderSchema` (`routeId`, `reason`) | `adminOrderSchema` | `ORDER_NOT_DECIDABLE`, `ROUTE_NOT_ELIGIBLE`, `REAUTHENTICATION_REQUIRED`, `IDEMPOTENCY_KEY_REUSED`, `VALIDATION_FAILED`, `NOT_FOUND` |
| `POST /api/admin/orders/:id/proof` | Admin, re-authentication, multipart `file` | image | `201` `deliveryProofSchema` (`{ fileId }`) | `ORDER_NOT_DECIDABLE`, the catalog upload's file errors, `REAUTHENTICATION_REQUIRED`, `NOT_FOUND` |
| `GET /api/admin/orders/:id/proofs/:fileId` | Admin | — | the image (`no-store`) | `NOT_FOUND` |
| `POST /api/admin/orders/:id/fulfil` | Admin, re-authentication, `Idempotency-Key` | `fulfilOrderSchema` (`quantity`, `codes?`, `unitCostUsdUnits`, `acceptLoss?`, `proofFileId`, `reference?`, `reason`) | `adminOrderSchema` | `ORDER_NOT_DECIDABLE`, `PROOF_INVALID`, `LOSS_NOT_CONFIRMED`, `CODES_COUNT_MISMATCH`, `REAUTHENTICATION_REQUIRED`, `IDEMPOTENCY_KEY_REUSED`, `VALIDATION_FAILED`, `NOT_FOUND` |
| `POST /api/admin/orders/:id/refund` (S08) | unchanged | unchanged | unchanged | also allowed by RF1 |
| `POST /api/admin/orders/:id/attempts/:attemptId/resolve` (S08) | unchanged | unchanged | unchanged | `ATTEMPT_NOT_RESOLVABLE` for `delivered` on a manual attempt (MF1) |
| `GET /api/admin/orders/:id` (S08) | unchanged | — | attempts add `kind`, `chosenByAdmin`, `proofFileId`, `deliveryReference` | — |
| `GET /api/admin/dashboard` | Admin | — | `dashboardSchema` (DB2–DB8) | — |

Statuses: `409` for `ORDER_NOT_DECIDABLE`, `ROUTE_NOT_ELIGIBLE`, `LOSS_NOT_CONFIRMED`; `400` for `PROOF_INVALID`, `CODES_COUNT_MISMATCH`. The OpenAPI document and the admin client are regenerated.

## Jobs and integrations
- No new queue. Reroute queues S08's `orders.poll` for the new automatic attempt; a manual target writes the `manual_order` Telegram card (dedupe `manual:<attempt>`) in the transaction.
- The worker's sweep, fulfil and poll paths read `route_id` only for `routed` attempts; `admin_fulfil` attempts are already closed and never selected (the open-attempt index covers open statuses only). A test proves the sweep ignores them.
- nginx: the admin host's `/api/admin/stream` location gets buffering off and a long read timeout, like the store's `/api/notifications/stream` (S05); confirm how the admin host proxies `/api` in `deploy/` during implementation.
- No Telegram, email or customer notification is new: deliveries and refunds notify as in S08.

## Screens
Admin only (Arabic, RTL, light and dark; desktop first, usable at tablet width).

- **`/` لوحة التحكم** (replaces the empty home page):
  - Top: "يحتاج انتباهك" list (icon, sentence with the count and oldest time, link); empty: a check mark with "لا شيء يحتاج انتباهك الآن".
  - KPI row: "المبيعات"، "الربح" (with the margin %), "الطلبات المسلّمة"، "المستردات" (count and amount); each with yesterday's value to the same hour and a colored delta ("—" when yesterday is 0). A 7-day sales line under "المبيعات".
  - "الطلبات الآن": the four live counts as chips linking to `/orders/live`, the `awaiting_balance` count, and "قيمة طلبات قيد التنفيذ"; "متوسط وقت التسليم اليوم".
  - "الإيداعات": Sham Cash waiting (count, oldest wait, flagged), USDT waiting, unmatched transfers, credited today per method.
  - "الموردون": table (supplier, health chip, paused chip, balance with read time and a low-balance warning, last sync).
  - "سعر الصرف": the rate, set at, stale warning, link to `/rates`.
  - Loading skeletons per card; an error card with retry; data older than 2 minutes (failed refetches) shows "آخر تحديث …".
- **`/orders/live` الغرفة الحيّة** (navigation under "الطلبات", before the list; the existing badge stays):
  - Header: title, "مباشر" / "إعادة الاتصال…" indicator, "صوت" toggle, filters (supplier, game, test: الكل / إخفاء التجريبي / التجريبي فقط) kept in the URL, the `awaiting_balance` count with a link to the list.
  - Four columns: "عند المورد"، "يدوي بانتظارك"، "بحاجة لمراجعة"، "انتهت خلال آخر ساعة", each with its count; "+N أخرى" linking to the matching `/orders` tab when over 100. Below tablet width the columns become tabs.
  - Card: number, game and product, quantity and total, supplier, elapsed time ticking every second (mm:ss, then hours), amber "متأخر" past LR3, red in review, "تجريبي" chip; finished cards show the final status and delivery time.
  - Side sheet (LR7) with the actions:
    - "اسأل المورد مجدداً"، "تأكّدت: تمّ التسليم"، "تأكّدت: فشل" (S08, held automatic attempts).
    - "تحويل لمورد آخر": the route table from RR2 (eligible routes selectable, others greyed with the reason in Arabic), the RR4 warning on review orders, a reason, re-authentication.
    - "تنفيذ يدوي": units, code fields for code products, unit cost (prefilled when a manual offer exists) with the profit or loss shown live, the loss confirmation checkbox when needed, proof upload (drop or pick, preview, replace), reference, reason, the MF6 warning on review orders, re-authentication.
    - "استرداد" (review orders and manual orders), with S08's warning on review orders.
  - Empty columns: "لا طلبات هنا"; the whole board empty: "لا طلبات مفتوحة الآن". Loading skeleton columns; error with retry.
- **`/orders/$id`** (S08): the decision panel gains "تحويل لمورد آخر" and "تنفيذ يدوي" (the same dialogs) and the extended "استرداد"; manual attempts lose "تأكّدت: تمّ التسليم"; attempts show "اختاره الأدمن", "تنفيذ يدوي" for `admin_fulfil`, the reference and a proof thumbnail that opens full size.
- Every error shows its code's translation; dialogs keep their values (and the uploaded proof) on error.

## Audit and notifications
- Audit: AU1.
- Customers: `order_delivered`, `order_partially_refunded`, `order_refunded` as S08, triggered by the outcomes these actions apply. Telegram: the `manual_order` card for a reroute to the manual supplier; `order_conflict` for a late result after a reroute, a manual fulfil or a refund.

## Abuse and fraud
| Threat | Control |
|---|---|
| A stolen admin session fulfilling orders to cover theft, or rerouting to a costly supplier | Re-authentication on every action, a reason, the proof image, audit entries; reroute only to profitable eligible routes; refunds only to the customer's wallet |
| Paying two suppliers for one order after a reroute or a manual fulfil from review | Allowed only after the 30-minute hard limit (`needs_review`) or for manual attempts; an explicit warning; late results become conflicts with an alert and no money movement; the dashboard lists recent conflicts |
| Double submit of an action | `Idempotency-Key` per action, stored on the attempt or order as S08's decision keys; the order and attempt locks |
| A proof reused for several orders, or another order's proof | `proof_file_id` unique on attempts; the file must be a `delivery_proof`; uploads are re-authenticated and audited |
| A malicious image | Re-encoded with sharp, metadata stripped, input size and pixel limits (S03 FL rules), served with `no-store` and the stored content type only, never inline as HTML |
| Recording a fake zero cost to inflate profit | The cost is required and audited with the proof; S13 reconciles `supplier_prepaid:manual` |
| Selling below cost through reroute | Only routes passing the order's minimum margin are eligible, rechecked under the lock; a loss is possible only through manual fulfil, with a ticked confirmation and an audit flag |
| Stream exhaustion | 3 admin streams, 30 connects a minute, heartbeat, session re-check; nginx connection limits |
| Leaking customer data through the board or dashboard | Admin routes only; cards carry no field values or codes; nothing is cached |

## Edge cases
1. A supplier result arrives while the admin reroutes: both lock the order then the attempt; whichever commits first wins; the reroute then finds the order not decidable (`ORDER_NOT_DECIDABLE`), or the late result becomes a conflict.
2. The chosen route becomes unusable, unprofitable or tried between the options list and the submit (sync, health, pause, cost change): `ROUTE_NOT_ELIGIBLE` with the reason; the sheet refetches the options.
3. Reroute of a test customer's order: only `fake` and `manual` routes are eligible.
4. No eligible route: the reroute action shows "لا مسار مؤهل" and offers manual fulfil or refund.
5. Manual fulfil of 2 of 3 units from review: 2 delivered with cost, the order `failed`, the third routed by S08 R1–R6 (the closed attempt's route counts as tried) or refunded.
6. Manual fulfil with a cost above the price without `acceptLoss`: `LOSS_NOT_CONFIRMED`; with it, posted and flagged in the audit.
7. Manual fulfil with cost 0: no cost journal; the dashboard's profit counts it as fully profitable.
8. The proof upload succeeds but the fulfil fails (stale order): the file stays unused; a new fulfil can use it if the order becomes decidable again.
9. The admin opens two tabs and fulfils twice with different keys: the second finds the attempt closed or the order not decidable.
10. A manual attempt resolved through the Telegram card link: the panel page opens with the fulfil dialog (no delivery from Telegram itself, S08 MN1).
11. Refund of a manual order whose route was the last: refunded, no routing.
12. The stream is down: the board polls every 60 seconds and on focus; the header shows "إعادة الاتصال…".
13. Midnight in Damascus while the dashboard is open: the next refetch shows the new day with yesterday's full values as the comparison base to the same hour.
14. No sales yesterday: deltas show "—".
15. Over 100 orders in a column (a supplier outage): the column shows 100 and "+N أخرى"; the count is exact.
16. A product without delivery stats: slow after 10 minutes; a very fast product: slow after 2 minutes at the earliest.
17. An `admin_fulfil` attempt never appears as the open attempt, in the sweep, in polling or in route options.
18. A product, route or supplier archived after payment: options show it as not eligible; the order keeps its history.
19. Purchases stopped (S05): reroute and manual fulfil still work (orders already paid continue, ADR 0004).

## Open questions
None. All answered on 2026-10-10 (ADR 0025).

## Acceptance
The owner's browser check (local, `pnpm dev`, `SUPPLIER_FAKE_ENABLED=true`, `TELEGRAM_TRANSPORT=log`, the S08 data: "60 UC" on `fake-uc-60` with a manual route, an iTunes code product on a fake code offer; a test customer with test funds and a real customer funded by a manual-deposit adjustment):
1. Open `/`: the dashboard shows zero sales, the suppliers table, the rate, and "لا شيء يحتاج انتباهك الآن" (or the items that are really open, each with its link).
2. Open `/orders/live` in a second window. Buy "60 UC" for the real customer (`order:place`): the card appears in "عند المورد" and moves to "انتهت خلال آخر ساعة" without a reload. The dashboard's sales and profit rise after its refetch.
3. `supplier:fake --order fake-uc-60 slow:300`, buy: the card turns amber after the threshold (10 minutes without stats, or set the policy and stats accordingly); `--resolve` finishes it.
4. `--order fake-uc-60 failed`, buy: the order lands in "يدوي بانتظارك" with the sound (toggle on) and `(1)` in the tab title. "تنفيذ يدوي": cost $0.80, upload a screenshot, reason, re-authentication: delivered; the order page shows the proof and "تنفيذ يدوي"; the customer is notified; the wallet unchanged; the ledger has the cost journal on `supplier_prepaid:manual`.
5. Repeat with a cost above the price: refused until the loss box is ticked.
6. `--order fake-uc-60 unknown`, hard limit 5 minutes: the card goes to "بحاجة لمراجعة" (red). "تحويل لمورد آخر": the fake route shows "جُرّب", the manual route eligible; choose it, with the warning: the order goes to "يدوي بانتظارك" with a `manual_order` card. Then "استرداد": refunded; the wallet is back.
7. Another held order: `--resolve <number> delivered --via webhook` after a reroute: an `order_conflict` alert, nothing changes; the dashboard lists the conflict.
8. A code product, partial: manual fulfil of the missing code with the code field; the customer reveals it.
9. Pause the fake supplier, approve nothing: the dashboard's attention list shows the stop, the waiting deposits and the paused supplier with links.

Tests:
- Contracts (100%): `liveColumn` for every status and attempt kind, `slowAfterSeconds` at the floor, the default and above, `damascusDayBounds` around midnight and DST-free offsets, `deltaPercent`, the schemas' limits (reason, reference, codes, cost).
- Database (real PostgreSQL): the new checks (kind requires route fields or forbids them, zero cost without journal, proof unique), triggers unchanged, `rerouteOrder` and `fulfilOrderManually` lost races and their transitions, one refund per order with RF1.
- Concurrency and idempotency: reroute against a late poll result and a webhook; fulfil against a late result; two fulfils with different keys; the same key replayed; reroute against a cost change making the route unprofitable.
- API, every route: success, 401, a customer session (403), re-authentication, every error code, `no-store`; options per skip reason; the resolve refusal for manual `delivered`; the board's columns, filters and caps; the dashboard's numbers on a fixed data set (test customers excluded from money, included in attention), yesterday to the same hour, the 7 points; the stream forwarding order events to the admin only, the 4th stream closing the oldest, the session re-check.
- Worker: the sweep, fulfil and poll ignore `admin_fulfil` attempts; a rerouted `sending` attempt is sent by its poll with its key.
- E2E with RTL screenshots (light and dark): the dashboard (with data, empty attention), the live room (four columns with amber and red cards, the side sheet), the reroute dialog, the manual fulfil dialog with a proof preview and the loss confirmation, the order page with an `admin_fulfil` attempt; a mocked stream event moving a card.

## Implementation notes
- Suggested split (owner prefers fewer PRs), each leaving `main` green:
  1. Contracts, db (migration for `fulfilment_attempts` and the file kind, `rerouteOrder`, `fulfilOrderManually`, the refund extension), API (admin stream, live board, route options, reroute, proof, fulfil, dashboard), the worker's guards and tests, OpenAPI and the admin client.
  2. Admin: the dashboard home page, `/orders/live` with the side sheet, the dialogs on `/orders/$id`; E2E and screenshots.
- Module layering: a `dashboard` read module in the API (or `admin/dashboard`) reads `orders`, `deposits`, `suppliers`, `pricing`, `rates`, `settings` and `telegram` through their services; it writes nothing.
- Update `docs/architecture.md` (the admin stream, the dashboard module), `deploy/` nginx for the admin stream, `apps/admin/CLAUDE.md` if the side-sheet pattern becomes the one to copy, and S08's D2 note pointing to MF1.
