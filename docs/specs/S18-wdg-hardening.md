# S18 — WDGZone hardening and supplier panel overhaul

Status: Approved · Date: 2026-10-19 · Scope: `docs/product/v1-scope.md` A06–A08 (supplier sync, balances, health), F09 · ADRs: 0004, 0005, 0020, 0021 (amended by [0033](../decisions/0033-supplier-health-hysteresis-and-charge-checks.md)), 0027, 0030

## Summary
An audit of the WDGZone integration before launch (2026-10-19, production data and read-only live calls) found that the health state flaps between `healthy` and `degraded` every few minutes, the statement shows no amounts and wrong times, a single slow catalog page fails the whole sync, and real outages cannot be told from network trouble. S18 fixes these, checks what WDG really charges against what we expected, refreshes a pack's cost before buying it, and reworks the supplier screens so the catalog is easier to read and to link to the store.

## In scope / out of scope
- In: everything under "States and rules" (HE, FK, AL, SY, ST, TZ, DC, CH, PQ, DD, CS, TC, PS, RC, RT) and "Screens".
- Out: WDG `smm` products (V1 sells game top-ups); anything WDG does not offer (player check, cancel, sandbox, IP allowlist); `supplier_calls` retention (follow-up, rule RT1).

## Owner's decisions (2026-10-19)
1. Health recovery: `degraded` below 90% as before; back to `healthy` only at **≥ 95%** success **held for 5 consecutive minutes**; the minimum sample rises from 5 to **10** calls.
2. VIP discount: the cost cell shows the original price struck through and a "خصم VIP n%" badge from `discount_percent`, plus an offers filter "عليها خصم". The cost stays the discounted price.
3. Charged price differs from the expected cost by more than **2%**: noted on the attempt and a Telegram alert; when the charged unit cost is above the order's unit price (a loss), the offer takes the charged cost, which pauses the product through the margin guard until reviewed. The customer's order is unaffected.
4. Pre-purchase price check: read `GET /products/{id}` before the first send of an attempt; a cost above the order's unit price is not sent (the next route is tried) and the offer is repriced; a failed read sends as before.

## Access
| Action | Route kind | Who |
|---|---|---|
| Test a supplier's connection | Admin, `POST /api/admin/suppliers/:code/test` | The admin |
| Read a supplier category, its errors | Admin, `GET` | The admin |
| Link an offer to an existing pack | Admin, the existing `POST /api/admin/catalog/products/:id/routes` (S07 RT1–RT8) | The admin |
| Everything else | as S07, S16 | The admin |

## Data
- `supplier_calls`: `failure_kind` (text, nullable, one of `FAILURE_KINDS`), `http_status` (integer, nullable, 100–599). Only `error` rows carry a failure kind; `supplier_code` is also filled for order calls (rule HE6).
- `supplier_policy`: `recover_success_bp` (integer, 1–10000, ≥ `degraded_success_bp`, default 9500), `recover_minutes` (integer, 1–60, default 5). A migration appends a policy row copying the newest one with `health_min_calls = greatest(10, current)` and the new defaults.
- `supplier_offers`: `discount_bp` (integer, 0–10000, nullable): WDG's `discount_percent` × 100.
- `supplier_sync_runs`: `platform_status` (text, 1–64, nullable) and `catalog_updated_at` (timestamptz, nullable): the supplier's status and catalog version read before the offers; `offers_read` (boolean, default true): false when the run skipped the read (rule SY4).
- `fulfilment_attempts`: `charged_usd_units` (bigint, nullable): what the supplier says it charged for the attempt (rule CH1). `cost_checked_usd_units` (bigint, nullable): the unit cost the pre-purchase check read (rule PQ1). Each is set once, while the attempt is open (`fulfilment_attempts_guard`, migration 0067).
- `supplier_cost_changes`: `attempt_id` (uuid, nullable, references `fulfilment_attempts`): the attempt whose quote or charge moved the cost (rule PQ3); such a row has no `sync_run_id` and no `admin_id`.
- Contracts: `FAILURE_KINDS`, `SupplierCallOperation` gains `get_offer` (counted) and `test_connection` (panel read); `SupplierPolicy` gains the two fields; reconciliation `EXTERNAL_CHECKS` gains `supplier_charges`.

## States and rules

