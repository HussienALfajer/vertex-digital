# S25 — jneedcontur through a zddk adapter, and Syrian credit, bills and cash

Status: Approved · Date: 2026-11-04 · Scope: `docs/product/v1-scope.md` §F09 (a third automatic supplier) and §F44 (new: Syrian credit, bills and cash, owner 2026-11-04) · ADRs: 0003, 0004, 0005, 0020, 0021, 0026, 0032, 0034, 0035, 0039 (new)

## Summary
WDGZone and FazerCards sell no Syrian mobile credit, so the store cannot sell what an Azaz customer tops up most often. jneedcontur, a store on the zddk platform, sells Syriatel and MTN credit, both operators' bills and Syriatel Cash through a reseller API, and also Jawaker, about 170 chat apps and the games WDGZone sells (at 2–13% more). S25 adds jneedcontur as a third automatic supplier through a generic `zddk` adapter (the same adapter can later serve TweetPin and other zddk stores), and opens a "الرصيد والفواتير" section: fixed credit packs, bills and cash paid by a **free amount** in SYP, priced and shown in SYP first, with the recipient number typed twice, daily limits per customer and per number, and cash-out controls on the cash products. Every jneedcontur route competes on cost like any route. The analysis behind it: `reports/تحليل واجهة jneedcontur كمورد 2026-11-04.md` (local, git-ignored), sections 3–9.

## Owner decisions (interview, 2026-11-04)
| # | Question | Decision |
|---|---|---|
| D1 | The supplier's answers to the analysis' 16 questions | Not received yet: what depends on them is open (Q31–Q42) and gates PR 2 and the live routes |
| D2 | Products in V1 | Syriatel and MTN credit, Syriatel and MTN bills, Syriatel Cash, MTN Cash (listed paused while the supplier marks it unavailable) |
| D3 | Bills and cash amounts | A **free amount** the customer types, not fixed packs |
| D4 | Price display in the section | **SYP first**, USD small beside it |
| D5 | Cash products (they turn wallet balance into cash) | Sold **under strict controls**: paid only from balance credited at least 72 hours ago, a small daily cap, and the admin's approval above a threshold |
| D6 | Limits on credit and bills | Per customer and per recipient number, plus an alert when one number is topped up from several accounts |
| D7 | Merchants | Buy the section at their list price, like every product |
| D8 | Credit sent to a wrong number | **No refund**; the number is typed twice, checked against the operator's prefixes and shown large before paying, with the no-refund line. A supplier refusal is refunded to the wallet as usual |
| D9 | Cash numbers | Retail $20 a day, approval above $10 per order; merchants $100 a day, approval above $50 |
| D10 | Section cap for merchants | $500 a day (retail $50); per number 5 orders a day (merchants 20) |
| D11 | jneedcontur routes outside the section | **All routes compete on cost** and count for the price, games included |
| D12 | Free-amount bounds | From 1,000 SYP in steps of 100 SYP; the maximum is the supplier's (bills 100,000, cash 10,000), set per product within it |

## In scope / out of scope
- In:
  - Supplier `jneedcontur`: enum value, seeded row, `jneedcontur_paused` switch, credential `apiToken`, treasury place, labels, low-balance alert.
  - Adapter `packages/suppliers/src/zddk/`, parameterised by store (base URL in code per supplier code): balance, products, category tree, offer quote, place order, look an order up by our key. No player check, no webhook, no statement, no platform status.
  - A third product kind `amount` (free amount in steps), its pricing, buy box, cart line, order display and sale mode.
  - Field types `syriatel_number` and `mtn_number`; the recipient typed twice.
  - Game service classes `credit` and `cash` with their limits, the per-number limit and alert, the cash 72-hour rule and approval hold.
  - The "الرصيد والفواتير" category and its six games (seed and production catalog), SYP-first display.
  - Jawaker, chat apps and games linked through the S16 catalog browser like any supplier.
  - Docs: `docs/suppliers/jneedcontur.md` (PR 2), the scope change, ADR 0039.
