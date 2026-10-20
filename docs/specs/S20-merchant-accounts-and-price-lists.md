# S20 — Merchant accounts and price lists (F28, F29)

Status: Draft · Date: 2026-10-20 · Scope: `docs/product/v1-scope.md` §F28, §F29 (Phase M) · ADRs: 0003, 0004, 0006, 0007, 0016, 0020, 0021, 0023, 0024, 0026, 0027, 0028, 0030, 0034, 0035 (new)

## Summary
Vertex Digital sells retail only: every account pays the one stored price of a product. The business goal is to sell wholesale to shops across Syria as well. S20 adds **account types** (customer, merchant), the **merchant application** with its review in the panel (approval only by the admin), a **merchant limits tier** (deposits and purchase rate), and **price lists**: retail (today's prices), wholesale (merchants, 5%), cost (accounts the admin chooses, cost + 1%, shown as "سعر خاص") and named **custom lists** that inherit from a parent list. Every list is a set of margin rules with optional fixed prices per product, repriced on every cost and rule change, guarded per list, capped at the retail price, and private to the accounts it is assigned to. Orders record the list they were charged at; reports split sales and profit by list and by merchant.

## Owner decisions (interview, 2026-10-20)
1. Merchant deposit limits: **$2,000 per deposit and $5,000 per 24 hours**, editable in the panel; per-customer overrides (S12) still replace them.
2. Wholesale list: 5% over cost with a **$0.05 minimum margin**, $0 fixed. Cost list: 1%, $0 fixed, $0.01 minimum (Resolved 2026-10-20).
3. **No list price is ever above the retail price**: a list's price is the lower of its own and the retail price; the matrix marks a capped cell.
4. **One review holds every list**: a cost change held for review (S07 P3) keeps the price of every list of that product until the admin decides; accepting reprices them all.
5. **A list's own entries win**: for a product, a custom list's own fixed price or most specific rule (product, game, category, global) applies; only where the list has none do its parent's apply.
6. **A fixed price that stops covering cost + minimum margin falls back to the list's rule price**, with a warning in the matrix and a Telegram notice, until the admin edits or removes it.
7. After a rejection the customer may **reapply after 7 days**; an application waiting for more information **expires after 7 days** without an answer (the customer may apply again at once). Both editable in the panel.
8. Merchants may place **60 orders per 10 minutes** (customers keep 10), editable in the panel.
9. The store shows a private price **with its label only** ("سعر التاجر" for wholesale, "سعر خاص" for cost and custom), never the retail price beside it.
10. The admin can **make a customer a merchant directly** from the panel (shop name, governorate, reason, re-authentication); the merchant accepts the merchant terms before their first purchase.
11. Revoking merchant status or changing an account's list **cancels its open reservations** (with the S09 cancellation email); no money moves, since reservations are unpaid.

## In scope / out of scope
- In:
  - Account type on the customer; the effective price list of an account.
  - The merchant application (store form, status page, resubmission, withdrawal), the merchant terms content page, the shop photo upload.
  - The applications queue and decision page in the panel (approve with a list, request information, reject), the direct grant, revocation, the merchants list.
  - Merchant settings: deposit tier, order rate, reapply wait, information expiry.
  - Price lists: the three seeded root lists, custom lists (create, rename, archive), margin rules per list, fixed prices per list and product, assignment of lists to accounts, the product × list matrix.
  - Repricing every list (rule, fixed, retail cap, fallback), the per-list guard and availability, one review for all lists.
  - Purchases, checkouts, reservations and customer-paid admin orders at the account's list; the list recorded on the order.
  - Private prices in the store (a customer route outside the public cache) and their privacy in share links, receipts, gift pages, search and the live activity.
  - Reports: sales and profit by price list and by merchant.
  - Notifications for the application, the grant, the revocation and list changes; Telegram notices for new applications and fixed-price fallbacks.
- Out (later or never):
  - Merchant dashboard, own selling prices, point of sale, bulk orders, codes in quantity and printing, receipt QR and branded receipt, printable price list, merchant alerts, statements, volume levels: S21 (F30–F39).
  - Higher saved-ID limits for merchants: S21 (F32 recent player IDs).
  - Credit lines, cash-in points, wallet vouchers, reseller API, staff accounts, the mini-store: declined or later (`v1-scope.md` §6).
  - Asking existing merchants to accept a newer version of the merchant terms: not in V1 (like the customer terms, S14).
  - SYP-fixed prices: never (SYP is derived, ADR 0003).
  - Showing the retail price beside a private price: no (owner, 2026-10-20).
  - Price reviews per list: no (decision 4).

## Access
| Action | Route kind | Who |
|---|---|---|
| Read own account type, price kind and merchant state | Customer | Verified customer, not archived (frozen allowed) |
| Apply, resubmit, withdraw an application; upload the shop photo | Customer, `Idempotency-Key` on create | Verified customer, not frozen, not a merchant |
| Accept the merchant terms (directly granted merchant) | Customer | Merchant without an accepted version |
| Read private prices of a game | Customer | Signed-in, verified customer, frozen allowed (reads only) |
| Read the merchant terms page | Public | Anyone |
| Read the applications queue, an application, the merchants list, lists, rules, fixed prices, the matrix | Admin | The admin |
| Request information, reject an application | Admin | The admin |
| Approve an application, grant directly, revoke, change an account's list | Admin, re-authentication | The admin |
| Create, rename, archive a list; set or archive a rule or a fixed price on any list | Admin, re-authentication | The admin |
| Change the merchant settings | Admin, re-authentication | The admin |
| Expire unanswered applications, send Telegram notices, reprice | Worker jobs | System |

Admin routes live under `/api/admin/` with the TOTP-complete session (ADR 0016). A customer only ever reaches their own application, photo and prices; another customer's id answers `NOT_FOUND`.

## Data
Money is USD units (micro-dollars, ADR 0003). The api `pricing` module owns the lists, rules, fixed prices and price rows; a new api `merchants` module owns applications, merchant profiles and merchant settings; the `auth` module's `customers` table gains the account columns (as S12 did with `frozen_at`).

### Contracts (`merchants.ts` new; `pricing.ts`, `customers.ts`, `orders.ts`, `catalog.ts`, `content.ts`, `reports.ts`, `notifications.ts`, `telegram.ts`, `audit.ts`, `errors.ts` extended)
- `ACCOUNT_TYPES` (`customer`, `merchant`); `PRICE_LIST_KINDS` (`retail`, `wholesale`, `cost`, `custom`); `PRICE_KINDS` shown to customers (`retail`, `wholesale`, `special`) and `priceKindOf(listKind)` (cost and custom are `special`).
- `PRICE_SOURCES` (`rule`, `fixed`, `fixed_fallback`, `retail_cap`).
- Pure functions, 100% coverage:
  - `listChain(lists, listId)`: the list, then its parents to the root (LS3).
  - `resolveListEntry(chain, entries, path)`: the fixed price or rule that applies (LS4), with the list it came from.
  - `listPrice(cost, entry, retailPrice)`: the price, its source and its minimum margin (LP1–LP4).
  - `effectiveDepositLimitSettings` gains the merchant tier (MD1).
- `merchantApplicationInputSchema` with the enums below, `merchantApplicationSchema` (customer view), `adminMerchantApplicationSchema`, `merchantSettingsSchema`, `priceListSchema`, `createPriceListSchema`, `fixedPriceSchema`, `priceMatrixQuerySchema`, `priceMatrixSchema`, `customerPricesSchema`.
- Form enums: `MERCHANT_ACTIVITIES` (`phone_shop`, `gaming_lounge`, `services_shop`, `wholesale_distributor`, `online_store`, `other`), `YEARS_IN_BUSINESS` (`under_1`, `1_3`, `over_3`), `GOVERNORATES` (`damascus`, `rif_dimashq`, `aleppo`, `homs`, `hama`, `latakia`, `tartus`, `idlib`, `deir_ez_zor`, `raqqa`, `hasakah`, `daraa`, `as_suwayda`, `quneitra`, `outside_syria`), `MONTHLY_VOLUMES` (`under_200`, `200_500`, `500_2000`, `2000_5000`, `over_5000`), `PRODUCT_INTERESTS` (`game_topups`, `gift_cards`, `chat_apps`), `SALES_CHANNELS` (`shop_counter`, `whatsapp_telegram`, `social_pages`, `online_store`), `HEARD_FROM` (`friend_or_shop`, `facebook`, `instagram`, `telegram`, `whatsapp`, `search`, `other`).
- `MERCHANT_APPLICATION_STATUSES` (`under_review`, `info_requested`, `approved`, `rejected`, `expired`, `withdrawn`) and `applicationTransition(status, event)` (MA rules), pure.
- `CONTENT_PAGES` gains `merchant_terms` (F21, S14 drafts and versions).
- `STORED_FILE_KINDS` gains `merchant_shop_photo`.
- `PRICE_CHANGE_CAUSES` gains `list_change` (a list created or archived, a fixed price set or archived, the backfill); assigning a list to an account writes no price row.
- `ORDER_CANCEL_REASONS` gains `price_list_changed`.
- Error codes, each with its Arabic text: `MERCHANT_APPLICATION_OPEN` (409, `details.applicationId`), `MERCHANT_REAPPLY_TOO_SOON` (409, `details.availableAt`), `MERCHANT_TERMS_UNAVAILABLE` (409), `MERCHANT_TERMS_REQUIRED` (409), `ALREADY_MERCHANT` (409), `NOT_MERCHANT` (409), `APPLICATION_STATE_INVALID` (409, `details.status`), `PRICE_LIST_IN_USE` (409, `details.accounts`, `details.children`), `PRICE_LISTS_LIMIT_REACHED` (409), `PRICE_LIST_NAME_TAKEN` (409), `PRICE_LIST_ARCHIVED` (409); existing `GLOBAL_RULE_REQUIRED`, `PRICE_CHANGED`, `PRODUCT_UNAVAILABLE`, `ACCOUNT_FROZEN`, `REAUTHENTICATION_REQUIRED`, `IDEMPOTENCY_KEY_REUSED`, `VALIDATION_FAILED`, `RATE_LIMITED`, `NOT_FOUND`, `IMAGE_INVALID`, `PAYLOAD_TOO_LARGE`.

### `price_lists` (new; business table, archived not deleted; owner `pricing`)
- `id`, `kind` (`price_list_kind`, required), `name` text (2–60 after trimming; unique among unarchived lists, case-insensitive), `parent_list_id` uuid → `price_lists` (required for `custom`, null otherwise; fixed after creation, so no cycle can form), `timestamps`, `archived_at`.
- Seeded by the migration with fixed ids: `retail` ("التجزئة"), `wholesale` ("الجملة"), `cost` ("سعر التكلفة"). One live list per root kind (partial unique index on `kind` where `kind <> 'custom' and archived_at is null`); root lists are never archived (a check in the guard migration).
- Index on `parent_list_id`. At most 20 unarchived custom lists (checked by the API under the lists' advisory lock).

### `margin_rules` (S06; changed)
- Gains `price_list_id` uuid → `price_lists`, required; existing rows backfilled to the retail list. The unique live indexes become `(price_list_id, scope, target_id)` and one live global rule per list.
- Seeded: the wholesale global rule (500 bp, $0, $0.05) and the cost global rule (100 bp, $0, $0.01). Root lists always have a live global rule (`GLOBAL_RULE_REQUIRED` on archive, as PR9); a custom list's global rule is optional.

### `price_list_fixed_prices` (new; business table, archived; owner `pricing`)
- `id`, `price_list_id` → `price_lists` (required), `product_id` → `catalog_products` (required), `price_usd_units` (whole cents, > 0, ≤ $10,000), `timestamps`, `archived_at`. One live row per `(price_list_id, product_id)` (partial unique index). Indexes on both foreign keys. Changing a fixed price archives the row and inserts a new one in the same transaction, so a price row can name the value it used.

### `product_prices` (S07; changed, still append-only)
- Gains `price_list_id` → `price_lists`, required (backfilled to retail), `source` (`price_source`, required, backfilled `rule`), `fixed_price_id` → `price_list_fixed_prices` (nullable; set for `fixed` and `fixed_fallback`); `rule_id` keeps the rule whose values are copied (for `fixed` and `fixed_fallback` the list's resolved rule, whose minimum margin guards the price; for `retail_cap` the retail row's rule).
- The newest row per `(product_id, price_list_id)` is that list's price; the index becomes `(product_id, price_list_id, created_at desc)`. The check `price > cost` and whole cents stay.

### `customers` (S01; changed)
- `account_type` (`account_type`, required, default `customer`).
- `price_list_id` → `price_lists`, nullable: null means the type's default (retail for a customer, wholesale for a merchant). Index on it.
- Only the `merchants` and `pricing` admin paths write these columns, with the customer `FOR UPDATE` first (as S12's state changes).

### `merchant_profiles` (new; business table, keyed by customer; owner `merchants`)
- `customer_id` → `customers` (primary key), `trade_name` (2–80), `governorate` (`governorate`), `city` (2–60), `application_id` → `merchant_applications` (nullable: null for a direct grant), `terms_version_id` → `content_page_versions` (nullable until accepted; guarded: a version of `merchant_terms`), `granted_at`, `revoked_at` (nullable), `updated_at`. A re-grant after a revocation updates the row (the audit log keeps the history). Listed in `NATURAL_KEYS`.

### `merchant_applications` (new; business table, never deleted; owner `merchants`)
- `id`, `customer_id` → `customers` (required), `status` (`merchant_application_status`), the form: `trade_name` (2–80), `activity`, `activity_other` (2–80, required only for `other`), `years_in_business`, `governorate`, `city` (2–60), `street_address` (5–160), `whatsapp` (E.164 from `phoneSchema`), `telegram_username` (nullable, `^[A-Za-z0-9_]{5,32}$` without `@`), `monthly_volume`, `product_interests` (`product_interest[]`, 1–3 distinct), `sales_channels` (`sales_channel[]`, 1–4 distinct), `shop_photo_file_id` → `stored_files` (nullable), `shop_link` (nullable, `https://` URL, ≤ 300), `terms_version_id` → `content_page_versions` (required, guarded to `merchant_terms`), `heard_from` (nullable), `idempotency_key` (unique), `admin_message` (nullable, 5–500: the information requested or the rejection reason the customer reads), `approved_price_list_id` → `price_lists` (nullable, set on approval), `submitted_at`, `info_requested_at`, `decided_at`, `timestamps` (no `archived_at`: closed by a final status; listed in `NOT_BUSINESS_RECORDS` with that reason).
- One open application per customer: partial unique index on `customer_id` where `status in ('under_review', 'info_requested')`. Indexes `(status, submitted_at)`, `(customer_id, created_at desc)`, and on each foreign key.
- `merchant_applications_guard` (hand-written): no delete; a final status (`approved`, `rejected`, `expired`, `withdrawn`) never changes; transitions only on MA's table; `customer_id`, `idempotency_key` fixed; the form fields change only on `info_requested → under_review` (a resubmission).

### `merchant_application_events` (new; append-only)
- `id`, `application_id` → `merchant_applications`, `event` (`submitted`, `info_requested`, `resubmitted`, `approved`, `rejected`, `expired`, `withdrawn`), `message` (nullable, the admin's text), `created_at` stamped with `clock_timestamp()`. The customer's status timeline. `append_only_guard` and the revokes.

### `merchant_settings` (new; append-only versions, seeded; the newest row is in force)
- `id`, `per_deposit_usd_units` ($2,000), `daily_deposit_usd_units` ($5,000), `orders_per_ten_minutes` (60; 10–500), `reapply_wait_days` (7; 0–365), `info_expiry_days` (7; 1–60), `admin_id`, `created_at`. Checks: limits whole cents above zero, per deposit ≤ daily, both ≥ the Sham Cash and USDT minimums (checked by the contract against the current deposit settings).

### `orders` (S08; changed)
- Gains `price_list_id` → `price_lists`, required (backfilled to retail); fixed by `orders_guard` except on `awaiting_balance → paid` together with the price columns (S09). Index on it. A walk-in order and an owner-funded admin order take the retail list (PO4).

## States and rules

### Account type and effective list
- AT1. Every account is `customer` (default) or `merchant`. The type decides what the person sees (the merchant badge now, the merchant tools in S21) and the limits tier (MD1, MD3); the **effective list** decides what they pay: `customers.price_list_id` when set, else retail for a customer and wholesale for a merchant.
- AT2. The admin may assign any unarchived list to any account, customer or merchant (`PUT /api/admin/customers/:id/price-list`, re-authentication, reason 5–500); `null` returns to the type's default. A frozen account may be assigned; an archived one is refused (`CUSTOMER_STATE_INVALID`). The cost list is only ever assigned, never requested.
- AT3. A change of account type or effective list, in one transaction with the customer `FOR UPDATE`: writes the columns, cancels the account's `awaiting_balance` orders with `price_list_changed` (S09 cancellation email; decision 11), writes the audit entry, and notifies the customer (`price_list_changed`, center only, no list name). Purchases take the customer `FOR SHARE` (`lockActiveCustomer`), so a purchase and a change are serialized: a purchase sees the old or the new list, never a mix.
- AT4. A customer only ever learns their **price kind** (`retail`, `wholesale` or `special`), never a list's name, rule or cost.

### Price lists
- LS1. Lists are `retail`, `wholesale`, `cost` (seeded roots, renamable, never archived) and up to 20 unarchived `custom` lists, each with a parent (any unarchived list, root or custom) fixed at creation.
- LS2. A list holds margin rules (global, category, game, product; S06 PR1 bounds; minimum margin at least $0.01) and fixed prices per product (whole cents). Root lists always have a global rule.
- LS3. **Chain:** a list's chain is the list then its parents up to its root. Depth is at most 5 (`VALIDATION_FAILED` on create beyond it).
- LS4. **Resolution** (decision 5), for a product with path (product, game, category): walking the chain from the list itself, the first list that has, in this order, a live fixed price for the product, a product rule, a game rule, a category rule, or a global rule supplies the entry. Within a list a fixed price beats its rules; across lists the nearer list wins whatever its specificity. The **guarding rule** of a fixed price is the rule the same walk finds when fixed prices are skipped from that list onward.
- LS5. Archiving a custom list is refused while an account is assigned to it or an unarchived list names it as parent (`PRICE_LIST_IN_USE` with the counts). Archiving archives its rules and fixed prices in the same transaction; its price rows stay (orders name them).
- LS6. Every list change (create, rename, archive, a rule or a fixed price set or archived, an assignment) needs re-authentication and writes an audit entry with before and after.

### List prices
- LP1. For each list `L` and product, with the basis route's cost `c` (S07 P1, the same basis for every list) and the entry from LS4:
  - a rule: `p = priceFromCost(c, rule)` (PR3), source `rule`, minimum margin the rule's;
  - a fixed price `f` with guarding rule `g`: when `f − c ≥ g.minMargin`, `p = f`, source `fixed`; otherwise `p = priceFromCost(c, g)`, source `fixed_fallback` (decision 6); minimum margin `g`'s.
- LP2. **Retail cap** (decision 3): for every list but retail, when `p` is above the retail list's current price for the product, the list's price is the retail price, source `retail_cap`, with the retail row's rule and minimum margin. The retail price itself is guarded (P8), so a capped price never sells below cost plus retail's minimum margin.
- LP3. The retail list is LP1 alone. Its fixed prices are allowed (a marketing price such as $0.99) under the same fallback.
- LP4. Every price row is a whole cent above cost (P8's check); math stays integer and rounds only upward (ADR 0020).

### Repricing
- RP1. `repriceProducts` prices **every unarchived list** for the given products under the same product locks (S07 P2: games `FOR SHARE`, products `FOR UPDATE`, in id order), retail first, since LP2 reads its result. A list's row is appended only when its price, source, basis route, rule id, rule values or fixed price id differ from its current row (Q21 applies per list).
- RP2. **Review** (decision 4): the review decision (S07 P3, S19 RT10) is taken on the retail list alone. While a product has an open review, no list's price changes (each list's target is computed for the matrix only); accepting the review appends the retail row (`review_accepted`) and reprices every other list with the same cause in the same transaction; pausing pauses the product for everyone; adjusting the margin sets a retail product rule (S07 P4).
- RP3. **Causes:** a sync, a route change, a rule change on any list, a fixed price set or archived, a list created or archived reprice the affected products for every list (rule changes on a list reprice the products it governs on that list and on every list whose chain contains it). Creating a list prices every product with a current retail row for it, in the same transaction (cause `list_change`).
- RP4. **Backfill:** the migration adds the columns and seeds; the one-off command `pnpm --filter @vertex-digital/api pricing:reprice-lists` (idempotent: it writes only missing or changed rows) prices every product for every list after the deploy. Until a product has a row on a list it is `out_of_stock` for that list's accounts.
- RP5. A fixed price entering `fixed_fallback` queues one Telegram `fixed_price_fallback` notice (dedupe key `fixed-fallback:<list>:<product>:<Damascus date>`), and the daily summary counts the fallback cells.

### Availability, purchase and reservations
- PO1. **Availability for an account** is S07 P6 on the account's list row: `out_of_stock` without a row on that list or without a usable route; `paused_by_margin_guard` when no usable route is profitable for the list's current price under its row's minimum margin. Hidden, paused, the switches, test-customer routing and the player check are unchanged.
- PO2. **Purchase and checkout** (`prepareLine`): the line's price is the current row of the customer's effective list, read under the customer `FOR SHARE` and the product `FOR SHARE`; `expectedUnitPriceUsdUnits` must equal it, else `PRICE_CHANGED` with the list's price. The order stores the row (`price_id`), its minimum margin and `price_list_id`. Routing's margin guard (PR5) uses the order's stored minimum margin, as today.
- PO3. **Reservations** (S09 RS6) are paid at the lower of the saved price and the current price **of the order's list**; when the customer's effective list is no longer the order's list (a race with AT3), the reservation is cancelled with `price_list_changed` instead of paid.
- PO4. **Admin orders** (S16): customer-paid modes (on behalf) charge the customer's effective list and need the merchant terms like the customer (MT2); walk-in and owner-funded modes use the retail list.
- PO5. **Rate limit** (decision 8): `POST /api/orders` and checkouts count against `merchant_settings.orders_per_ten_minutes` per customer for a merchant (10 for a customer); the per-IP limit for a merchant's request is the same number (a shop's counter shares one IP).
- PO6. **Daily purchase cap** (S12 LM4) applies to merchants unchanged; no store-wide cap.

### Merchant deposit limits
- MD1. A merchant's per-deposit and 24-hour limits are the merchant tier of `merchant_settings` ($2,000 and $5,000, decision 1), in place of the new and established tiers; minimums (Sham Cash $2, USDT $5), the shared 24-hour window, the open-deposit counts and everything else in S03 SC3 and S04 are unchanged.
- MD2. S12 per-customer overrides replace the tier's values for merchants as for customers; the profile's limit source reads "الافتراضي: تاجر".
- MD3. Revocation returns the account to the new or established tier at once; deposits already created keep their state (limits apply at creation, SC3).
- MD4. Telegram approval of Sham Cash deposits keeps its $100 ceiling (S05 TC4) for merchants.

### Merchant terms
- MT1. The `merchant_terms` content page (S14: draft, publish, versions) is shown at `/merchant-terms`. Until a version is published, applications answer `MERCHANT_TERMS_UNAVAILABLE` and the store shows the apply card as "قريباً".
- MT2. An application records the version in force when it was submitted (and again on a resubmission). A directly granted merchant has no accepted version: until they accept the version in force (`POST /api/merchant/terms`), purchases, checkouts and reservations answer `MERCHANT_TERMS_REQUIRED` and the store shows the acceptance sheet (decision 10). Reads and deposits are allowed.

### Merchant applications
- MA1. **Who:** a verified, not frozen, unarchived customer of type `customer` with no open application (`MERCHANT_APPLICATION_OPEN`), and, when their latest application was rejected, at least `reapply_wait_days` after its decision (`MERCHANT_REAPPLY_TOO_SOON` with `availableAt`). A merchant answers `ALREADY_MERCHANT`. Test customers may apply (their accounts stay out of reports).
- MA2. **Form** (F28): the fields of `merchant_applications`; the contact name is the account's name (read-only; the customer changes it on the profile); WhatsApp defaults to the account phone; the photo, link, Telegram username and "how did you hear" are optional; the terms acceptance is required. Text fields are trimmed and refuse control characters and links outside `shop_link`.
- MA3. **Shop photo:** `POST /api/merchant/application/photo` takes one JPEG, PNG or WebP up to 5 MB through the receipt pipeline (validated, re-encoded, metadata stripped, kind `merchant_shop_photo`), returns a file id owned by the customer, usable in one application; served to the customer who uploaded it and to the admin only.
- MA4. **Transitions:**

  | From | Event | To | By |
  |---|---|---|---|
  | — | submit | `under_review` | Customer |
  | `under_review` | request information (message 5–500) | `info_requested` | Admin |
  | `info_requested` | resubmit (edited form) | `under_review` | Customer |
  | `under_review` | approve (a list, default wholesale) | `approved` | Admin, re-authentication |
  | `under_review` | reject (reason 5–500) | `rejected` | Admin |
  | `under_review`, `info_requested` | withdraw | `withdrawn` | Customer |
  | `info_requested` | no answer for `info_expiry_days` | `expired` | Worker |

  Any other move answers `APPLICATION_STATE_INVALID`. Each writes an event, an audit entry and the notification of NT1, in one transaction with the application `FOR UPDATE`.
- MA5. **Approval**, in one transaction: the customer `FOR UPDATE` (refused when frozen or archived with `CUSTOMER_STATE_INVALID`), `account_type = merchant`, `price_list_id` = the chosen list (null when wholesale, the merchant default), the merchant profile upserted from the form with the application's terms version, AT3's reservation cancellation, the application `approved` with `approved_price_list_id`, the audit entries (`merchant_application.approved`, `customer.merchant_granted`), the notification.
- MA6. **Direct grant** (decision 10): from the customer profile, trade name, governorate, city, an optional list and a reason (5–500), re-authentication; the same transaction as MA5 without an application; an open application of that customer is closed as `approved` by it.
- MA7. **Revocation**: reason 5–500, re-authentication; `account_type = customer`, `price_list_id = null` (back to retail; decision: F28), `merchant_profiles.revoked_at` set, AT3's cancellation; the balance, orders and history are untouched. The customer may apply again at once (a revocation is not a rejection).
- MA8. **Queue order:** `under_review` by `submitted_at` (oldest first); the dashboard's attention list gains `merchant_applications_waiting` (S11 DB6) while any application is `under_review`.

## Money flows
No new journal kind. A purchase at a list price posts S08 M1 (`purchase`, `order:<id>:purchase`: `customer_wallet:<customer>` −total, `sales_revenue:USD` +total) with the list's price; refunds (S08 M3), cost of goods (S13 LS1) and checkouts (S10 M1) are unchanged. A reservation paid at its list's charge posts S09's journal. Approval, revocation, assignment and list changes move no money; cancelled reservations were never charged. Reports read the list from `orders.price_list_id`; profit per order is `sales − refunds − cost of goods` as R1.

## API
| Method and path | Access | Request | Response | Error codes |
|---|---|---|---|---|
| `GET /api/me` (S01, extended) | Customer | — | adds `accountType`, `priceKind`, `merchant` (`{ tradeName, termsAccepted }` or null) | — |
| `GET /api/catalog/games/:slug/prices` | Customer, `cache-control: private, no-store` | — | `customerPricesSchema`: per product `available`, `priceUsdUnits`, `priceSypUnits`, `savings`, and the game's `priceKind`, `rateId` | `NOT_FOUND` |
| `GET /api/merchant/application` | Customer | — | the latest application with its events, or null; `canApply`, `availableAt`, `termsVersionId` | — |
| `POST /api/merchant/application` | Customer, `Idempotency-Key`, 5 / day | `merchantApplicationInputSchema` | `201` `merchantApplicationSchema` | `MERCHANT_APPLICATION_OPEN`, `MERCHANT_REAPPLY_TOO_SOON`, `MERCHANT_TERMS_UNAVAILABLE`, `ALREADY_MERCHANT`, `ACCOUNT_FROZEN`, `VALIDATION_FAILED`, `IDEMPOTENCY_KEY_REUSED`, `RATE_LIMITED` |
| `PUT /api/merchant/application` | Customer, 10 / hour | the form | `merchantApplicationSchema` | `APPLICATION_STATE_INVALID`, `VALIDATION_FAILED` |
| `POST /api/merchant/application/withdraw` | Customer | — | `merchantApplicationSchema` | `APPLICATION_STATE_INVALID` |
| `POST /api/merchant/application/photo` | Customer, multipart, 10 / hour | `file` | `{ fileId }` | `IMAGE_INVALID`, `PAYLOAD_TOO_LARGE`, `RATE_LIMITED` |
| `GET /api/merchant/application/photo/:fileId` | Customer (own) | — | the image | `NOT_FOUND` |
| `POST /api/merchant/terms` | Customer (merchant) | `{ versionId }` | `204` | `NOT_MERCHANT`, `VALIDATION_FAILED` (not the version in force) |
| `GET /api/content/pages/merchant_terms` (S14) | Public | — | the page | `NOT_FOUND` |
| `GET /api/admin/merchant-applications` | Admin | `status?`, cursor | page of rows | — |
| `GET /api/admin/merchant-applications/:id` | Admin | — | `adminMerchantApplicationSchema`: the form, photo url, events, the customer summary (age, verified, deposits credited count and total, orders and sales, balance, frozen, signals of S12, pinned note, earlier applications) | `NOT_FOUND` |
| `POST /api/admin/merchant-applications/:id/request-info` | Admin | `{ message }` | the application | `APPLICATION_STATE_INVALID` |
| `POST /api/admin/merchant-applications/:id/reject` | Admin | `{ reason }` | the application | `APPLICATION_STATE_INVALID` |
| `POST /api/admin/merchant-applications/:id/approve` | Admin, re-authentication | `{ priceListId? }` | the application | `APPLICATION_STATE_INVALID`, `CUSTOMER_STATE_INVALID`, `PRICE_LIST_ARCHIVED` |
| `GET /api/admin/merchant-applications/:id/photo` | Admin | — | the image | `NOT_FOUND` |
| `GET /api/admin/merchants` | Admin | `q?`, `listId?`, cursor | merchants with trade name, governorate, list, since, 30-day sales | — |
| `POST /api/admin/customers/:id/merchant` | Admin, re-authentication | `{ tradeName, governorate, city, priceListId?, reason }` | the profile | `ALREADY_MERCHANT`, `CUSTOMER_STATE_INVALID` |
| `POST /api/admin/customers/:id/merchant/revoke` | Admin, re-authentication | `{ reason }` | the profile | `NOT_MERCHANT` |
| `PUT /api/admin/customers/:id/price-list` | Admin, re-authentication | `{ priceListId: uuid \| null, reason }` | the profile's pricing | `CUSTOMER_STATE_INVALID`, `PRICE_LIST_ARCHIVED` |
| `GET /api/admin/merchant-settings` · `PUT` | Admin · Admin, re-authentication | — · `merchantSettingsSchema` | the settings | `VALIDATION_FAILED` |
| `GET /api/admin/pricing/lists` | Admin | — | lists with kind, parent, accounts, rules, fixed prices, fallback cells | — |
| `POST /api/admin/pricing/lists` | Admin, re-authentication | `{ name, parentListId }` | `201` the list | `PRICE_LISTS_LIMIT_REACHED`, `PRICE_LIST_NAME_TAKEN`, `PRICE_LIST_ARCHIVED`, `VALIDATION_FAILED` |
| `PATCH /api/admin/pricing/lists/:id` | Admin, re-authentication | `{ name }` | the list | `PRICE_LIST_NAME_TAKEN` |
| `POST /api/admin/pricing/lists/:id/archive` | Admin, re-authentication | — | the list | `PRICE_LIST_IN_USE`, `VALIDATION_FAILED` (a root list) |
| `PUT /api/admin/pricing/rules` (S06, extended) | Admin, re-authentication | adds `priceListId` (default retail) | the rule | as S06, `PRICE_LIST_ARCHIVED` |
| `PUT /api/admin/pricing/lists/:id/fixed-prices/:productId` · `DELETE` (archives) | Admin, re-authentication | `{ priceUsdUnits }` · — | the fixed price and the resulting list price | `NOT_FOUND`, `PRICE_LIST_ARCHIVED`, `VALIDATION_FAILED` |
| `GET /api/admin/pricing/matrix` | Admin | `gameId` or `q`, `listIds?` (up to 8), `warnings?` | `priceMatrixSchema`: per product the cost, basis route, and per list the price, margin, source, target while held, warnings (`fallback`, `capped`, `above_parent`, `held`, `unavailable`, `no_row`) | — |
| `GET /api/admin/reports/breakdown` (S13 R2, extended) | Admin | `by` gains `price_list` and `merchant` | as R2 | — |

The S06 preview (PR10) gains `priceListId`. The admin order form's product list (S16) reads the chosen customer's list prices.

## Jobs and integrations
- `merchants.expire-applications` (cron every 15 minutes): applications `info_requested` with `info_requested_at` older than `info_expiry_days`, `FOR UPDATE SKIP LOCKED`, each in its own transaction with its event, audit (system actor) and notification; the status check makes a second run a no-op.
- Telegram (`queueTelegramMessage`): `merchant_application` on submit and resubmit (no personal data: "طلب تاجر جديد بانتظار المراجعة" with the panel link and the waiting count), `fixed_price_fallback` (list name, product, cost, fixed price, the price used); the daily summary (S05) adds a line for waiting applications and fallback cells when non-zero.
- `store.revalidate` (S09 SF4) is queued only for retail changes (the public catalog shows retail); private prices are read live.
- No supplier, chain or payment call.

## Screens

### Store (phone first, RTL)
- **Account page** (`/account`): a merchant card: for a customer "هل لديك محل؟ قدّم طلب حساب تاجر" (or "قريباً" before MT1's first version, or the application's status); for a merchant "حساب تاجر · <trade name>" with the price kind.
- **Application** (`/account/merchant`): a form in four short steps (المحل، التواصل، النشاط، الإثبات والشروط), each step validated before the next, a summary before sending; the terms link opens `/merchant-terms`. States: under review ("طلبك قيد المراجعة"), information requested (the admin's message, the form editable, "إعادة الإرسال"), approved, rejected (the reason and the date it can reapply), expired, withdrawn; the event timeline below. Loading, error and retry states as other store pages.
- **Merchant terms** (`/merchant-terms`): the content page (S14 rendering).
- **Terms acceptance sheet:** for a directly granted merchant, a bottom sheet on any buy action and a banner on the account page until accepted.
- **Game page and buy box:** for an account whose price kind is not retail, the cached page renders, then the client reads `/api/catalog/games/:slug/prices` and replaces each pack's price and availability; until it answers, prices show a skeleton (never the retail figure) and the buy button waits. A label above the packs: "سعر التاجر" or "سعر خاص" (decision 9). Savings badges use the private price. A failed read shows "تعذّر تحميل أسعارك" with retry and no buy action.
- **Search** and the home page show no prices to non-retail accounts (they come from the public index); the game page shows theirs.
- **Cart:** lines carry the private price; a stale price follows S10's `PRICE_CHANGED` flow.
- **Receipts and share links** (S10): for an order not charged on the retail list, the "show the price" option is hidden and the price is never rendered on the public receipt page or a gift page.

### Admin
- **Applications** (`/merchants/applications`): the queue with status tabs (قيد المراجعة default, بانتظار معلومات, all), trade name, governorate, activity, volume, submitted, customer flags (frozen, shared phone, new account).
- **Application** (`/merchants/applications/$id`): the form, the photo (opens large), the link as text with a copy button, the events; beside it the customer summary and signals (S12) with a link to the profile; actions: approve (a list select, default الجملة; re-authentication), request information, reject; the reason and message fields are required.
- **Merchants** (`/merchants`): table with search and list filter; revoke from the row or the profile.
- **Customer profile** (S12, extended): the account type and effective list (with its source: default or assigned), "تغيير قائمة الأسعار", "جعله تاجراً" or "سحب صفة التاجر", the merchant profile and terms state; the limits card reads the merchant tier.
- **Price lists** (`/pricing/lists`): lists with kind, parent, accounts, rules, fixed prices, fallback count; create, rename, archive. **List page** (`/pricing/lists/$id`): its rules (the S06 rule editor scoped to the list, with the parent's rule shown where the list has none), fixed prices (product search, price, the resulting price and margin before saving), assigned accounts (cost and custom lists: assign by customer search).
- **Matrix** (`/pricing/matrix`): rows are products of a chosen game (or a search), columns the chosen lists (retail always first); each cell shows the price, the margin in dollars and percent, the source badge (قاعدة، ثابت، احتياطي، سقف التجزئة) and its warnings in color; a held product shows its target in a muted line; a filter "التحذيرات فقط". Clicking a cell opens the fixed price or the rule of that list.
- **Merchant settings** (`/settings/merchants`): the five values with their bounds.
- **Reports:** the breakdown report gains "حسب قائمة الأسعار" and "حسب التاجر".

## Audit and notifications
- Audit (each in the transaction of its change, before and after where something changes): `price_list.created`, `price_list.renamed`, `price_list.archived`, `margin_rule.set` and `margin_rule.archived` (details gain `priceListId`), `price_list.fixed_price_set`, `price_list.fixed_price_archived`, `customer.price_list_changed` (reason), `customer.merchant_granted` (application id or reason), `customer.merchant_revoked` (reason), `merchant_application.submitted`, `.resubmitted`, `.info_requested`, `.approved`, `.rejected`, `.expired`, `.withdrawn`, `merchant.terms_accepted`, `merchant_settings.changed`.
- Customer notifications (center and email unless noted, with templates and preferences on by default): `merchant_info_requested`, `merchant_approved`, `merchant_rejected` (the reason), `merchant_application_expired` (center only), `merchant_revoked` (no reason), `price_list_changed` (center only); reservations cancelled by AT3 send S09's cancellation email. Push follows S15 for emailed events.
- Telegram: `merchant_application`, `fixed_price_fallback`, the summary lines (Jobs).

## Abuse and fraud
| Abuse | Control |
|---|---|
| Private prices leaking through the public cache | The public routes and the search index carry retail only; private prices come from a customer route with `private, no-store`, never inside `'use cache'`; a test asserts the public responses are identical for every list |
| Reading another account's prices | The prices route reads the session's customer only; no list id or customer id parameter exists |
| Showing a wholesale price to the merchant's own customer | Receipts and share links never render the price of a non-retail order; gift pages never show prices; live activity has no price |
| Buying at an old list after revocation or a list change | AT3 serializes with purchases on the customer row; `PRICE_CHANGED` on the expected price; reservations cancelled, and PO3 refuses to pay one on a stale list |
| A supplier cost error giving merchants a 90% discount | One review holds every list (RP2); the retail cap and the per-list guard; cost list never below cost + $0.01 |
| A fixed price below cost | LP1 fallback to the guarding rule and the Telegram notice; database check `price > cost` |
| Application spam, fake shops | One open application, 5 submissions a day, the reapply wait, verified email, approval only by the admin beside the customer's history and signals (S12); the photo through the re-encoding pipeline |
| A malicious shop link | Stored as text, shown as text with copy in the panel, never rendered as a link in the store |
| A stolen admin session assigning the cost list | Re-authentication on every list and assignment change, audit, the matrix and merchants list show every assignment |
| A merchant's higher order rate used to drain a stolen account | Wallet-only purchases (no card); the account owner's session and the S12 freeze; the daily purchase cap is available per account |
| Race: rule change and purchase | Product locks (S07 P2) and `PRICE_CHANGED` |
| Race: two admin decisions on one application | The application `FOR UPDATE` and the state check; the guard trigger |
| Double submit of an application | `Idempotency-Key` unique and the open-application unique index |

## Edge cases
1. A product with no row yet on a list (before the backfill, or a list created before a product's first price): `out_of_stock` for that list's accounts (RP4).
2. A custom list whose parent is archived: refused by LS5 (a parent with live children cannot be archived).
3. A custom list with no rules and no fixed prices: it prices as its parent (still a separate row set, so later overrides apply).
4. The retail price is held by a review and a merchant's wholesale price would be lower at the new cost: it stays held (RP2); the matrix shows the target.
5. Retail fixed price $0.99, wholesale rule price $1.02: wholesale is capped at $0.99 (LP2, source `retail_cap`).
6. The retail cap below a list's own minimum margin (the admin set wholesale's minimum above retail's): the capped price is guarded by retail's minimum margin; the matrix warns `capped`.
7. A merchant's list is archived: impossible while assigned (LS5).
8. A merchant frozen: purchases refused (`ACCOUNT_FROZEN`); revocation and list changes still allowed.
9. A merchant revoked with items in the cart: the next checkout answers `PRICE_CHANGED` with retail prices.
10. Approval while the customer was frozen after applying: refused with `CUSTOMER_STATE_INVALID`; the admin unfreezes or rejects.
11. The customer changes their phone after applying: the application keeps the WhatsApp number given; the panel shows both.
12. The merchant terms republished while an application is under review: the application keeps its version; a resubmission records the version then in force.
13. A rejected customer reapplies on day 7 exactly: allowed when `now ≥ decided_at + reapply_wait_days`.
14. Changing `info_expiry_days` affects open requests from the next job run, measured from `info_requested_at`.
15. An admin order on behalf of a merchant who has not accepted the terms: refused with `MERCHANT_TERMS_REQUIRED`.
16. A test customer made a merchant: buys at wholesale, routes only to fake and manual (S08 R4), stays out of reports.
17. 20 custom lists × 2,000 products: one reprice writes at most 23 rows per product, only where changed.
18. A deposit created under the merchant tier, then the merchant revoked: the deposit proceeds (limits apply at creation).

## Open questions
None blocking. Recorded for later: whether existing merchants should accept a newer merchant terms version (not in V1, like the customer terms).

## Acceptance
- End-to-end check (fake supplier, test data, `pnpm db:seed-local`):
  1. In the panel, publish a first `merchant_terms` version. Open Pricing → Lists: retail, wholesale and cost exist; the matrix for PUBG Mobile shows wholesale at cost + 5% (at least $0.05) and cost at cost + 1%, each at most the retail price.
  2. As a test customer, open the account page → apply as a merchant; fill the four steps with a shop photo; submit. The status reads under review; Telegram (log transport) shows the notice without personal data.
  3. In the panel, request information; the customer sees the message, edits the trade name and resubmits. Approve with the wholesale list (re-authentication). The customer gets the email; the account page shows "حساب تاجر".
  4. On the PUBG page as the merchant: prices carry "سعر التاجر" and equal the matrix; sign out: the same page shows retail. Buy 60 UC: the order and the wallet entry use the wholesale price; the order's receipt link shows no price.
  5. Create a deposit of $1,500 USD: accepted (merchant tier); $2,500: refused per deposit.
  6. Create a custom list "VIP" under wholesale with a global 3% rule and a fixed price for 60 UC below cost + minimum: the matrix shows `احتياطي` and Telegram the fallback notice; assign VIP to the merchant: open reservations are cancelled with the email; prices change to "سعر خاص".
  7. Script a 20% cost rise with `supplier:fake --cost`: the review opens; every list's price for that product stays; accept: all lists reprice.
  8. Revoke the merchant: the account returns to retail prices and the established deposit tier.
  9. Reports → breakdown by price list and by merchant show the order.
- Tests:
  - Unit (contracts, 100%): `listChain`, `resolveListEntry` (list-first order, fixed before rules, guarding rule), `listPrice` (rule, fixed, fallback, cap, rounding), `priceKindOf`, `applicationTransition`, the merchant tier in `effectiveDepositLimitSettings`, the form schemas.
  - db: the migration backfill (retail on every rule, row and order), the seeds, the indexes (one live list per root kind, one rule per list target, one fixed price per list product, one open application), `merchant_applications_guard`, events and settings append-only for the app role and the owner, `orders_guard` on `price_list_id`; repricing every list per cause, the review hold and accept for all lists, Q21 per list, a rule change on a parent repricing children, the fallback and cap, a sync and a list change in parallel.
  - API: every endpoint's success, 401, 403 (customer on admin and the reverse), other customers' applications and photos (`NOT_FOUND`), re-authentication on the sensitive routes, idempotent application creation, the reapply wait, the expiry job twice; the purchase at the effective list, `PRICE_CHANGED` after a list change, a purchase racing an assignment (serialized), reservations cancelled on change and PO3, the merchant order rate, admin orders per mode, `MERCHANT_TERMS_REQUIRED`; the public catalog identical whatever the session; receipts hiding non-retail prices.
  - E2E and RTL screenshots: the application steps and its states, the merchant game page with labels and the loading skeleton, the panel queue, application page, lists, list page and matrix, the customer profile's pricing card.
- Delivery plan: PR 1 lists in the database and the engine (schema, backfill, seeds, `repriceProducts` per list, the review hold, `prepareLine` and reservations by list, `orders.price_list_id`, the reprice command; deployable alone: every account is on retail); PR 2 the panel's lists, rules per list, fixed prices, matrix and assignments, with the private prices route and the store's overlay and privacy rules; PR 3 merchants: account type, applications, terms, photo, merchant settings and limits, the panel queue and merchants pages, notifications and Telegram, the reports split.