### Health (amends S07 H1–H4)
- HE1. Window, success and p90 as before. `healthy`/`degraded` → `degraded` below `degraded_success_bp` or above `degraded_p90_ms`, with at least `health_min_calls` calls. The p90 decides only with at least 20 timed calls (catalog reads aside, `P90_MIN_SAMPLES`); with fewer it is shown but ignored, here and in HE2 (owner, 2026-10-19: one 11.8 s balance read among six made WDG `degraded` for half an hour while the store was idle).
- HE2. **Recovery (hysteresis):** `degraded` → `healthy` only when, at each of the last `recover_minutes` whole minutes (now, now − 1 min, …), the window ending then has at least `health_min_calls` calls, success ≥ `recover_success_bp` and p90 ≤ `degraded_p90_ms`. Otherwise it stays `degraded`. The probe rule H3 is unchanged (a probe leads to `degraded`, then HE2).
- HE3. **Consecutive errors:** `down` after the last `down_consecutive_errors` calls are all `error` **and span at least two operations**. One attempt's polls alone never make a supplier `down`; a real outage fails the balance read, the sync or a purchase too.
- HE4. **Answered is not an error:** an order call whose outcome is `unknown` but whose reply the supplier gave and the adapter read (a 202 still processing, a delivery not yet completed, `ORDER_NOT_FOUND`, a quantity it does not report) counts as `ok`. Timeouts, connection failures, 5xx, 429 and unreadable replies stay `error`.
- HE5. **Sync weight:** the catalog read is one call; a page that fails and then answers on retry (rule SY1) is not a failure. Only a read that fails after its retries counts as one `error`.
- HE6. **Codes on order calls:** a recorded order call keeps the outcome's supplier code (`OUT_OF_STOCK`, `ORDER_NOT_FOUND`, `REFUNDED`) and, for an `error`, its failure kind and HTTP status.

### Failure kinds
- FK1. Every `error` call records one kind: `timeout` (no answer in time), `dns` (the name did not resolve), `connect` (refused, reset, unreachable, connect timeout), `tls` (certificate or handshake), `rate_limited` (429), `http_5xx`, `http_4xx` (an unmapped refusal), `unreadable` (an unexpected reply), `redirect`, `other`. Its HTTP status is kept when there was one.
- FK2. The worker logs each errored call at `warn`: supplier, operation, kind, status, code, latency. Never a message body, a URL query or a credential.
- FK3. The health tab lists the newest errored calls (time, operation, kind, status, code, latency), 50 a page, so the admin tells a WDG outage (`http_5xx`, `rate_limited`) from a network path problem (`dns`, `connect`, `timeout` on every call).

### Health alerts
- AL1. A health change is still recorded at once (row, repricing, store refresh, rule H4). The Telegram message is sent only when the new state has held: `down` at once; `degraded` and `healthy` after 5 minutes without another change.
- AL2. The message names the last state the admin was told, not the last recorded one, so a flap shorter than 5 minutes sends nothing and the admin's last message always matches the state.
- AL3. The health job sends at most one health message per supplier per run; its dedupe key is the change row's id.

### Sync
- SY1. **Page retries:** a catalog page that times out, cannot connect, answers 5xx or 429 is read again up to 2 more times: after 2 s and 5 s, or, for 429, when the rate-limit window resets (at most 61 s). Retries keep the 20-request reserve for orders. A page refused definitively (401, 403) fails the read at once.
- SY2. Each retried page is logged (rule FK2) with its kind.
- SY3. A run that fails still keeps the previous costs (S07).
- SY4. **Unchanged catalog:** before reading offers, the sync reads the platform status (a call health counts, so an idle supplier keeps enough calls in its window). When `catalog_updated_at` equals the one of the newest successful run that read offers, and that run started less than 60 minutes ago, the run succeeds without reading offers or categories (`offers_read = false`, no cost confirmed). Costs therefore never go unconfirmed for more than about 75 minutes (stale at 120). A missing or unreadable status reads as usual.

### Statement (S16 SF3, from the live replies of 2026-10-19)
- ST1. `GET /orders` rows: `id`, `product_id`, `product_name`, `quantity`, `total_price` (decimal string, USD), `status`, `created_at`, `completed_at`. The adapter reads `total_price` (else `total`), and `completed_at`.
- ST2. `GET /transactions` rows: `id`, `type`, `amount` (signed number), `reference_type` (`order` | `deposit` | …), `reference_id`, `description`, `created_at`; no `balance_after`, no `pagination`. A row with `reference_type = order` names its WDG order (`supplierOrderId`), so it matches our attempt.
- ST3. The panel shows each order's amount, its delivery time (`completed_at − created_at`), its status and a transaction's type in Arabic (unknown values as received), and waits for the 5-second read limit instead of showing an error.

### Times
- TZ1. WDG times without an offset (`2026-10-19 00:53:16`) are in UTC+4 (seen 2026-10-19: `/health` gives `catalog_updated_at` 4 hours ahead of its own `time` in UTC; order 3940 at `00:53:16` is our attempt at `20:53:16Z`). The adapter reads them as `+04:00`; a time with `Z` or an offset is read as given.

### Discount
- DC1. The adapter reads `discount_percent` (0–100, up to 2 decimals) as `discountBp`; the sync stores it on the offer. Nothing is priced from it: the cost is `price`.

