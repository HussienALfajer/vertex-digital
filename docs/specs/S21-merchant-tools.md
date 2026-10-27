# S21 — Merchant tools (F30–F39)

Status: Approved · Date: 2026-10-21 · Scope: `docs/product/v1-scope.md` §F30–§F39 (Phase M) · ADRs: 0003, 0004, 0005, 0011, 0020, 0022, 0023, 0024, 0026, 0027, 0029, 0035, 0036 (new)

## Summary
S20 made shops merchants who buy at their own price list; they still buy through the retail screens, one pack at a time. S21 gives them the tools of a shop counter: their **own selling prices** (a markup plus per-product prices, in SYP or USD) with profit per order and per period, a **dashboard**, a **point-of-sale screen**, **bulk orders** of up to 50 lines paid at once, **codes in quantity** printed on 58 or 80 mm thermal printers, a **receipt verification QR** on every receipt (store-wide) and a **receipt in the shop's name**, a **printable price list**, **alerts** for followed products and a low balance, a **monthly statement**, and **volume levels** that move a merchant to a better price list as their monthly purchases grow. No new money flow: every purchase is still S08's or S10's journal.

## Owner decisions (interview, 2026-10-21)
1. **Own selling prices:** a merchant-wide markup percentage over the merchant's purchase price, plus an optional price per product in SYP or USD. A SYP price stays as set when the exchange rate changes.
2. **Volume levels:** by calendar month (`Asia/Damascus`). A merchant is upgraded as soon as this month's purchases reach a level's threshold; on the 1st the level is recomputed from the previous month and may go down. A list the admin assigns to the account wins over the level.
3. **Alerts:** for games and products the merchant follows (suggested from what they bought in the last 30 days), in the notification center and by push, with an optional daily email digest; a low-balance threshold set by the merchant.
4. **Statement:** any past month, or this month to date, on demand (print/PDF page and Excel); an email on the 1st links to last month's statement.
5. **Bulk orders:** up to 50 lines, paid at once (all or nothing, like the cart). Each line's player ID is checked live within a merchant quota (100 an hour instead of 10); a line whose ID was not found or not checked needs the merchant's explicit confirmation before paying.
6. **Codes in quantity:** a merchant buys up to 50 codes of one code pack in one order (customers keep the product's limit); prints all or one, copies, or exports them to Excel; every print, copy and export is logged like a reveal.
7. **Merchant receipt:** the shop name, an optional WhatsApp number and an optional logo (black and white on thermal paper), and the merchant's selling price. The verification page shows the order number, game, pack, delivered quantity, delivery time and the masked player ID; never a price or a code.
8. **Levels start empty:** none are seeded; the admin creates them (name, monthly threshold, price list). Until then every merchant stays on wholesale.
9. **Documents:** print-ready pages in the store ("طباعة / حفظ PDF" through the browser's print dialog), PNG images rendered by the server for WhatsApp, and Excel for the statement and codes. No server-side PDF.
10. **Player IDs at the counter:** the last 20 distinct IDs used per game, taken from the merchant's orders without saving; merchants may save 50 IDs per game and 300 per account (customers keep 10 and 50).
11. **Alert timing:** price and availability changes are batched in at most one notification an hour, comparing the current state with what was last told; the low-balance alert is immediate and sent once until the balance is back above the threshold.
12. **Verification QR on merchant receipts:** always present; for a merchant's order the page shows the shop name first and "تم التحقق عبر VERTEX DIGITAL" in small type, with no buy links, prices or sign-up prompts.

Defaults chosen in the spec (editable in the panel or by the merchant, flag in review if wrong): merchant player checks 100 an hour and 300 a day; SYP rounding step for selling prices 5, 10, 50, 100, 500 or 1,000 SYP (default the store's display step); at most 10 live levels; at most 200 followed items; logo up to 1 MB; the trade name on receipts is the one the admin approved (the merchant asks for a change through a ticket).

## In scope / out of scope
- In:
  - The merchant area in the store (`/merchant/*`), for accounts of type `merchant` only.
  - F31 selling settings (markup, SYP step), per-product selling prices, the selling price snapshot on each merchant order, editable afterwards.
  - F30 the dashboard (today and this month): sales, spending, estimated profit, balance, top products, the level and the gap to the next.
  - F32 the point-of-sale screen: product grid, keyboard shortcuts, recent and saved player IDs, two taps and a confirmation, live status, print.
  - F33 bulk orders: paste or CSV, check, pay once through the S10 checkout (50 lines for merchants), follow each line.
  - F34 up to 50 codes per order for merchants; release for print, copy and Excel, logged; thermal print pages (58 and 80 mm) with redemption steps.
  - F35 a verification code on every order, the QR on every receipt and printed page, the public verification page; the branded receipt (print and share link) with the shop name, WhatsApp, logo and selling price.
  - F36 the printable price list (selling or purchase prices, SYP, USD or both), as a print page and a PNG.
  - F37 follows, the hourly change alerts, the optional daily email digest, the low-balance alert.
  - F38 the monthly statement (page, print, Excel) and the monthly email.
  - F39 volume levels: the panel's levels page, the level computation and its jobs, the level in the effective list (amends ADR 0035).
  - Routing skips a route whose supplier offer allows fewer units than the order needs (QT3).
  - The panel: levels, merchant settings' new values, the merchant's level and branding on the customer profile, code releases on the order page.
- Out (later or never):
  - Cashier or staff accounts, a reseller API, the merchant mini-store, credit lines: declined or later (`v1-scope.md` §6).
  - A server-side PDF file or a PDF attached to email: no (decision 9).
  - Hiding the verification QR on merchant receipts: no (decision 12).
  - Statements for retail customers: not in V1 (merchants only).
  - Price-drop and back-in-stock alerts for retail customers: S22 (F42).
  - Printing through a printer driver or Bluetooth from the server: no; the browser prints.
  - Bulk orders for code packs with several units per line beyond 50 per line, or more than 50 lines: no.

## Access
| Action | Route kind | Who |
|---|---|---|
| Read the dashboard, selling prices, follows, alert settings, receipt settings, recent players, statements, price list | Customer | Merchant (not archived; frozen allowed: reads only) |
| Change selling settings and prices, an order's selling price, follows, alert and receipt settings; upload the logo | Customer | Merchant, not frozen |
| Check a bulk list | Customer, quota | Merchant, not frozen, terms accepted (S20 MT2) |
| Pay a bulk list (S10 checkout) or a POS purchase (S08 order) | Customer, `Idempotency-Key` | Merchant, not frozen, terms accepted |
| Release an order's codes for print, copy or export | Customer | The merchant who owns the order |
| Read an order's print page data | Customer | The order's customer |
| Read a verification page | Public, rate-limited | Anyone holding the code |
| Read, create, edit, archive levels; change the merchant settings | Admin; re-authentication for changes | The admin |
| Remove a merchant's logo | Admin, re-authentication | The admin |
| Compute levels, send alerts, digests and statement emails | Worker jobs | System |

A customer of type `customer` calling a merchant route gets `NOT_MERCHANT`. A merchant reaches only their own orders, prices, follows and statements; another account's order id answers `NOT_FOUND`. A revoked merchant keeps their data (selling prices, follows, branding) untouched but cannot reach it until granted again.

## Data
Money is USD units (micro-dollars) or SYP units with the rate used (ADR 0003). A new api module `merchant-tools` owns the merchant area's tables; `merchants` (S20) owns levels; `orders` owns verification codes and code releases.

### Contracts (`merchant-tools.ts` new; `merchants.ts`, `orders.ts`, `notifications.ts`, `audit.ts`, `errors.ts`, `files.ts` extended)
- Pure functions, 100% coverage:
  - `sellingPrice(purchaseUsdUnits, settings, ownPrice, rate)`: the selling price in USD units and SYP units and its source (`product`, `markup`, `none`); USD rounds up to whole cents, SYP up to the merchant's step.
  - `saleProfit(order, sale)`: delivered units × (selling unit price in USD − unit price paid); null without a sale.
  - `levelFor(levels, previousMonthUsdUnits, thisMonthUsdUnits)`: the highest live level whose threshold is at most the larger of the two, or null.
  - `effectivePriceListId({ accountType, priceListId, levelListId })` (S20's function, extended; PR 1): assigned list, else the level's list (merchants), else the type default (amends S20 AT1).
  - `parseBulkLines(text, game)`: lines of the bulk text or CSV into `{ fields, pack, quantity }` with per-line errors.
  - `damascusMonth(instant)` and `monthRange(month)`.
- Schemas: `sellingSettingsSchema`, `sellingPriceInputSchema`, `merchantDashboardSchema`, `bulkCheckRequestSchema`, `bulkCheckResultSchema`, `codeReleaseRequestSchema` (`purpose`: `print`, `copy`, `export`; `codeIds?`), `orderPrintSchema`, `publicVerificationSchema`, `receiptSettingsSchema`, `watchesSchema`, `alertSettingsSchema`, `priceListQuerySchema`, `statementSchema`, `merchantLevelSchema`, `merchantLevelInputSchema`.
- Constants: `MERCHANT_CODE_QUANTITY_MAX = 50`, `BULK_LINES_MAX = 50`, `RECENT_PLAYERS_PER_GAME = 20`, `MERCHANT_SAVED_PLAYERS_PER_GAME = 50`, `MERCHANT_SAVED_PLAYERS_MAX = 300`, `MERCHANT_LEVELS_MAX = 10`, `WATCHES_MAX = 200`, `SYP_STEPS` (500, 1,000, 5,000, 10,000, 50,000, 100,000 SYP units).
- `CODE_RELEASE_PURPOSES` (`reveal`, `print`, `copy`, `export`); `STORED_FILE_KINDS` gains `merchant_logo`.
- Notification events: `merchant_level_changed` (center, email, push), `merchant_watch_digest` (center, push; no email), `merchant_daily_digest` (email only, when the merchant turned it on), `merchant_low_balance` (center, email, push), `merchant_statement_ready` (center, email).
- Error codes, each with its Arabic text: `NOT_MERCHANT` (exists), `BULK_LINES_INVALID` (422, `details.lines`), `PLAYER_CHECK_QUOTA_EXCEEDED` (429, `details.retryAt`), `CODES_NOT_DELIVERED` (409), `MERCHANT_LEVELS_LIMIT_REACHED` (409), `MERCHANT_LEVEL_THRESHOLD_TAKEN` (409), `MERCHANT_LEVEL_NAME_TAKEN` (409, PR 1: a live level's name), `WATCHES_LIMIT_REACHED` (409), `STATEMENT_MONTH_INVALID` (422); existing `CHECKOUT_REFUSED`, `PRICE_CHANGED`, `PLAYER_NOT_CONFIRMED`, `ACCOUNT_FROZEN`, `MERCHANT_TERMS_REQUIRED`, `RATE_LIMITED`, `NOT_FOUND`, `IMAGE_INVALID`, `PAYLOAD_TOO_LARGE`, `REAUTHENTICATION_REQUIRED`, `PRICE_LIST_ARCHIVED`, `PRICE_LIST_IN_USE`, `VALIDATION_FAILED`.

### `merchant_selling_settings` (new; the merchant's own preferences, keyed by customer)
- `customer_id` → `customers` (primary key), `markup_bp` (integer 0–10,000, nullable: null means no markup, so products without their own price have no selling price), `syp_step_units` (one of `SYP_STEPS`, nullable: null means the store's display step), `updated_at`.
- Listed in `NOT_BUSINESS_RECORDS` (the merchant's own preferences, like saved players).

### `merchant_selling_prices` (new; the merchant's own preferences)
- `customer_id` → `customers`, `product_id` → `catalog_products`, `currency` (`usd`, `syp`), `amount_units` (USD units in whole cents or SYP units, > 0, ≤ $10,000 or its SYP equivalent at the time of saving), `updated_at`. Primary key `(customer_id, product_id)`. Deleted for real when the merchant clears it; listed in `NOT_BUSINESS_RECORDS`.

### `merchant_order_sales` (new; one row per merchant order; owner `merchant-tools`)
- `order_id` → `orders` (primary key), `customer_id` → `customers` (index with `order_id`), `currency` (`usd`, `syp`), `unit_amount_units` (> 0), `rate_id` → `exchange_rates` (the rate in force at purchase, used to convert a SYP price to USD), `unit_usd_units` (the USD equivalent, rounded down to whole cents, so profit is never overstated), `source` (`product`, `markup`, `manual`), `created_at`, `updated_at`.
- Written in the purchase or checkout transaction for every merchant order whose product has a selling price (SP4); the merchant may change it later (`manual`). Not a money record (no ledger posting); the order itself is untouched. Listed in `NOT_BUSINESS_RECORDS` with that reason.

### `merchant_receipt_settings` (new; keyed by customer)
- `customer_id` (primary key), `show_whatsapp` boolean (default false), `whatsapp` (E.164, nullable; default the merchant application's WhatsApp), `logo_file_id` → `stored_files` (nullable, kind `merchant_logo`), `updated_at`.

### `merchant_watches` (new; the merchant's own preferences)
- `id`, `customer_id`, `game_id` → `catalog_games` (nullable), `product_id` → `catalog_products` (nullable); exactly one of the two (check); unique per `(customer_id, game_id)` and `(customer_id, product_id)`; at most 200 per customer (checked by the API). Deleted for real.

### `merchant_watch_states` (new; what the merchant was last told, per product)
- `customer_id`, `product_id` (primary key together), `price_usd_units` (the merchant's list price last told, nullable when it had none), `available` boolean, `told_at`. Written by the alerts job only.

### `merchant_alert_events` (new; append-only)
- `id`, `customer_id`, `product_id`, `kind` (`price_down`, `price_up`, `back_in_stock`, `out_of_stock`), `old_price_usd_units`, `new_price_usd_units` (nullable), `created_at`. What each hourly digest said; read by the daily email and the alerts page. `append_only_guard`; rows older than 90 days are deleted by the sweep (a notification log, not a business record; listed with that reason).

### `merchant_alert_settings` (new; keyed by customer)
- `customer_id` (primary key), `low_balance_usd_units` (whole cents, $1–$10,000, nullable: off), `daily_email` boolean (default false), `low_balance_alerted_at` (nullable: set when the alert is sent, cleared when the balance is at or above the threshold again, AL6), `updated_at`.

### `merchant_levels` (new; business table, archived; owner `merchants`)
- `id`, `name_ar` (2–30, unique among live levels), `monthly_threshold_usd_units` (whole dollars, ≥ $1, unique among live levels), `price_list_id` → `price_lists` (required; a `wholesale` or `custom` list, unarchived, checked by the API), `timestamps`, `archived_at`. At most 10 live levels (API, under an advisory lock).
- S20 LS5 gains: a list named by a live level cannot be archived (`PRICE_LIST_IN_USE`, `details.levels`).

### `merchant_profiles` (S20; changed)
- Gains `level_id` → `merchant_levels` (nullable) and `level_changed_at` (nullable). Written by the level job only (LV4).

### `merchant_settings` (S20; changed, still append-only versions)
- Gains `player_checks_per_hour` (100; 10–1,000) and `player_checks_per_day` (300; 30–5,000), seeded in the new version row.

### `saved_players` (S10; unchanged table)
- The per-game and per-account limits become 50 and 300 for merchants (decision 10), checked by the API as today; a revoked merchant keeps rows above the customer limits but cannot add more until under them.

### `checkouts` (S10; changed)
- `line_count` check becomes 1–50; the API keeps 10 for customers and allows 50 for merchants. Gains `source` (`cart`, `bulk`, default `cart`).

### `orders` (S08; changed)
- Gains `verification_code` text, required, unique: 22 base64url characters from 16 CSPRNG bytes, written at insert (backfilled for existing orders by the migration); fixed by `orders_guard`.
- The quantity check stays 1–50 (QT1 raises the limit for merchants up to it).

### `order_code_reveals` (S08; changed, still append-only)
- Gains `purpose` (`code_release_purpose`, required, backfilled `reveal`). One row per code per release, as a reveal.

### `stored_files`
- Kind `merchant_logo`: PNG, JPEG or WebP up to 1 MB, re-encoded to a square WebP of at most 512 px (the receipt pipeline), served to its merchant, the admin, and on the merchant's branded receipts (public, via the share link).

## States and rules

### Merchant area
- MA1. The store shows "أدوات التاجر" (the merchant area) to accounts of type `merchant`. Every `/api/merchant/*` route answers `NOT_MERCHANT` otherwise. A frozen merchant reads only (`ACCOUNT_FROZEN` on writes); an archived account cannot sign in.
- MA2. Every amount the merchant sees is computed on their **effective list** (S20 AT1 as amended by LV5), from the same private prices route logic as the game page (S20, never the public cache).

### Selling prices (F31)
- SP1. **Settings:** a markup in basis points (0–100%, nullable) and a SYP rounding step (`SYP_STEPS`, nullable for the store's step).
- SP2. **Per product:** the merchant may set a price in USD (whole cents) or SYP (a whole number of SYP); clearing it returns to the markup. A SYP price stays fixed whatever the rate (decision 1).
- SP3. **Selling price of a product** (`sellingPrice`): the product's own price when set; else, with a markup, `purchase × (1 + markup)` rounded up to whole cents; else none. The SYP figure is the SYP price as set, or the USD figure × the current rate rounded up to the merchant's step. A selling price below the merchant's purchase price is allowed and marked "أقل من سعر شرائك" in red.
- SP4. **Snapshot:** a merchant's order (POS, buy box, cart, bulk; and a panel order on their behalf) gets a `merchant_order_sales` row in the purchase transaction when its product has a selling price: the currency, unit amount, the rate in force and its USD equivalent, source `product` or `markup`. The POS confirmation may override the unit selling price for that sale (source `manual`).
- SP5. **Edit:** the merchant may set or change an order's selling price later (`PUT /api/orders/:id/sale`, with the order page in PR 2; the write path `setOrderSale` in PR 1), source `manual`; the rate stays the order's (the rate of the snapshot, or the rate in force at the order's creation when there was none). No money moves; no audit (the merchant's own bookkeeping).
- SP6. **Profit of an order** (`saleProfit`): `delivered_quantity × (unit_usd_units − unit_price_usd_units)`; refunded units count neither as a sale nor as a cost. Without a sale row, the order has no profit and is counted as "بلا سعر بيع".

### Dashboard (F30)
- DB1. Periods are today and this month in `Asia/Damascus`.
- DB2. **Sales:** the sum of `delivered_quantity × unit_usd_units` over the merchant's orders that finished delivering in the period (with a sale row), in USD with its SYP value at the current rate.
- DB3. **Spending:** the merchant's net purchases in the period, the same measure as LV2: wallet `purchase` journal debits posted in the period, minus the `refund` credits of the orders those purchases paid, whenever the refund posted (Q26, audit A06-23).
- DB4. **Estimated profit:** the sum of SP6 over the orders of DB2, with the count of delivered orders without a selling price ("n طلبات بلا سعر بيع" linking to them).
- DB5. **Balance** (the wallet), **top products** (five, by delivered units in the period, with units and sales), the **level card** (the current level, this month's net purchases, the next level and the amount missing; hidden when no level exists).
- DB6. Read live from orders and the ledger, no cache; the dashboard's query is indexed by `(customer_id, finished_at)` on orders (added if missing).

### Point of sale (F32)
- PS1. `/merchant/pos`: a game bar (followed games first, then the rest by the merchant's 30-day units), the pack grid with each pack's purchase price, selling price and availability, a player field with the recent and saved IDs of the game, and a status strip of the last 10 orders.
- PS2. **Recent IDs:** the last 20 distinct `fields` of the merchant's orders for the game in the last 90 days (by the newest order), computed on read, never stored; saved IDs (S10) above them with their labels.
- PS3. **Two taps and a confirmation:** tapping a pack with a player ID filled opens the confirmation sheet (pack, quantity for code packs, the ID with the checked name or the check's warning, purchase price, editable selling price); "تأكيد" (or Enter) places the order through `POST /api/orders` with a new `Idempotency-Key` per sheet. The player check, its confirmation for `not_found` (S09 PV7), the price check (`PRICE_CHANGED`) and every S08 rule are unchanged. PR 2: a selling price typed in the sheet is written after the order by `PUT /api/orders/:id/sale` (`manual`); the pack's own price or markup is the order's sale row otherwise (SP4).
- PS4. **Keyboard:** `/` search packs, `1`–`9` choose the n-th pack, `F2` the player field, `Enter` confirm, `Esc` close, `P` print the last receipt. Shortcuts are shown in a help sheet (`?`).
- PS5. **After paying:** the order joins the strip with its live state (S09 LT2 stream); delivered orders offer "طباعة الإيصال" and, for codes, "طباعة الأكواد".

### Bulk orders (F33)
- BK1. `/merchant/bulk`: the merchant chooses a game, then pastes lines or uploads a CSV (UTF-8, at most 50 data lines, 100 KB). A line is the game's input fields in their order (as in the buy box), then the pack, then an optional quantity (default 1), separated by commas, tabs or semicolons. The pack is matched within the game by its `game_amount` or its exact Arabic name; a downloadable template per game lists the fields and the packs.
- BK2. **Check** (`POST /api/merchant/bulk/check`): parses and validates every line (fields by the game's rules, the pack available on the merchant's list, quantity within QT1), runs the store-wide player check for each distinct ID (S19 PC rules, cache first), and returns per line: the product, unit price, total, the check result and errors. Supplier calls count against the merchant quota (BK4). Nothing is written but the checks' cache.
- BK3. **Pay:** the store sends the checked lines to `POST /api/checkouts` (S10) with `source: bulk` and per line `expectedUnitPriceUsdUnits` and `confirmPlayer` (true only for lines the merchant ticked after a `not_found` or unchecked result; decision 5). The checkout is all or nothing (S10 CT3, `CHECKOUT_REFUSED` with each line's code), one journal, up to 50 lines for a merchant; a line's quantity follows QT1.
- BK4. **Merchant player-check quota:** `merchant_settings.player_checks_per_hour` and `_per_day` (100 and 300) replace S09's 10 and 30 for merchants, for every check (bulk, POS, buy box); the per-IP limit for a merchant's request is the same hourly number; the supplier's daily quota (S09) still caps everything. Over the quota: `PLAYER_CHECK_QUOTA_EXCEEDED` with `retryAt`, and the line shows "لم يُفحص" (payable with confirmation).
- BK5. **Following:** after paying, the store opens `/orders?checkout=<id>` (S10 CT6) with each line's live state; the bulk page keeps the last 10 bulk checkouts.

### Quantity and codes (F34)
- QT1. A merchant's order of a `code` product may carry up to `MERCHANT_CODE_QUANTITY_MAX` (50) units whatever the product's `max_quantity`; direct top-ups and customers keep the product's `max_quantity` (decision 6).
- QT2. A merchant's cart line follows QT1 as well.
- QT3. **Routing:** a route whose supplier offer has a `max_quantity` below the order's undelivered quantity is not eligible (for every order: the contracts' `orderCandidates` skips it as `quantity_above_offer`, for the worker's routing and the admin's reroute alike). When no route is eligible for the quantity, the order follows S08 R-rules for no route (refund).
- CR1. **Release:** `POST /api/orders/:id/codes/release` (the order's merchant, delivered codes only, `CODES_NOT_DELIVERED` otherwise) with `purpose` (`print`, `copy`, `export`) and optional `codeIds` (default all delivered codes) returns the codes in clear with `no-store`, and writes one `order_code_reveals` row per code with the purpose, IP and user agent (decision 6); the rows of one release share a `release_id`, so the log shows each release once (PR 2).
- CR2. **Export:** `purpose: export` answers an `.xlsx` (exceljs, RTL, cells as text never formulas) with the order number, pack, position, code and redemption steps; the file name carries the order number only.
- CR3. **Rate:** releases count against S08's reveal limit raised for merchants to 20 releases per 10 minutes (each release up to 50 codes).
- CR4. The order page shows "سجل الكشف والطباعة" (each release: purpose, time, codes); the panel's order page shows the same with IP and user agent (S08).

### Printing
- PR1. **Print pages** in the store, printed by the browser: `/orders/[id]/print?paper=58|80|a4&content=receipt|codes` and the price list and statement print pages. Thermal pages use `@page { size: 58mm auto }` (or 80 mm), black text, no backgrounds, the logo in grayscale; A4 pages fit portrait A4 with margins.
- PR2. The receipt print shows: the shop name (merchant) or VERTEX DIGITAL, the WhatsApp number when shown, the logo when set, the order number and date, game and pack, quantity delivered, the masked player ID, the state, the selling price (merchant, when set; never the price paid) or the retail price for a retail order, and the verification QR (VF1).
- PR3. The codes print shows one block per code: pack name, the code (large, monospace), the redemption steps (`redemption_ar`), and the order number; a cut line between codes on thermal paper. Opening the page requests a release with `purpose: print` (CR1); reprinting releases again (logged).

### Verification and branded receipt (F35)
- VF1. Every order has a `verification_code` (PR 2: written at insert by the database's `order_verification_code()` from two `gen_random_uuid()`, 22 base64url characters with at least 122 random bits, since the database has no pgcrypto; the default backfills existing orders and keeps the release before writing orders). Every receipt surface carries a QR of `https://digital.vertexmedia.pro/v/<code>`: printed receipts, the public receipt page (`/r/<token>`), the order page (customer). The share image (OG) has none.
- VF2. **Verification page** `/v/<code>`, public: "طلب حقيقي" with the order number, game, pack, quantity ordered and delivered, the state in plain words (تم التسليم، تم تسليم جزء، قيد التنفيذ، لم يتم، مسترد), the delivery time, and the masked player ID (S10 `maskFieldValue`); never a price, a code, a name, an email, a phone, gift text or the customer's identity. For a merchant's order the shop's trade name is first and "تم التحقق عبر VERTEX DIGITAL" small below it (decision 12); otherwise the store's name. No buy links or sign-up prompts on the page beyond the header logo.
- VF3. An unknown code answers one neutral page ("لم نعثر على هذا الطلب") with `404` (PR 2: the store renders it inside its streaming boundary, so the page itself answers 200, as the S10 share pages do; it is `noindex`); the API answers `NOT_FOUND` with no timing difference that depends on the code's prefix (indexed lookup by the full code).
- BR1. **Branded receipt:** for a merchant's order the receipt (print page and the S10 receipt link) uses the merchant's branding by default: trade name, WhatsApp when shown, logo; the S10 link option `showPrice` shows the **selling price** of `merchant_order_sales` (in the sale's currency) and never the price paid (S20's privacy rule holds); without a sale row the price is hidden.
- BR2. S10 `PUT /api/orders/:id/receipt-link` gains `branded` (merchants only, default true); an unbranded merchant receipt shows the store's name and no price. PR 2: kept on the link as `order_share_links.branded` (false for every other order); a merchant's order is one placed while the customer's merchant profile was granted and not revoked.
- BR3. The trade name is `merchant_profiles.trade_name` (admin-approved); the merchant changes the WhatsApp, its visibility and the logo; the admin may remove a logo (re-authentication, reason, audited). PR 2: an uploaded logo is the merchant's logo at once (the receipt settings are its only owner record); the merchant removes it by saving without it.

### Price list (F36)
- PL1. `/merchant/price-list`: the merchant picks games (default: followed games, else all), prices (`selling`: their selling prices, default; `purchase`: their own list prices, with a note "هذه أسعار شرائك"), currency (SYP default, USD, both), and whether to list unavailable packs ("غير متوفر").
- PL2. The document: shop name and logo, "قائمة الأسعار" with the date and time (Damascus) and "الأسعار قابلة للتغيير", packs grouped by game in the store's order, each with its price; packs without a selling price in `selling` mode are omitted with a count shown to the merchant only (not printed).
- PL3. Outputs: the print page (A4, PR1) and a PNG (`GET /api/merchant/price-list.png`, 1080 px wide, rendered by the api with sharp and Pango like the share image, at most 60 rows per image, `page` for more), `no-store`, 20 per hour.

### Alerts (F37)
- AL1. **Follows:** games or products, at most 200; the follows page suggests the products the merchant bought in the last 30 days and the games of their followed products.
- AL2. **Hourly job** (`merchants.watch-alerts`, at minute 5 of each hour): for every merchant with follows, for each followed product (a followed game means all its active products), reads the merchant's current list price and availability, compares with `merchant_watch_states`, and for each difference writes a `merchant_alert_events` row: `price_down` or `price_up` (any change in USD units), `back_in_stock`, `out_of_stock` (availability `available` against anything else; hidden products are ignored). First sight of a product writes the state without an event.
- AL3. One `merchant_watch_digest` notification per merchant per run when there are events (center and push, decision 11): "تغيّرت أسعار 3 باقات وعادت باقتان للتوفر" with up to five lines in the center; dedupe key `watch-digest:<customer>:<hour>`.
- AL4. **Daily email** (`merchants.daily-digest`, 09:00 Damascus) for merchants with `daily_email` on and events in the last 24 hours: the list of events. Off by default.
- AL5. **Low balance:** after a merchant's purchase or checkout commits, when the balance is below `low_balance_usd_units` and `low_balance_alerted_at` is null, send `merchant_low_balance` (center, email, push) with the balance and set `low_balance_alerted_at`, in the same transaction as the purchase (the notification outbox of S15/F27).
- AL6. `low_balance_alerted_at` is cleared when a deposit is credited or a refund or adjustment posts and leaves the balance at or above the threshold, and by the hourly job when it finds the balance at or above it; changing the threshold clears it. PR 1: the next purchase reads the wallet's running balance after its posting position at the alert (`low_balance_alerted_position`, migration 0085), so a credit that reached the threshold re-arms the alert whichever path posted it (`checkLowBalance`), and the hourly job clears it as well.
- AL7. Store revalidation and the retail customers' F42 alerts are not affected.

### Statement (F38)
- ST1. `/merchant/statements`: the months from the account's creation to this month; any past month and this month to date (decision 4). Months are `Asia/Damascus` calendar months.
- ST2. **Content:** the shop name, the account email, the month, the opening balance (the wallet balance at the start of the month), every wallet entry of the month in time order (deposits with method, reference, SYP amount and rate; purchases with order number, pack, quantity and the full player ID; checkouts with their orders; refunds with their order; adjustments with their customer-visible note), totals per kind, and the closing balance. Opening + the sum of entries = closing (checked; a mismatch fails the request and alerts the admin, A13). PR 3: a month is cut in write order (`position`), as every running balance is: it starts at the first wallet posting whose journal began in the month and ends before the first whose journal began after it, so a purchase that began before midnight and spent a deposit written after it falls in the later month; the closing is the balance after the last entry, read on its own.
- ST3. Outputs: the page with print (A4, PR1) and an `.xlsx` (sheets "الملخص" and "الحركات"; RTL; amounts in USD with two decimals; cells as text or numbers, never formulas); the file name carries the month only.
- ST4. **Monthly email** (`merchants.statement-emails`, the 1st at 08:00 Damascus): `merchant_statement_ready` with a link to last month's statement, for merchants with at least one entry that month; dedupe key `statement:<customer>:<month>`; respects the preference switch.

### Volume levels (F39)
- LV1. Levels are set in the panel: name, monthly threshold (whole dollars), price list (wholesale or a custom list). None exist until the admin creates one (decision 8); at most 10 live, thresholds distinct.
- LV2. **Monthly purchases** of a merchant for a month: wallet `purchase` debits posted in that Damascus month, minus the `refund` credits of the orders those purchases paid, whenever the refund posted (owner, 2026-10-27, Q26, audit A06-23: a refund counts against the month its order was paid in, so orders bought to fail at a month's end never keep that month's level). Orders on behalf from the panel count; owner-funded orders do not, they never touch the wallet.
- LV3. **Level** = `levelFor(levels, previous month, this month)`: the highest live level whose threshold is at most the larger of the two (decision 2). So a merchant is upgraded within the month as soon as this month reaches a threshold, and on the 1st keeps the level the previous month earned; a refund that lowers both below the threshold lowers the level.
- LV4. **Recomputation** (`merchants.level`, one job per merchant, singleton key `level:<customer>`): queued after a merchant's purchase, checkout or refund commits; by the monthly cron (the 1st, 00:10 Damascus) for every merchant; and after any level change in the panel. In one transaction with the customer `FOR UPDATE`: compute LV3; when it differs from `level_id`, write `level_id`, `level_changed_at`, the audit entry (system actor), and when the effective list changes, S20 AT3 (cancel reservations, `price_list_changed`), plus `merchant_level_changed` (center, email, push: the level's name and the price kind, never the list's name). Running it twice is a no-op.
- LV5. **Effective list** (amends S20 AT1, ADR 0035): the list assigned to the account (`customers.price_list_id`), else the level's list for a merchant with a level, else the type default. A merchant on an assigned list keeps their level (shown on the dashboard) but pays the assigned list (decision 2).
- LV6. Archiving a level, or changing its threshold or list, requeues every merchant's recomputation; a list used by a live level cannot be archived (S20 LS5 extended).
- LV7. Revocation (S20 MA7) clears `level_id`; a re-grant recomputes it.

## Money flows
None new. A POS or buy-box purchase posts S08 M1; a bulk payment is an S10 checkout (one `purchase` journal, `checkout:<id>:purchase`); refunds, partial refunds and cost of goods are unchanged. Selling prices, sale rows, levels, alerts, releases, printing, statements and verification move no money. A level change that changes the effective list cancels unpaid reservations only (S20 AT3). The statement reads the ledger (S02) and never writes it.

## API
| Method and path | Access | Request | Response | Error codes |
|---|---|---|---|---|
| `GET /api/merchant/dashboard` | Merchant | `period` (`today`, `month`) | `merchantDashboardSchema` | `NOT_MERCHANT` |
| `GET /api/merchant/selling-settings` · `PUT` | Merchant · not frozen | — · `sellingSettingsSchema` | the settings | `NOT_MERCHANT`, `ACCOUNT_FROZEN`, `VALIDATION_FAILED` |
| `GET /api/merchant/games` (PR 1) | Merchant | — | the store's games for the merchant pickers | `NOT_MERCHANT` |
| `GET /api/merchant/selling-prices` | Merchant | `gameId` | per product: purchase price, availability, own price, selling price USD and SYP, source, below-cost flag | `NOT_MERCHANT`, `NOT_FOUND` |
| `PUT /api/merchant/selling-prices/:productId` · `DELETE` | Merchant, not frozen | `sellingPriceInputSchema` · — | the product's row | `NOT_FOUND`, `VALIDATION_FAILED` |
| `PUT /api/orders/:id/sale` (PR 2) | Merchant (own order) | `sellingPriceInputSchema` (`{ currency, amountUnits }`) | the sale | `NOT_FOUND`, `NOT_MERCHANT`, `VALIDATION_FAILED` |
| `GET /api/merchant/recent-players` | Merchant | `gameId` | up to 20 `{ fields, playerName?, lastUsedAt }` | `NOT_MERCHANT` |
| `POST /api/merchant/bulk/check` | Merchant, not frozen, terms; 30 / hour | `bulkCheckRequestSchema` (`gameId`, `text` or parsed lines) | `bulkCheckResultSchema` | `BULK_LINES_INVALID`, `PLAYER_CHECK_QUOTA_EXCEEDED`, `MERCHANT_TERMS_REQUIRED`, `ACCOUNT_FROZEN` |
| `POST /api/checkouts` (S10, extended) | Customer, `Idempotency-Key` | adds `source`; 50 lines for merchants | as S10 | as S10 |
| `POST /api/orders/:id/codes/release` | Merchant (own order), `no-store`, 20 / 10 min | `codeReleaseRequestSchema` | codes in clear, or the `.xlsx` for `export` | `CODES_NOT_DELIVERED`, `NOT_FOUND`, `RATE_LIMITED` |
| `GET /api/orders/:id/print` | Customer (own order), `no-store` | — | `orderPrintSchema`: receipt fields, branding, selling price, verification URL | `NOT_FOUND` |
| `GET /api/verify/:code` | Public, 60 / minute per IP, cached 30 s | — | `publicVerificationSchema` | `NOT_FOUND` |
| `PUT /api/orders/:id/receipt-link` (S10, extended) | Customer | adds `branded` (merchants) | as S10 | as S10 |
| `GET /api/merchant/receipt-settings` · `PUT` | Merchant · not frozen | — · `receiptSettingsSchema` | the settings | `VALIDATION_FAILED` |
| `POST /api/merchant/logo` | Merchant, multipart, 10 / hour | `file` | `{ fileId }` | `IMAGE_INVALID`, `PAYLOAD_TOO_LARGE`, `RATE_LIMITED` |
| `GET /api/merchant/logo/:fileId` | Merchant (own), admin; public through a branded share | — | the image | `NOT_FOUND` |
| `GET /api/merchant/watches` · `PUT` | Merchant · not frozen | — · `watchesSchema` | follows and suggestions | `WATCHES_LIMIT_REACHED` |
| `GET /api/merchant/alerts` | Merchant | cursor | `merchant_alert_events` of the last 90 days | — |
| `GET /api/merchant/alert-settings` · `PUT` | Merchant · not frozen | — · `alertSettingsSchema` | the settings | `VALIDATION_FAILED` |
| `GET /api/merchant/price-list` | Merchant, `no-store` | `priceListQuerySchema` | rows for the print page | `NOT_MERCHANT` |
| `GET /api/merchant/price-list.png` | Merchant, `no-store`, 20 / hour | `priceListQuerySchema`, `page` | PNG | `RATE_LIMITED` |
| `GET /api/merchant/statements` | Merchant | — | the months available | — |
| `GET /api/merchant/statements/:month` · `/:month/export` | Merchant, `no-store`; export 20 / hour | `YYYY-MM` | `statementSchema` · `.xlsx` | `STATEMENT_MONTH_INVALID` |
| `GET /api/admin/merchant-levels` | Admin | — | levels with merchant counts | — |
| `POST /api/admin/merchant-levels` · `PATCH /:id` · `POST /:id/archive` | Admin, re-authentication | `merchantLevelInputSchema` | the level | `MERCHANT_LEVELS_LIMIT_REACHED`, `MERCHANT_LEVEL_THRESHOLD_TAKEN`, `PRICE_LIST_ARCHIVED`, `VALIDATION_FAILED` |
| `GET /api/admin/merchant-settings` · `PUT` (S20, extended) | Admin · re-authentication | adds the player-check quota | the settings | `VALIDATION_FAILED` |
| `DELETE /api/admin/customers/:id/merchant/logo` | Admin, re-authentication | `{ reason }` | `204` | `NOT_FOUND` |

S20's `GET /api/admin/customers/:id` and `GET /api/admin/merchants` gain the level; the admin order view (S16) gains releases with purposes.

## Jobs and integrations
- `merchants.level` (queued per merchant, singleton key; after level changes) and `merchants.level-schedule` (the 1st 00:10 Damascus, queues every merchant): LV4. Idempotent by comparison.
- `merchants.watch-alerts` (hourly at :05; queues are `<area>.<action>` without a hyphen): AL2, AL3, AL6; per merchant in its own transaction under a per-merchant advisory lock taken without waiting (a merchant held by another run is skipped); a second run in the same hour finds no difference.
- `merchants.daily-digest` (09:00 Damascus): AL4; at most one a day per merchant (a digest queued in the last 20 hours, under the merchant's advisory lock).
- `merchants.statement-emails` (the 1st, 08:00 Damascus): ST4.
- `orders.sweep` (S08) gains: delete `merchant_alert_events` older than 90 days.
- Email templates for `merchant_level_changed`, `merchant_daily_digest`, `merchant_low_balance`, `merchant_statement_ready`; push per S15 for the emailed events and `merchant_watch_digest`.
- Image rendering: the price list PNG with sharp and Pango in the api (as the share image). No PDF library; QR codes are drawn in the browser (`qrcode.react`, already a store dependency).
- Supplier calls: player checks only, through S19's provider and S09's cache and quotas (BK4). No new supplier, chain or payment call.

## Screens

### Store (RTL; the counter screens are tablet and desktop first, every page also works at phone width)
- PR 1: the merchant pages read their strings from their own catalog (`features/merchant-tools/messages.ar.json`), so the catalog every store page ships stays within its budget; the session's user carries `accountType` (a Better Auth field) so the account menu shows "أدوات التاجر" without another read; the notification preferences list the push-only `merchant_watch_digest`.
- **Merchant area** (`/merchant`): the dashboard (DB1–DB5) with a period switch, cards for sales, spending, estimated profit and balance, top products and the level card; the area's tabs above every page lead to the tools (owner, 2026-10-27, Q27: no separate shortcuts). DB4's count of orders without a selling price links to the selling prices page, where the cause is fixed (a filtered orders list is a follow-up). Empty state for a new merchant: "ابدأ بتحديد نسبة ربحك" linking to selling prices. The account menu gains "أدوات التاجر".
- **Selling prices** (`/merchant/prices`): the markup and SYP step at the top; per game, a card per pack with the purchase price, the selling price, its source and the below-cost warning, edited in a dialog in SYP or USD (Q27: cards, not an inline table, read better at phone width).
- **Point of sale** (`/merchant/pos`): PS1–PS5; the confirmation is a modal at every width (Q27); delivered code orders in the status strip offer "طباعة الأكواد" (PS5); loading skeletons for the grid; offline or error banner "تعذّر الاتصال" with retry and no buy action.
- **Bulk** (`/merchant/bulk`): game select, a text area and a CSV upload with the template link, "فحص" then a list of lines (Q27: a list, not a table; state color, product, ID and name, the unit price and the line's total, errors, a "تأكيد المعرّف" tick for unchecked or not-found lines), the total against the balance with the S10 shortfall line, and "ادفع الكل" naming the total, disabled while the balance is short. Invalid lines block paying until fixed or removed. The template lists every pack of the game.
- **Order page** (S08, extended): for merchants "طباعة الإيصال" (58, 80 mm, A4), for code orders "طباعة الأكواد", "نسخ الأكواد", "تصدير Excel", the selling price (editable), and the release log. Every order shows its verification QR in the receipt section.
- **Print pages** (`/orders/[id]/print`, `/merchant/price-list/print`, `/merchant/statements/[month]/print`): no header or footer; an on-screen bar with "طباعة / حفظ PDF" and the paper choice, hidden when printing.
- **Verification** (`/v/[code]`): VF2, phone first, server-rendered, `noindex`.
- **Receipt settings** (`/merchant/receipt`): the trade name (read-only with "اطلب تعديلاً" opening a ticket), WhatsApp and its switch, logo upload, and a live preview of the 58 mm receipt.
- **Price list** (`/merchant/price-list`): PL1 options, the preview, "طباعة / حفظ PDF" and "تنزيل صورة".
- **Alerts** (`/merchant/alerts`): follows (games with search; products from the suggestions with "متابعة", and unfollowed from their list; Q27), the low-balance threshold, the daily email switch, and the last 90 days of events.
- **Statements** (`/merchant/statements`): the months list; a month page with the summary, entries, "طباعة / حفظ PDF" and "تنزيل Excel".

### Admin
- **Levels** (`/merchants/levels`): the levels table (name, threshold, list, merchants on it), create, edit, archive; a note that a level's list must be wholesale or a custom list.
- **Merchant settings** (`/settings/merchants`): adds the player-check quota.
- **Customer profile** (S12/S20, extended): the merchant's level and since when, this month's and last month's purchases, the branding (logo preview with "حذف الشعار"), and the follows count.
- **Merchants** (`/merchants`): a level column and filter.
- **Order** (S16): code releases with purpose, time, IP and user agent.

## Audit and notifications
- Audit (in the transaction of the change): `merchant_level.created`, `merchant_level.updated`, `merchant_level.archived` (before and after), `merchant.level_changed` (system actor: old and new level, the months' purchases, whether the list changed), `merchant.logo_removed` (reason), `merchant_settings.changed` (gains the quota). Code releases are logged in `order_code_reveals`, not the audit log (as reveals). The merchant's own preferences (selling prices, follows, alert and receipt settings) are not audited.
- Customer notifications (with templates and preference switches, on by default): `merchant_level_changed` (center, email, push), `merchant_watch_digest` (center, push), `merchant_daily_digest` (email, only when turned on in the alert settings), `merchant_low_balance` (center, email, push), `merchant_statement_ready` (center, email). Emails never carry codes, player IDs or the list's name.
- Telegram: none new; the daily summary (S05) adds "مستويات التجار: n تغيّرت اليوم" when non-zero.

## Abuse and fraud
| Abuse | Control |
|---|---|
| A stolen merchant session mass-exporting codes | Releases only for the order's merchant and delivered codes, 20 releases per 10 minutes, each code release logged with purpose, IP and user agent, visible to the merchant and the admin; the S12 freeze stops the account |
| Guessing verification codes to scrape orders | 128-bit random codes, 60 lookups a minute per IP plus nginx limits, no personal data, no price, no code on the page, `noindex` |
| The verification page used to learn a merchant's supplier prices | It never shows a price; the branded receipt shows only the selling price |
| A merchant's receipt showing the wholesale price to their customer | BR1: the price paid is never rendered on a merchant receipt; S20's privacy tests extended to print and verification |
| Bulk checks used as a free player-name lookup | Merchant quota 100 an hour and 300 a day, the per-IP limit, the supplier's daily quota, the S09 cache; merchants are admin-approved accounts |
| Bulk payment double-submitted | S10's `Idempotency-Key` and the checkout's single journal |
| A bulk line changed between check and pay | The checkout re-checks every line (S10 CT3) with `expectedUnitPriceUsdUnits`; any refusal refuses all |
| Reaching a level with purchases then refunds | Levels use net purchases (LV2); a refund lowers the level at the next recomputation |
| Reaching a level by buying codes to resell | Real purchases at a real margin; the level's list keeps every guard of S20 (never below cost plus its minimum margin) |
| A malicious or misleading logo on a public receipt link | Only admin-approved merchants; re-encoded image; the receipt always carries the verification QR and our domain; the admin can remove the logo (audited); the trade name is the admin-approved one |
| A WhatsApp number used for scams on our domain | The number is the merchant's own, shown only on their own receipts; the admin sees it on the profile and can revoke the merchant |
| A formula injection in the statement or codes Excel | Cells written as values, text never starting with `=`, `+`, `-`, `@` unescaped (as S13 X rules) |
| A CSV upload attack | Parsed as text in the API (100 KB, 50 lines), never stored, fields validated by the game's rules |
| Large PNG renders as denial of service | 20 per hour per merchant, 60 rows per image, server render time limit |
| Alerts flooding a merchant | One digest an hour at most (decision 11), at most 200 follows |
| A merchant order above a supplier's per-order limit | QT3: such routes are not eligible; no route means the S08 refund path, never a silent partial send |

## Edge cases
1. A merchant on an assigned list reaches a level: the level is recorded and shown; prices stay on the assigned list (LV5); no reservation is cancelled.
2. The admin creates the first level with a threshold the merchant already passed last month: the recomputation after the change upgrades them at once.
3. A level's list is archived: refused while a live level names it (LV6).
4. A level is archived: its merchants recompute to the next lower level or none (wholesale).
5. On the 1st, a merchant who earned gold last month buys nothing yet: still gold (LV3 takes the larger month).
6. A refund posted on the 2nd for an order paid in the previous month lowers the previous month's net purchases (LV2, Q26), and the recomputation the refund queues may lower the level at once; this month is unchanged by it.
7. A SYP selling price after a large rate change: the SYP price is kept; its USD equivalent at purchase uses the rate in force then; the dashboard may show a lower profit or a loss, marked red.
8. A product without a selling price bought at the POS: the confirmation sheet's selling price field is empty; the merchant may type one (manual), else the order has no sale row.
9. Bulk: the same player ID on several lines: checked once; each line is its own order.
10. Bulk: a line's product becomes unavailable between check and pay: the checkout refuses all with that line marked (S10 CT6); the merchant removes it and pays again.
11. Bulk: the balance covers only part: refused with the shortfall (S10 CT4); no partial payment (decision 5).
12. A 50-code order partly delivered: only delivered codes can be released; the refunded units follow S08.
13. Printing a receipt before delivery: allowed; it shows the state at print time; the QR shows the live state.
14. A gift order's verification page: shows the order facts only, never the sender, message or recipient.
15. A walk-in or owner-funded admin order: has a verification code like every order; the page shows the store's name.
16. A revoked merchant: the merchant area answers `NOT_MERCHANT`; earlier branded receipt links keep showing the branding (they are past receipts) until the customer or the admin revokes the link; their codes stay revealable singly (S08).
17. The low-balance threshold set while the balance is already below it: the next purchase sends the alert.
18. A followed product archived from the catalog: dropped from the hourly comparison; the follow is deleted by the job.
19. A statement for a month with no entries: shown with equal opening and closing balances; no email for it.
20. A statement for the current month: "حتى تاريخه" with the time it was generated; never emailed.
21. The checkouts `line_count` check widened: a customer still cannot send more than 10 lines (the API refuses with `VALIDATION_FAILED`).
22. Saved IDs above the customer limits after a revocation: kept, no new ones until under the limits.
23. A test merchant: everything works; levels compute on their purchases; their accounts stay out of reports (S13).

## Open questions
None blocking. The defaults listed after the owner decisions (player-check quota, SYP steps, limits) are the spec's choices and editable.

## Acceptance
- End-to-end check (fake supplier, test data, `pnpm db:seed-local`; a merchant approved as in S20):
  1. As the merchant, open "أدوات التاجر": the dashboard asks for a markup. Set 10% and the SYP step 500; set 60 UC to 15,000 SYP. The selling prices page shows both, with sources.
  2. Open the POS on PUBG Mobile: pick a recent ID, press `2` then Enter: the order is placed, appears in the strip and is delivered; print the 58 mm receipt: it shows the shop name, the selling price (not the purchase price) and a QR; scan it (open `/v/<code>`): the shop name, "تم التحقق عبر VERTEX DIGITAL", delivered, masked ID, no price.
  3. Buy 30 codes of a code pack: allowed (a customer is limited by the product). Print the codes on 80 mm, copy them, export Excel; the order's release log shows three releases; the panel's order shows them with IP.
  4. Bulk: paste 12 lines including one unknown ID (scripted with the fake supplier) and one unknown pack: the check marks both; fix the pack, tick the ID's confirmation, pay: one wallet entry, 12 orders followed live.
  5. Set a low-balance threshold above the balance after the next purchase: one alert arrives (center, email log, push); a second purchase sends none; deposit to above the threshold and buy below it again: a new alert.
  6. Follow PUBG Mobile; script a cost change with `supplier:fake --cost` and `--stock … off`: within the hour's job (run it by hand) one digest lists the price change and the out-of-stock pack.
  7. In the panel, create a level "فضي" at $50 with a custom list at 4%: the merchant (who spent more than $50 this month) is upgraded at once, gets the email, and the game page shows the new prices; assign them the cost list: prices follow the assigned list while the dashboard still shows "فضي".
  8. Print the price list of PUBG Mobile in SYP and download its PNG; the statement of this month shows opening balance, every entry and the closing balance, prints, and its Excel opens with RTL sheets; run the statement email job for last month: an email with the link.
- Tests:
  - Unit (contracts, 100%): `sellingPrice` (product SYP and USD, markup, rounding up, steps, none), `saleProfit` (partial delivery, refunds, no sale), `levelFor` (empty, ties, larger month, archived), `effectiveListId` (assigned, level, default), `parseBulkLines` (separators, quoting, multi-field games, quantity, errors), `damascusMonth`, the schemas.
  - db: migration backfill (verification codes unique for every order, reveal purpose, checkout source), the guards (`orders_guard` on `verification_code`, append-only alert events), the level recomputation in parallel with a purchase (serialized on the customer), the sale row written in the purchase and checkout transactions, QT3 routing with an offer limit.
  - API: every endpoint's success, 401, `NOT_MERCHANT` for customers, 403 across customer and admin, other merchants' orders and files (`NOT_FOUND`); releases (purpose, logs, limit, undelivered); the bulk check quota and its 429; the checkout with 50 lines for a merchant and 11 refused for a customer; QT1 for merchants and customers; verification (no personal data, no price, unknown code, rate limit); BR1 never rendering the price paid; the statement's balance equation; the jobs twice (levels, alerts, digests, statement emails).
  - E2E and RTL screenshots: dashboard, selling prices, POS (grid, confirmation, keyboard), bulk (check table with errors), order print pages (58, 80, A4), verification page, receipt settings preview, price list preview, alerts, statement month page, the panel's levels page and the profile's merchant card.
- Delivery plan (three PRs):
  - PR 1 **Merchant core** (F31, F30, F37, F39): selling settings, prices and the sale row, the dashboard, follows and alerts (jobs, notifications), levels (table, panel page, recomputation, the effective list change), the merchant area's shell in the store.
  - PR 2 **Counter tools** (F32, F33, F34, F35): POS, recent IDs and merchant saved-ID limits, bulk check and 50-line checkouts, the merchant player-check quota, QT1–QT3, code releases and print pages, verification codes and page, receipt settings, logo and the branded receipt.
  - PR 3 **Documents** (F36, F38): the price list (print page and PNG) and the statement (page, print, Excel, monthly email).