- Out: E-LUX AZAZ (unknown service), the store's "smart transfer" page (display only), jneedcontur's webhook (unsigned: never used), a second credit supplier (TweetPin later through the same adapter, its own small spec), free amounts outside the section, Syriatel/MTN credit by free amount (the supplier sells fixed values only), offers whose fields ask for an email and password (Q20 stands).

## Access
| Action | Route kind | Who |
|---|---|---|
| Enter or rotate the jneedcontur token | Admin, re-authentication (S07 SP2) | The admin |
| Set a game's service class | Admin, re-authentication | The admin |
| Edit the credit policy (limits, cash rules) | Admin, re-authentication | The admin |
| Approve or reject a held cash order | Admin (panel, re-authentication) · Telegram button (S05 rules, up to the policy's Telegram ceiling) | The admin |
| Buy credit, bills or cash | Customer (S08, S10) | Verified customer, not frozen; cash also under CS rules |
| Sell credit in the sale mode | Merchant (S21) | Approved merchant |

## Data
- `supplier_code` gains `jneedcontur`; `store_switch` gains `jneedcontur_paused` (default off). The seeded `suppliers` row (fixed UUID) is written the way S19 did (the enum value is not used in the transaction that adds it; verified on a fresh and a migrated database). `SUPPLIER_CREDENTIAL_FIELDS.jneedcontur = ['apiToken']`. Low-balance default $10. Treasury place `supplier:jneedcontur`, account `supplier_prepaid:jneedcontur` (USD).
- `supplier_offers.offer_id` for jneedcontur (≤128): `<product_id>` for a package, `<product_id>:<qty>` for one value of a fixed value list (`1477:96.15`, the value as the supplier writes it), `<product_id>@100` for an amount product (one unit = 100 supplier units). `kind`: `amount` for `@100` offers, `direct` otherwise (a code product is `code` when its reply carries codes; Q31 settles how to tell before buying).
- `product_kind` gains `amount` (enum extended the safe way). `catalog_products` gains `min_quantity` int not null default 1 (`amount` products only may set it above 1), and for `amount` products `max_quantity` may go up to 1,000 (`MAX_AMOUNT_UNITS`); `direct` and `code` keep `MAX_QUANTITY_LIMIT` (50). Check: `1 ≤ min_quantity ≤ max_quantity`. An `amount` product also carries `amount_unit_ar` text (≤16, "ل.س") and `amount_step` int fixed at 100 in V1 (one unit of quantity is 100 of `amount_unit_ar`). A route's kind must match its product's (`ROUTE_KIND_MISMATCH`).
- `input_field_type` gains `syriatel_number` and `mtn_number` (CT7: fixed types).
- `catalog_games` gains `service_class` enum `none` (default) · `credit` · `cash`. A `credit` or `cash` game has exactly one input field, required, the **recipient**.
- `orders` gains `recipient` text null (≤32: the recipient field's normalised value, for `credit` and `cash` games only) and `cash_hold` enum null: `held` · `approved` · `rejected` · `expired`, with `cash_hold_decided_at`, `cash_hold_admin_id`. Index `(recipient, created_at)` where `recipient is not null`.
- New single-row table `credit_policy` (as `order_policy`; changes audited): `retail_daily_usd_units` ($50), `merchant_daily_usd_units` ($500), `recipient_daily_orders_retail` (5), `recipient_daily_orders_merchant` (20), `recipient_accounts_alert` (2), `recipient_alert_days` (7), `cash_retail_daily_usd_units` ($20), `cash_merchant_daily_usd_units` ($100), `cash_retail_approval_above_usd_units` ($10), `cash_merchant_approval_above_usd_units` ($50), `cash_balance_age_hours` (72), `cash_hold_hours` (24), `cash_telegram_ceiling_usd_units` ($50). All amounts in USD micro-dollars (ADR 0003), bounds checked (each ≥ 0, ages 0–720 h).
- No new money table.

## States and rules

### jneedcontur connection (ZD)
- ZD1. **Base and auth:** `https://api.jneedcontur.net/client/api/`, header `api-token`. The base URL is fixed in code per supplier code (`ZDDK_STORES`), never entered in the panel (no request to an admin-typed host). 15 s per request, 30 s for an order. The account's IP allowlist holds the server's IP only; "allow every IP" stays off.
- ZD2. **Availability:** `ADAPTERS_READY` gains `jneedcontur` only in PR 2. Before that the panel shows "not available" and sync and routing skip it.
- ZD3. **Sync:** one `GET products` per run (S07's schedule) and `GET content/0` then the children for the category tree (once a day and on "sync now", S16 SC1). Categories `category.<id>`, with `parent_id` and the image on `api.jneedcontur.net` (S16 IM1–IM3; `imageHosts` = that host).
- ZD4. **Offers:** `price` → `cost` and `base_price` → `originalCost`, parsed exactly from the JSON number's text into micro-dollars: a figure that is not a whole number of micro-dollars after the offer's multiplier (×qty for a value list, ×100 for `@100`) leaves the offer `unsupportedReason: 'cost_precision'` (new reason), never rounded. `available` → `inStock`. `product_type: package` with `qty_values: null` → one `<id>` offer. A value list → one `<id>:<qty>` offer per value, cost `price × qty`. `amount` with `{min,max}` → one `<id>@100` offer, cost `price × 100`, `minQuantity = ceil(min / 100)`, `maxQuantity = floor(max / 100)` (strings read as numbers). `params`: the quantity labels are not fields; an offer with one other param gets `requiredFields: ['playerId']` and one `fieldSpecs` entry with the Arabic label; two or more → `fields_unsupported` until Q31 is answered.
- ZD5. **Order key:** `order_uuid` = a UUID of version 4 layout derived deterministically from the attempt id (SHA-256 of the id, the version and variant bits set), so a re-send always carries the same key whatever Q3 answers. The derived key is computed, not stored.
- ZD6. **Order:** `GET newOrder/<product_id>/params?qty=<n>&playerId=<value>&order_uuid=<key>`, with `qty` = 1 for a package, the value from the offer id for a value list, `quantity × 100` for `@100`. The full URL is never logged (the recipient is in it); the call log keeps the path without the query. `status: OK` with `accept` → `delivered` (codes from `replay_api` for code products; `chargedUsdUnits` from `price`), `wait` → `pending` (`order_id` kept), `reject` → `failed_definitive`. Every reply that does not match the documented success shape is `unknown` until Q32 gives the error shape; then the codes map as the analysis' table: 120–123, 108 → `failed_definitive` and a health alert; 130, 100 → `failed_definitive` (next route); 105, 110 → `OUT_OF_STOCK_CODE`; 106, 112, 113 → `failed_definitive`; 107 → `inputRejected`; 109 → `failed_definitive`; 111 → `unknown` with `failure: 'rate_limited'` and `retryAt` one minute on; 114, 500 → `unknown`.
- ZD7. **Poll:** `GET check?orders=[<key>,…]&uuid=1`, up to 20 keys per call (S08 F7's schedule). Statuses map as ZD6. A key the supplier does not know is `unknown` with `answered: true` (never a failure); once Q34 confirms that an unknown key means no order was created, S16 RS1's re-send with the same key is how a `111` or a lost first send is retried. `price` (a decimal string) is the charged cost for S18's charge check; `replay_api` is read as either documented shape.
- ZD8. **Delivery proof:** text in `replay_api` for a `direct` or `amount` order is kept on the attempt as `supplier_note` (≤500) and shown on the order page and the admin's order as "رقم العملية" when the first live order shows it is an operator reference (Acceptance); until then it is shown to the admin only.
- ZD9. **Balance:** `GET profile` → `balance` (decimal string, USD until Q35 says otherwise). A balance below the threshold alerts (A07). No statement: S18 RC1's nightly charge check uses the poll's `price`, and S13's supplier reconciliation uses the balance read before and after.
- ZD10. **Health:** the existing rolling window; a `111` counts as rate limited, not as a fault. `108` or `122`/`123` raise a Telegram alert naming the account setting (2FA, API access, IP).

### Routing (RT)
- RT13. jneedcontur routes compete on cost and count for the price by default (D11; ADR 0032's flag is the admin's per route as today). When WDGZone and FazerCards are unusable, a game's basis may move to jneedcontur's higher cost; S19 RT10 holds a move above the review threshold for the owner's review.
- RT14. The supplier precedence of RT11 becomes `wdgzone`, `fazercards`, `jneedcontur`, `fake`, `manual`.

### Amount products (AM)
- AM1. An `amount` product sells `quantity` units of `amount_step` (100) of its unit; the customer types the amount, the quantity is `amount / 100`. The amount must be a multiple of 100 and within `min_quantity × 100` and `max_quantity × 100` (D12: the catalog sets `min_quantity` 10 = 1,000 SYP; `max_quantity` within the route offer's `maxQuantity`). Otherwise `VALIDATION_FAILED` with the bounds.
- AM2. **Price:** the product's price row is the price of **one unit** (100 SYP), priced by the existing engine on every list (S07 P1–P8, S20 LP1–LP4): cost of one unit plus the rule, rounded up to whole cents. The order total is `unit price × quantity` (S08 `orderTotal`, unchanged). The rounding is at most one cent per 100 SYP, always upward, and the admin sees it beside the cost.
- AM3. **Routes:** an `amount` product routes only to `amount` offers. A route is usable only when the order's quantity is within the offer's `minQuantity`/`maxQuantity` (`quantity_unsupported`, as S19's gift cards). The adapter sends `qty = quantity × 100`. An amount order is one supplier order, delivered whole or failed whole.
- AM4. **Margin guard:** unchanged per unit (`unit price − unit cost ≥ minimum margin`); the minimum margin stays per unit.
- AM5. **Where it works:** the buy box, the cart and checkout (S10), reservations (S09), saved recipients (S10, the field only, never the amount), gifts (S10), quick buy "top up again" (S22, same amount), the sale mode and the price list (S21: the unit price "لكل 100 ل.س"). The calculator (S09 CL) and best value (S22) skip `amount` products.
- AM6. **Display:** the pack line reads "مبلغ حر · من 1,000 إلى 100,000 ل.س"; the order shows "<amount> <unit>" (for example "7,300 ل.س"), never a quantity.

### Recipient numbers (RN)
- RN1. `syriatel_number` accepts `09XXXXXXXX`, `9XXXXXXXX`, `+9639XXXXXXXX`, `009639XXXXXXXX` and `9639XXXXXXXX` (spaces and dashes ignored, Arabic-Indic digits read as Latin) and normalises to `09XXXXXXXX`; the prefix must be `093`, `098` or `099`. `mtn_number` the same with `094`, `095` or `096`. A number of the other operator is refused with "هذا رقم <المشغّل الآخر>، اختر باقات <المشغّل الآخر>".
- RN2. The buy box (and the sale mode) asks for the recipient twice ("أعد كتابة الرقم"); "متابعة" stays off until both normalise to the same number. Pasting into the second input is blocked. Before slide-to-pay the number is shown large, `dir="ltr"`, grouped `09X XXX XXXX`, with the operator's name and "تأكد من الرقم: الرصيد المرسل إلى رقم خاطئ لا يُسترد" (D8).
- RN3. The order stores the normalised value in `recipient` and in its fields; the supplier receives it as `playerId` (Q31 may change the key name, never the value).
- RN4. Bills' and cash's "ID" field type waits for Q39 (phone number, subscription or wallet number): until then the bill and cash games use `digits` 6–16 and their routes stay off.

### Section limits (CL)
- CL1. A game's `service_class` puts it in the section: `credit` (credit and bills) or `cash`. Every limit counts orders of `credit` and `cash` games together unless named.
- CL2. **Customer cap:** the totals of the customer's section orders created in the last 24 rolling hours (any status but `cancelled` and `refunded`; a partly refunded order counts its kept part) plus the new order stay within `retail_daily_usd_units` or, for a merchant, `merchant_daily_usd_units`. Otherwise `CREDIT_DAILY_LIMIT` with the remaining amount. S12's per-customer daily purchase cap applies on top, unchanged.
- CL3. **Recipient cap:** orders to one `recipient` created in the last 24 hours by **all accounts** stay below `recipient_daily_orders_retail` (or `_merchant` when the buyer is a merchant). Otherwise `RECIPIENT_DAILY_LIMIT`.
- CL4. **Alert:** when a recipient gets an order from a third distinct account (`recipient_accounts_alert` + 1) within `recipient_alert_days`, a Telegram alert names the number masked (`09X XXX XX12`), the accounts and their totals, once per number per day. Nothing is blocked automatically.
- CL5. **Serialised:** the order and checkout paths take a transaction advisory lock on the recipient's hash before counting, then the customer lock (S12's order), so two accounts racing on one number cannot both pass CL3. A checkout counts all its lines together.
- CL6. Reservations count at creation and are checked again when paid (A02); one that would now break a limit is cancelled with a new cancel reason `limit_reached` and notified (S09's cancellation notice).

### Cash products (CS)
- CS1. **Old balance only (D5):** a cash order is paid only when `wallet balance − credits of the last cash_balance_age_hours` covers it, where credits are deposits credited (S03, S04) and admin wallet adjustments that add money (S02); refunds of the customer's own orders are not counted. Otherwise `CASH_BALANCE_TOO_RECENT` with `details.eligibleUsdUnits` and when more becomes eligible. A cash order is never reserved (`awaiting_balance` refused with the same code).
- CS2. **Cash cap:** cash orders of the last 24 hours plus the new one stay within `cash_retail_daily_usd_units` or `cash_merchant_daily_usd_units` (`CASH_DAILY_LIMIT`), inside CL2.
- CS3. **Approval hold:** a cash order whose total is above `cash_retail_approval_above_usd_units` (merchant: `_merchant_`) is paid as usual (S08: the debit and the job in one transaction) with `cash_hold = held`; the fulfilment job does not create an attempt while it is held. The admin gets a Telegram card (customer, account age, amount, recipient masked, the 30-day deposit and cash history) with "موافقة" and "رفض", and the order sits in the live orders room's "بانتظار الموافقة" column.
- CS4. **Approve** sets `approved` and enqueues fulfilment; **reject** sets `rejected` and refunds the whole order (`paid → refunded`, ADR 0013's journal, reason `cash_rejected`); both in one transaction with the audit entry, guarded by `cash_hold = 'held'`. Telegram approval only up to `cash_telegram_ceiling_usd_units`; above it, the panel only (S05 TC4's pattern).
- CS5. **Expiry:** a hold undecided after `cash_hold_hours` is refunded the same way with `expired` (a job every 5 minutes, idempotent on the guard). The customer sees "قيد المراجعة" on the order page while held, then the delivery or the refund notice (F27).
- CS6. Test customers' cash orders follow the same rules against the fake supplier.

### Store section (SC)
- SC1. Category "الرصيد والفواتير" with six games: رصيد سيريتل, رصيد MTN, فاتورة سيريتل, فاتورة MTN, سيريتل كاش, MTN كاش (paused while the supplier marks it unavailable). Credit games carry the denominations the admin links (about ten common values per operator, chosen in the catalog build), named by the amount the line receives ("1,000 ل.س رصيد"); Syriatel's names and routes wait for Q38.
- SC2. **SYP first (D4):** in the section's game pages, the buy box, the cart line, the order page and the sale mode, the price shows SYP large ("تدفع ≈ 1,100 ل.س") and USD small; the wallet is still debited in USD. Without a store rate the section shows USD only, like the rest of the store.
- SC3. The game page says "يصل إلى الخط خلال ثوانٍ" when the route's expected time is under a minute, and the operator's prefixes.

## Money flows
None new in shape. A purchase debits the customer's wallet and credits the supplier side exactly as S08 does; jneedcontur's prepaid balance is funded by a manual treasury movement (S13) to `supplier_prepaid:jneedcontur`. A supplier refusal, a route left without profit, a rejected or expired cash hold are refunded by the existing refund journals (S08, ADR 0013), keyed by the order. Wrong-number credit is not refunded (D8); a goodwill refund stays the admin's S02 wallet adjustment. The cash products are the first way a wallet balance leaves as cash: ADR 0039 amends ADR 0003's "no withdrawals" for them, under CS1–CS5.

## API
| Method and path | Access | Request | Response | Error codes |
|---|---|---|---|---|
| `POST /api/orders` · checkout (S08, S10) | Customer | `amount` products: `quantity` from the amount | unchanged | + `CREDIT_DAILY_LIMIT`, `RECIPIENT_DAILY_LIMIT`, `CASH_BALANCE_TOO_RECENT`, `CASH_DAILY_LIMIT` |
| `GET /api/credit-limits` | Customer | — | remaining section, cash and cash-eligible amounts for the signed-in customer | — |
| `GET /api/admin/credit-policy` · `PUT …` | Admin, re-auth for `PUT` | `creditPolicySchema` | the row | `VALIDATION_FAILED` |
| `PUT /api/admin/catalog/games/:id/service-class` | Admin, re-auth | `{ serviceClass }` | the game | `VALIDATION_FAILED` (a credit or cash game must have one required field) |
| `POST /api/admin/orders/:id/cash-approval` | Admin, re-auth | `{ decision: 'approve' \| 'reject', reason? }` | the order | `ORDER_NOT_DECIDABLE` (no hold, or already decided) |
| Catalog product create and update (S06) | Admin | + `kind: 'amount'`, `minQuantity`, `amountUnitAr` | unchanged | unchanged |
| Supplier detail, catalog, offers, runs, health (S07, S16) | Admin | unchanged, per capability | unchanged | unchanged |

## Jobs and integrations
- `suppliers.sync`, `suppliers.balances`, `suppliers.health`, the order jobs: unchanged in shape; the zddk adapter registered in the worker and API registries for `jneedcontur`.
- `orders.cash-hold-expiry` every 5 minutes (CS5); the Telegram cash card and its buttons (S05's callback pattern, one decision per order by the guard).
- Telegram: low balance, health, account-setting alerts (ZD10), CL4's recipient alert, CS3's card.
- No webhook endpoint for jneedcontur.

## Screens
- **Suppliers list and jneedcontur detail:** like FazerCards' without the webhook and subscription cards; tabs Connection, Catalog (the tree with images), Offers (value-list and `@100` offers labelled), Runs, Health.
- **Product form:** kind `amount` with the unit label, the minimum and maximum amount; the price matrix shows "لكل 100 ل.س".
- **Game page (admin):** the service-class select (none · رصيد وفواتير · كاش), refused for a game without exactly one required field.
- **Settings → "حدود الرصيد والكاش":** the credit policy with each value's meaning.
- **Live orders room and order page (admin):** "بانتظار الموافقة" with approve and reject; the order shows the recipient, the amount and "رقم العملية".
- **Store:** the section's category page, game pages with SYP-first packs and the amount input (keypad numeric, steps of 100, the bounds below it, live SYP and USD totals), the twice-typed number and the confirmation (RN2), the limit messages with the remaining amount, the held state on the order page. Phone width first; RTL screenshots for each state.
- **Sale mode (merchants):** the same amount input and number confirmation.

## Audit and notifications
Audited: the token, the pause switch, a service class, the credit policy, each cash approval, rejection and expiry (with the refund journal). Customer notifications: unchanged events (delivered, refunded, reservation cancelled); the held state needs none. Telegram: as "Jobs".

## Abuse and fraud
- **Cash-out of stolen or reversed deposits:** CS1's 72-hour age, CS2's cap, CS3's approval with the customer's history, no reservation, and S12's freeze; ADR 0039 records the risk.
- **Mule numbers and resale at scale:** CL3 across accounts, CL4's alert, CL2's caps, S20 PO5's merchant rate limit.
- **Races on one number:** CL5's advisory lock; double submits stay S08's idempotency key.
- **Wrong number by mistake:** RN1's operator prefixes, RN2's twice-typed number and confirmation; no refund (D8).
- **Recipient numbers in logs:** ZD6 never logs the query; the masked form in Telegram; full numbers only on the order for the customer and the admin.
- **The supplier changes prices or stops:** the margin guard, RT10's review, the low balance kept to about a week of sales, the pause switch; a single route for the section today (TweetPin later).
- **Forged order results:** no webhook is accepted; only the poll by our key settles an attempt.
- **Key leak:** the IP allowlist holds the server only; the key is stored encrypted and entered in the panel only.

## Edge cases
1. A cart with two credit lines to one number: the second may get `111`; it stays `unknown` and is re-sent with the same key after the minute (ZD7, after Q34); until Q34 is answered the route is not live.
2. `reject` after `wait` hours later (Q37): the attempt fails definitively and the units are refunded (A04), with no other route for credit.
3. The supplier's `price` has more than six decimals after its multiplier: the offer is `cost_precision`, never routed (ZD4).
4. An amount above the only route's `maxQuantity`: the product shows "out of stock" for that amount with the maximum (AM3), not a general outage.
5. A cash order paid with eligible balance, then a refund of another order lands: CS1 is checked at payment only.
6. A held cash order when the customer is frozen: the hold stays for the admin's decision; expiry refunds it (ADR 0026: money already moving continues).
7. The store rate is missing: SYP-first falls back to USD (SC2); the amount input still takes SYP (the face amount, not a price).
8. The customer types `0933 123 456` and `+963 933123456`: both normalise to `0933123456` and match (RN1, RN2).
9. Syriatel's ×1.04 values (Q38): no Syriatel credit pack is active until the answer and one live order show what the line receives.
10. MTN Cash turns available: the sync marks its offer in stock; its game stays paused until the admin opens it.
11. A merchant's sale-mode order for a walk-in customer: merchant caps (CL2, CL3, CS2) apply to the merchant's account.

## Open questions
Owner decisions are settled (D1–D12). The supplier's facts are open as Q31–Q42 in `docs/open-questions.md`; each names what it gates. PR 1 needs none of them. PR 2 (the adapter) needs Q31, Q32 and Q34; the live routes need Q35, Q36 and Q37; Syriatel credit needs Q38; bills and cash need Q39 and Q40; Q41 and Q42 adjust the limits and the no-refund text.

## Acceptance
- PR 1 (with the fake supplier): create the section's games with service classes and an `amount` product; the fake supplier offers `@100` and value-list offers; buy 7,300 SYP of a bill (the amount input, the twice-typed number, SYP first), a credit pack, a cash order above $10 (held, approved in the panel, delivered) and one rejected (refunded); hit each limit and see its message; the recipient alert after a third account.
- PR 2 (after Q31, Q32, Q34): enter the token; "sync now" fills the catalog and tree with images; offers parse exactly; the balance reads.
- Live pilot (owner, with the IP allowlisted and about $20 funded): one MTN credit of 1,000 SYP to the owner's own line, delivered and matched (cost, balance, "رقم العملية"); one Jawaker pack; then the section opens.
- Tests: adapter against a fake HTTP server (every endpoint, `accept`/`wait`/`reject`, value-list and `@100` offers, decimals and `cost_precision`, the derived key, `check` by key, unknown key, every reply outside the shape → `unknown`, `111`, timeouts); RN1 normalisation and prefixes; AM1–AM4 money math; CL2–CL6 and CS1–CS5 including concurrency on one number and on a hold; API 401/403 for every new route and other customers' orders; E2E and RTL screenshots for the section's screens.
- Delivery plan: PR 1 (enum, seed, switch, credential, kind `amount`, field types, service classes, policy, limits, cash hold, store and admin screens, fake supplier offers; deployable alone, the section hidden until a game is active), PR 2 (zddk adapter, sync, orders, poll, docs, then the pilot and the catalog build of the section).