### Charged price
- CH1. The purchase reply's `total` and the webhook's `total` (in USD) are kept on the attempt as `charged_usd_units`; the poll's `GET /orders/{id}` `total_price` too when the attempt has none.
- CH2. When a charge is known and differs from `unit cost × units` by more than 2%, the order gets a `note` event (`charge_mismatch`, expected and charged) and a `supplier_charge_mismatch` Telegram message (dedupe per attempt).
- CH3. With such a mismatch the offer's cost becomes the charged unit cost (rule PQ3) and its products are repriced (cause `cost_sync`). When that cost is above the order's unit price (`loss` in the message), the margin guard pauses what can no longer be sold at a profit, or a review opens. The delivered order is not touched.

### Pre-purchase price check
- PQ1. Before the first send of an attempt (never a re-send), an adapter with the `offerQuote` capability reads the offer (`GET /products/{id}`: price, availability, stock), recorded as `get_offer`, timeout 5 s. Its unit cost is kept on the attempt.
- PQ2. A quote above the order's unit price, or an offer not available, fails the attempt before anything is sent (`COST_ABOVE_PRICE` or `OUT_OF_STOCK`, ours, nothing bought), so the router tries the next route (S08). A quote that fails, times out or does not parse sends the order as before.
- PQ3. A quoted or charged cost that differs from the offer's stored cost updates it in the transaction that records the attempt: a `supplier_cost_changes` row naming the attempt, `cost_confirmed_at` now, and a repricing of its products (cause `cost_sync`).
- PQ4 (Q25, owner 2026-10-28). Each sync stores the cost it read in `supplier_offers.listed_cost_usd_units`. A cost written by PQ3 that is higher than that listed cost stays the offer's cost while the listing still shows the same figure; a sync replaces it only once the listed cost itself changes. A PQ3 cost below the listing never outlasts the next sync: the listing wins (never sell below cost). A cost observed after a sync began reading always stays (audit A05-8).

### Delivery details
- DD1. `GET /orders/{id}` after a poll's 202 also reads `error_message`: a failed, refunded or cancelled order's reason becomes it (at most 200 characters), so the admin sees why WDG failed it. Not logged.
- DD2. The statement shows WDG's delivery time per order (ST3).

### Connection
- CS1. `POST /api/admin/suppliers/:code/test` reads the balance once, recorded as `test_connection` (a panel read, outside health), and answers `{ ok, latencyMs, balance?, failureKind?, httpStatus?, supplierCode? }`. Once per 10 seconds per supplier (`RATE_LIMITED`).
- CS2. The connection tab's test button calls it and shows the answer; saving keys shows the run they started (S07 SP2 already queues it).
- PS1. The supplier cards show the cached platform status from the list reply; only the supplier page reads it live.

### Daily charge reconciliation
- RC1. The nightly reconciliation (S13) adds `supplier_charges` per supplier with the statement capability: WDG's orders created in the business day (pages of `GET /orders`, newest first, until before the day, at most 20 pages) against our attempts with that `supplier_order_id`.
- RC2. Actual = Σ the totals of WDG's `completed` orders of the day; books = Σ `unit cost × units delivered` of the attempts they name; the range is `[books, books]` within the reconciliation tolerance (S13 E1). Detail lines: an attempt charged more than 2% off its cost (`charge_differs`, the difference), a WDG `completed` order on an attempt that is `failed` (`delivered_but_failed`, the charge), a WDG `refunded`, `failed` or `cancelled` order on an attempt that delivered (`failed_but_delivered`, the cost); and the `completed` WDG orders no attempt names, by WDG's id (`unmatchedSupplierOrders`: money spent we do not count). Result `mismatch` when off the range or when any line or unmatched order exists, else `ok`; `skipped` (`reader_failed`) when the statement cannot be read. Read again after 10 minutes and alerted as other external mismatches (S13 RN4, NT1).

### Retention
- RT1. `supplier_calls` keeps growing (about 500 rows a day per supplier now). Retention is a follow-up (append-only table: a purge needs the owner role and an ADR).

## Money flows
None: S18 moves no money. Charges and quotes change offer costs (and so prices) through the existing repricing.

## API
| Method and path | Access | Request | Response | Error codes |
|---|---|---|---|---|
| `POST /api/admin/suppliers/:code/test` | Admin | — | `supplierConnectionTestSchema` | `SUPPLIER_NOT_CONFIGURED`, `RATE_LIMITED` |
| `GET /api/admin/suppliers/:code/calls?result=error&page=` | Admin | `supplierCallListQuerySchema` | paged `supplierCallSchema` | — |
| `GET /api/admin/suppliers/:code/categories/:categoryId` | Admin | — | `supplierCategoryNodeSchema` (with its path) | `NOT_FOUND` |
| `GET /api/admin/suppliers/offers/:id/link-candidates?q=` | Admin | `linkCandidateQuerySchema` | up to 20 `linkCandidateSchema`: the category game's packs (its amount first, `amount`, else `game`), then the search's (`search`), each with `routedBySupplier` | `NOT_FOUND` |
| The link itself | Admin | the existing `POST /api/admin/catalog/products/:id/routes` | the routing | as S07 RT1–RT8 |
| `GET /api/admin/suppliers/:code/offers` | Admin | adds `discounted=true` | adds `discountBp`, `lastSeenAt` | — |
| `GET …/statement/orders`, `…/transactions` | Admin | — | adds `completedAt`, `deliverySeconds` | — |
| `GET/PUT /api/admin/suppliers/policy` | Admin | adds `recoverSuccessBp`, `recoverMinutes` | — | — |

## Jobs and integrations
- `suppliers.health` (every minute): HE1–HE3, AL1–AL3.
- `suppliers.sync`: SY1, SY4; WDG `GET /health` before `GET /products`.
- `orders.fulfil`: PQ1–PQ3 before the first send; CH1–CH3 after any delivered answer (purchase, poll, webhook).
- `reconciliation.run`: RC1–RC2.
- WDG calls added: `GET /products/{id}` before purchases (one per order, within the 60/min limit), `GET /orders/{id}` already read after a 202.

## Screens
- **Supplier cards:** platform status from the list (PS1).
- **Connection tab:** "اختبار الاتصال" runs CS1 and shows ok / failure kind / latency / balance; the last run stays below.
- **Catalog tab:** a category's name and "عرض الباقات" open the **category page** `/suppliers/:code/categories/:categoryId`: breadcrumb (supplier › path › name), back to the catalog, header with counts, state, linked game and actions (import, link, ignore), and the offers of that category with the offers tab's filters, selection, import and link (page and filters in the URL).
- **Offers tab:** last seen, a select's options (in a popover), the VIP badge and struck original price (DC1), the filter "عليها خصم", the category chip by name, "select all on this page", tooltips on icon-only buttons, a "ربط بباقة" action per row.
- **Link to an existing pack:** a dialog from an offer row or the category page: up to 5 suggested packs (same amount in the name, same game linked to the category), a product search, the field map, save: 2–3 clicks for a suggested pack.
- **Add-route dialog (product side):** search prefilled with the pack's amount (its `gameAmount`, else the number in its name), paging, unsupported and ignored offers hidden, stock and path shown, and the offer's fields proposed onto the game's (the same key, case and underscores aside, or one field onto one).
- **Cost history dialog:** a small line chart of the cost over time above the table.
- **Statement tab:** amounts, correct times, delivery time, Arabic status and type, transactions matched to orders.
- **Runs tab:** the error message under its code; "لم تُقرأ العروض (الكتالوج لم يتغير)" for SY4 runs.
- **Health tab:** the failed calls table (FK3), 50 a page; the change history and balance reads stay the newest 20.
- **Policy dialog:** the two recovery fields.
- **Narrow screens:** the wide tables (offers, runs, statement, errors) scroll inside their card with the first column kept in view.

## Audit and notifications
- Audit: `supplier.connection_tested` (result and failure kind, never the balance). A link is a route creation and is audited as one (S07). Policy changes as before.
- Telegram: `supplier_health` (AL1–AL3), `supplier_charge_mismatch` (CH2), reconciliation mismatches (RC2, through S13).

## Abuse and fraud
- A supplier that overcharges: CH2–CH3 and RC2 catch it the same day; the margin guard stops selling at a loss.
- A quote that lies low: the charge check still compares after the purchase (CH2).
- Test-connection spam: 1 per 10 s per supplier (CS1).

## Edge cases
1. A quote read while WDG is slow: 5 s timeout, then the order is sent (PQ2); the attempt keeps no quoted cost.
2. A charge with another currency: ignored (no `charged_usd_units`).
3. A webhook arrives before the purchase reply: the charge is taken from whichever first carries a total (CH1).
4. The policy's recovery threshold below the degrade one: refused by the contract and a check.
5. A run skipped by SY4 when the previous run read offers 59 minutes ago: the next run reads in full.
6. The statement lists an order of another key (a manual order on WDG's site): it shows as unmatched and, in the nightly check, as `unmatched_supplier_order`.

## Acceptance
- Owner, with the fake supplier: script `--errors on` for one call, watch the health stay `healthy`; script several errors, see `degraded` and one Telegram message after 5 minutes; stop the errors and see it return after 5 minutes at ≥ 95%.
- Open a WDG category from the catalog, link one offer to an existing pack from its suggestions, open the statement and see amounts and times.
- Tests: health rules (unit, table-driven over the 2026-10-19 sequence), failure kinds (http client), adapter shapes from sanitized recordings, page retries, quote and charge paths (worker integration), reconciliation check, API access per endpoint, E2E and RTL screenshots of the changed screens.
