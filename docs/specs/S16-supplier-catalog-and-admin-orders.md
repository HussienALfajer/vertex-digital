# S16 — Supplier catalog and admin orders

Status: Approved · Date: 2026-10-12 · Scope: `docs/product/v1-scope.md` §F08, §F09, §F11 (amended by the owner on 2026-10-12) · ADRs: 0003, 0004, 0005, 0011, 0016, 0020, 0021, 0022, 0023, 0025, 0026, 0027, 0030

## Summary
Three gaps showed once the WDGZone adapter (PR #74) met its real catalog. First, a re-send of an attempt's key can meet a refusal (`INSUFFICIENT_BALANCE`, `OUT_OF_STOCK`) even though the first send may have bought the order (Q18); S16 makes every refusal of a re-send an unknown outcome, so it waits for the admin instead of buying again elsewhere. Second, the owner sells to people outside the store, gifts and compensates customers, and buys for customers who ask: S16 adds purchases from the panel in three modes, paid from a customer's wallet or from the owner's own funds, booked as **owner drawings** with a daily cap. Third, WDGZone lists about 9,600 offers under 3,500 categories, which the S07 offers table cannot turn into a store: S16 adds a supplier catalog browser (the category tree with images, counts and a state per category), imports a category as a new game through a customization dialog or links it to an existing one, stores the supplier's image as the cover, "activate all", ignoring, a notice when an imported category gets new packs, and shows every supplier field (stock with a low-stock alert, original price and discount, field labels, ids, the supplier's wallet transactions and order history matched to our attempts, platform status).

## In scope / out of scope
- In:
  - The re-send safety net (rules RS1–RS4) for every supplier; Q18 resolved by it.
  - Admin purchases (rules AP1–AP15): walk-in (no customer, owner's funds), on behalf of a customer (the customer's wallet), gift or compensation to a customer (owner's funds); the `owner_drawings` account; the owner daily cap on the order policy; admin player checks; the customer's view and notification; Telegram notices; reports, dashboard and reconciliation updated for owner-funded orders.
  - Supplier categories: read by the sync (capability `categories`), the tree browser with states, ignore and unignore (categories and single offers), import as a new game, link to an existing game, unlink, "activate all" on a game, the new-packs badge and daily summary line (rules SC1–SC14).
  - Supplier images: shown in the panel through the API, downloaded and re-encoded into the game cover on import, restorable after a manual replacement (rules IM1–IM3).
  - Supplier fields: stock, original price and discount, field labels, types and options, supplier ids, the low-stock alert, the supplier statement (wallet transactions and order history matched to attempts), nearby supplier orders for a held attempt, the platform status and catalog update time (rules SF1–SF6).
  - The `wdgzone` and `fake` adapters gain the categories, statement and platform status capabilities and report stock, original price and field specs.
  - PR4: offers with two fields or a select field (rules MF1–MF3), and the delivery-reply fixes WDG's answer to Q19 showed (MF4); Q19 answered on 2026-10-13.
- Out (later or never):
  - FazerCards as a third supplier (owner, 2026-10-12).
  - WDG's `manual` products (about 64,500, delivered by hand at WDG): left out, as the adapter does today (owner, 2026-10-12).
  - SHOP2TOPUP's catalog browser: its adapter is not built (Q12); the browser works for any supplier whose adapter declares `categories`, and says "هذا المورد لا يعرض فئات" otherwise.
  - A cart, reservations (`awaiting_balance`) or several products in one admin purchase: one product per admin order.
  - Settling owner drawings: they are a running total of what the owner took in goods, never paid back (ADR 0030).
  - Recording the money a walk-in buyer hands the owner: it stays outside the books (ADR 0030).
  - Storing the supplier statement: it is read live and never copied into the database.
  - Product images on the store: products have none (S06); only the game cover comes from the supplier.

## Access
| Action | Route kind | Who |
|---|---|---|
| Place an admin order (any mode) | Admin, re-authentication, `Idempotency-Key`, rate limited | The admin |
| Read the purchase context (customer summary, saved IDs, owner cap left); run a player check | Admin, rate limited (checks) | The admin |
| Change the owner daily cap (order policy) | Admin, re-authentication | The admin |
| Read the category tree, offers, images, the statement, the platform status, nearby supplier orders | Admin, rate limited (images, statement) | The admin |
| Import a category, link, unlink, ignore, unignore (categories and offers), "activate all", restore the supplier image | Admin | The admin |
| See own orders placed by the store, reveal their codes | Customer | The order's customer |
| Category sync, stock alerts, the re-send rule | Worker jobs | System |

A customer never reaches the admin purchase routes; the store's order routes still take no customer id and answer `NOT_FOUND` for another customer's order, and walk-in orders have no customer at all.

## Data
Business tables have `id` (UUIDv7), `created_at`, `updated_at`; append-only tables have no update or delete grant for the app role (ADR 0014). Money is USD units (micro-dollars, ADR 0003). Supplier text is stored and rendered as plain text, length-bounded.

### Contracts (`orders.ts`, `suppliers.ts`, `catalog.ts`, `wallet.ts`, `notifications.ts`, `telegram.ts`, `audit.ts`, `errors.ts`, `reports.ts`, `reconciliation.ts` extended)
- `ORDER_PAYERS` (`customer`, `owner`); `ORDER_PLACERS` (`customer`, `admin`); `ADMIN_ORDER_PURPOSES` (`walk_in`, `on_behalf`, `gift`, `compensation`) and `adminOrderShape(purpose)`: `walk_in` → payer `owner`, no customer; `on_behalf` → payer `customer`, a customer; `gift`, `compensation` → payer `owner`, a customer.
- `LEDGER_ACCOUNT_KINDS` gains `owner_drawings` (the value the owner took in goods, at store prices, net of refunds; ADR 0030). `heldUnits` shows −balance as "أخذه المالك بضاعةً".
- `ORDER_POLICY` gains `ownerDailyCapUsdUnits` (whole cents, $0–$10,000, default $100; owner, 2026-10-12); `ownerCapRemaining(capUnits, usedUnits)`.
- Pure functions (100% coverage): `adminOrderShape`, `ownerCapRemaining`, `categoryState(node, facts)` (rule SC5), `suggestInputFields(fieldSpecs)` (SC12), `suggestProductName(offer, leafName, spansLeaves)` and `parseGameAmount(name)` (SC13), `discountPercent(costUnits, originalUnits)` (SF1), `stockLevel(stock, inStock, thresholdUnits)` (SF2: `ok`, `low`, `out`, `unlimited`), `isResendRefusal(outcome, resend)` (RS1).
- `SupplierCapabilities` gains `categories`, `statement`, `platformStatus`. `SupplierOffer` gains `categoryId?`, `stock?` (absent when unlimited or not reported), `originalCost?`, `fieldSpecs?` (`{ key, label, type: 'text' | 'select', options? }[]`), `unsupportedReason?` (`fields_unsupported`). New adapter methods: `listCategories()`, `listTransactions(page)`, `listOrders(page)`, `getPlatformStatus()`, each behind its capability. `PlaceOrderRequest` gains `resend: boolean` (for the call log only; the rule is the engine's, RS1).
- `SUPPLIER_CALL_OPERATIONS` gains `list_categories`, `list_transactions`, `list_orders`, `platform_status`.
- `SUPPLIER_CATEGORY_STATES` (`not_imported`, `linked`, `new_packs`, `ignored`); `STOCK_LEVELS`; `SUPPLIER_POLICY` gains `lowStockUnits` (1–1,000, default 10; owner, 2026-10-12).
- Schemas: `createAdminOrderSchema`, `adminPurchaseContextSchema`, `adminPlayerCheckSchema`, `supplierCategoryNodeSchema`, `categoryListQuerySchema`, `importDraftSchema`, `importCategorySchema`, `linkCategorySchema`, `activateAllResultSchema`, `supplierTransactionSchema`, `supplierOrderSchema` (with its match), `platformStatusSchema`; `supplierOfferSchema` and `offerListQuerySchema` extended (SF1).
- Error codes: `OWNER_DAILY_CAP_EXCEEDED` (`details.remainingUsdUnits`), `OFFER_UNSUPPORTED`, `OFFER_IGNORED`, `CATEGORY_LINKED` (`details.gameId`), `CATEGORY_MISSING`, `IMAGE_FETCH_FAILED`, `CAPABILITY_UNSUPPORTED`; existing `PURCHASES_STOPPED`, `PRODUCT_UNAVAILABLE`, `PRICE_CHANGED`, `ACCOUNT_FROZEN`, `PURCHASE_LIMIT_EXCEEDED`, `INSUFFICIENT_BALANCE`, `PLAYER_NOT_CONFIRMED`, `EMAIL_NOT_VERIFIED`, `NAME_TAKEN`, `SLUG_TAKEN`, `CATALOG_LIMIT_REACHED`, `CATALOG_INCOMPLETE`, `OFFER_ALREADY_MAPPED`, `ROUTE_EXISTS`, `ROUTE_KIND_MISMATCH`, `ROUTE_FIELDS_UNMAPPED`. Each with its Arabic text.
- `NOTIFICATION_EVENTS` gains `order_placed_for_you` (`{ orderId, orderNumber, productName, purpose, customerNote? }`), with an email template and a push (S15: every emailed event pushes; lock-screen text: the order number and pack name only).
- Telegram kinds `admin_order_placed`, `supplier_stock_low`; the daily summary gains three lines (Jobs).
- Audit entity types `supplier_category`; actions in "Audit and notifications".

### `orders` (changed)
- `customer_id` becomes nullable (walk-in orders only).
- `placed_by` enum `order_placer`, default `customer`; `payer` enum `order_payer`, default `customer`; `admin_purpose` enum `admin_order_purpose` nullable; `admin_id` uuid nullable (no FK); `admin_reason` text nullable 5–500 (internal: never shown to the customer); `customer_note` text nullable 1–300 (shown to the customer; S10's gift message rule: no links, handles or phone numbers).
- Checks: `placed_by = 'admin'` ⇔ `admin_purpose`, `admin_id` and `admin_reason` set; `customer_id is null` ⇔ `admin_purpose = 'walk_in'`; `payer = 'owner'` ⇔ `admin_purpose in ('walk_in', 'gift', 'compensation')`; `customer_note` only with `gift` or `compensation`; an admin order has no checkout, no reservation and no S10 gift fields (`is_gift` false).
- Idempotency: the customer unique index becomes `(customer_id, idempotency_key) where placed_by = 'customer' and checkout_id is null`; new unique `(idempotency_key) where placed_by = 'admin'`.
- Indexes: `(payer, paid_at) where payer = 'owner'` (the daily cap, AP7), `(placed_by, created_at desc) where placed_by = 'admin'`.
- The S08 trigger's frozen columns include the new ones. `is_test` is the customer's flag, `false` for walk-in orders.

### `order_policy` (changed; append-only, newest row in force)
- Gains `owner_daily_cap_usd_units` bigint, whole cents, $0–$10,000; the migration gives the current row $100.

### `player_checks` (changed)
- `customer_id` becomes nullable and `admin_id` uuid nullable is added; exactly one is set (check). Admin checks share the cache (S09 PV3).

### Ledger accounts
- `owner_drawings:USD` (kind `owner_drawings`), created on first use by `ensureSystemAccount`.

### `supplier_categories` (new; owner `suppliers`; business table, mirror of the supplier's tree plus our link and ignore state)
- `supplier_id` FK; `category_id` text 1–64 (the supplier's id); unique `(supplier_id, category_id)`; `parent_category_id` text nullable (the supplier's parent id; no FK, so a tree read out of order still stores).
- `name` text ≤ 200; `kind` enum `product_kind` nullable (WDG `topup` → `direct`, `voucher` → `code`); `product_count`, `in_stock_count` int nullable ≥ 0 (the supplier's figures); `image_url` text nullable ≤ 500 (HTTPS on a host the adapter declares, else stored as null).
- `last_seen_at`; `missing_since` nullable (set when a successful category read no longer lists it).
- `game_id` uuid nullable FK `catalog_games`, `linked_at` nullable; `ignored_at` nullable; `state_admin_id` uuid nullable (the admin who last linked, unlinked, ignored or unignored).
- Indexes: `(supplier_id, parent_category_id)`, `(game_id)`, `(supplier_id, missing_since)`.

### `supplier_offers` (changed)
- Gains `category_id` text nullable (the supplier's leaf category id); `stock` int nullable ≥ 0 (null: unlimited or not reported; WDG's `999999` and above are stored as null); `original_cost_usd_units` bigint nullable (the supplier's price before its discount); `field_specs` jsonb nullable (at most 10 `{ key ≤ 32, label ≤ 64, type, options ≤ 50 { label ≤ 64, value ≤ 64 } }`); `unsupported_reason` text nullable (`fields_unsupported`); `ignored_at` timestamptz nullable, `ignored_admin_id` uuid nullable; `stock_alert` enum `stock_level` nullable (the last level alerted, SF2).
- Index `(supplier_id, category_id)`.

### `product_routes` and `fulfilment_attempts` (changed, PR4)
- `product_routes` gains `option_map` jsonb not null default `{}` (supplier field key → our option value → the supplier's option value; at most 10 fields of at most 50 options, values bounded as `field_specs`; MF2).
- `fulfilment_attempts` gains `option_map` jsonb nullable: the route's option map when the attempt was written, beside `field_map` (null on attempts written before it, read as `{}`).

### `supplier_policy` (changed; append-only)
- Gains `low_stock_units` int 1–1,000; the migration gives the current row 10.

## States and rules

### The re-send safety net (Q18; owner, 2026-10-12)
- RS1. A `placeOrder` call is a **re-send** when its attempt was sent before: S08 F3's re-send of an `unknown` attempt and F6's re-send of an attempt left `sending`. On a re-send, the engine applies any `failed_definitive` outcome (with or without `inputRejected`, whatever its code) as `unknown` with reason `resend_refused`, keeping the supplier's code in `supplier_code`. The attempt stays open, is re-sent on F7's schedule and, past the hard limit, waits for the admin (S08 F7, D2–D5). Only the first send of an attempt can fail it definitively. The first send is marked durably before its call (`fulfilment_attempts.send_started_at`, set once): `orders.fulfil` marks it with the attempt; an admin's reroute (S11 RR3) leaves it unmarked and its poll marks it, committed, before sending, so a reroute refused on its first send fails. A send is a re-send when the attempt is `unknown`, already marked, or unmarked but not rerouted (an attempt an older release wrote during a deploy may have been sent). The rule is the engine's (`packages/db/src/orders` and the worker), for every supplier; adapters keep classifying answers as they do.
- RS2. `supplier_calls` records the refusal as `refused` (the supplier is working), so health is unchanged.
- RS3. The admin's order page marks such an attempt "رفض المورد إعادة الإرسال: <code>" and, for a supplier with the `statement` capability, lists the supplier's nearby orders (rule SF4) so the admin can confirm delivered or failed.
- RS4. Q18 is resolved by RS1: routing real orders to WDGZone no longer waits for WDG's answer. The launch checklist's one small live order per supplier still applies, and the funded test of `docs/suppliers/wdgzone.md` open question 1 stays useful to learn how often RS1 will hold orders.

### Admin purchases (owner, 2026-10-12)
- AP1. **Modes:** `walk_in` (a buyer outside the store: no customer, the admin types the account fields, paid from the owner's funds); `on_behalf` (a registered customer asked: paid from that customer's wallet); `gift` and `compensation` (a registered customer, paid from the owner's funds).
- AP2. **Request:** `POST /api/admin/orders` with re-authentication and an `Idempotency-Key` (one per dialog opening): `{ purpose, customerId?, productId, quantity, fields, expectedUnitPriceUsdUnits, reason, customerNote?, confirmPlayer? }`. The same key and body returns the first order (`200`); another body `IDEMPOTENCY_KEY_REUSED`. Rate limit 30 admin orders per 10 minutes.
- AP3. **One transaction** as S08 O2: the switches lock shared, refused with `PURCHASES_STOPPED` while `purchases_stopped` is on (owner, 2026-10-12: the emergency stop stops the panel too); the product `FOR SHARE`; rules AP4–AP7; the order inserted `paid`; the purchase journal (rule AM1 or AM2); the `paid` event; the audit entry; the `orders.fulfil` job; the notification (AP11) and the Telegram notice (AP13). Any refusal rolls everything back.
- AP4. **Customer modes** (owner, 2026-10-12: the customer's own rules): the customer exists and is not archived (`NOT_FOUND`), has a verified email (`EMAIL_NOT_VERIFIED`) and is not frozen (`ACCOUNT_FROZEN`; for gifts too: a frozen account is under investigation). `on_behalf` also counts toward the customer's daily purchase cap (S12, `PURCHASE_LIMIT_EXCEEDED`) and takes the wallet lock and balance check of S08 M1 (`INSUFFICIENT_BALANCE`). Admin orders do not count toward the customer's own rate limits.
- AP5. **Availability:** as S08 O3 for the order's customer (a test customer's order uses test routes only, S08 R4; a walk-in order is never a test order). An owner-funded order (`walk_in`, `gift`, `compensation`) may also buy a product that is `paused` by the admin (the product or its game), when it otherwise has a current price and a usable profitable route: the owner can try a newly imported pack with one real order before activating it. `hidden`, `out_of_stock` and `paused_by_margin_guard` are refused (`PRODUCT_UNAVAILABLE`).
- AP6. **Price:** the store's current price (owner, 2026-10-12): `expectedUnitPriceUsdUnits` must equal it (`PRICE_CHANGED` with the new price); `quantity` 1 to the product's `max_quantity`; `fields` by S08 O5 (`VALIDATION_FAILED`). The margin guard applies to every attempt as for any order.
- AP7. **Owner daily cap:** the totals of owner-funded orders paid since 00:00 `Asia/Damascus` today, minus their refunded amounts, plus this order's total, must not exceed `owner_daily_cap_usd_units` ($100; owner, 2026-10-12), else `OWNER_DAILY_CAP_EXCEEDED` with the amount left. The check locks the `owner_drawings:USD` account row (`FOR UPDATE`, created first if missing) so two admin orders cannot both pass. A cap of 0 turns owner-funded orders off. Changing the cap needs re-authentication.
- AP8. **Player check:** for a `direct` product the dialog runs S09's check through `POST /api/admin/player-checks` with the admin as requester: it reads and fills the shared cache (PV3), counts toward the supplier's daily quota (PV5), has no customer or IP limits but 30 supplier calls per 10 minutes for the admin, and answers as PV6. An `invalid` answer requires `confirmPlayer` on the order (`PLAYER_NOT_CONFIRMED`), as PV8. For customer modes the dialog offers the customer's saved player IDs (S10) to fill the fields.
- AP9. **Recorded:** `placed_by = admin`, `admin_id`, `admin_purpose`, `admin_reason`, `payer`, `customer_note` (gift or compensation, optional). The SYP display total as S08 O6.
- AP10. **Fulfilment** is S08 unchanged: routing, retries, polling, holds, partial delivery and refunds. A refund of an owner-funded order returns to owner drawings (AM3), never to a wallet.
- AP11. **Customer view** (owner, 2026-10-12): an `on_behalf`, `gift` or `compensation` order appears in the customer's "طلباتي" with a chip ("أنشأه المتجر بطلبك"، "هدية من المتجر"، "تعويض من المتجر") and the customer note; `on_behalf` shows its price and a normal purchase line on the wallet timeline; `gift` and `compensation` show no price and touch no wallet. The customer reveals the codes as for any order (S08 C2) and gets `order_placed_for_you` (email, center, push) at creation; later order notifications follow S08, except that a refund of an owner-funded order says "تعذّر تنفيذ الطلب" without a wallet amount.
- AP12. **Walk-in orders** have no notifications, share links or receipts. Their codes are revealed by the admin only (S08 C3: re-authentication, audit, hidden again after 30 seconds); the order page explains it ("زبون مباشر: اكشف الكود وسلّمه").
- AP13. **Telegram:** each admin order sends `admin_order_placed` (order number, mode, pack, quantity, total, and for owner-funded orders today's total against the cap), so a stolen session shows at once. Never field values or codes.
- AP14. **Reports and dashboard** (owner, 2026-10-12): sales and profit (the dashboard, S13 R1–R5) count customer-paid orders, `on_behalf` included. Owner-funded orders are left out of the dashboard's sales and R5, and shown in R1 and R2 on their own line "طلبات من مال المالك" (count, value at price, cost, profit). R6 shows owner drawings per day. The live orders room and `/orders` show every order with its mode chip and filter by placer, payer and mode.
- AP15. **Reconciliation:** C4 allows `owner_drawings` in `purchase` and `refund` journals; C6 checks that an owner-funded order's purchase journal takes its total from `owner_drawings:USD` (and a customer-paid one from its customer's wallet); C7 checks that its refund journal credits `owner_drawings:USD`. Owner drawings have no external check.

### Supplier catalog
- SC1. **Categories:** an adapter with the `categories` capability lists the supplier's tree (`listCategories`): id, parent id, name, kind, product and in-stock counts, image URL. WDGZone: `GET /categories` (the shape in its documentation's example; paging confirmed in PR2). The fake adapter: a small tree (two games with subcategories and a gift-card category) with images.
- SC2. **Sync:** `suppliers.sync` (S07 SY) reads categories before offers in the same run, one more call. In the run's transaction it upserts `supplier_categories` by `(supplier, category id)` and sets `missing_since` on categories no longer listed. An empty or failed category read keeps the previous tree, the run goes on with offers and records `categories_skipped` on the run; categories never fail a run (S07 SY3 still governs offers).
- SC3. **Offers** carry their leaf category id, stock, original cost and field specs. Offers with more than one field or a `select` field are no longer skipped: they are stored with `unsupported_reason = fields_unsupported`, shown "غير مدعوم حتى يرد WDG", never usable by S07 RT4 and refused by import and routes (`OFFER_UNSUPPORTED`) until PR4 (Q19, answered: MF1–MF3). WDG's `manual` products stay out.
- SC4. **Tree:** roots first, children on expand, at most 200 per level per page. Per node: the image (IM1), name, kind, the supplier's product and in-stock counts, our counts (offers mapped, unmapped, ignored, unsupported), the linked game and the state. Filters: state, kind, text search on names (any depth, shown with their path).
- SC5. **State** (`categoryState`): a node's effective game is its own link or its nearest linked ancestor's; it is `ignored` when it or an ancestor is ignored; otherwise `not_imported` when it has no effective game; `new_packs` when an offer in its subtree whose leaf has an effective game is unmapped, not ignored, supported, in stock and not missing; otherwise `linked`. A missing node shows "اختفت من المورد" beside its state.
- SC6. **Ignore:** a category (its subtree leaves the default "غير مستوردة" view) or one offer (it no longer counts as new). Both reversible; audited.
- SC7. **Import as a new game** (owner, 2026-10-12: a root category is one game; any node may be imported on its own). The dialog loads a draft (`import-draft`: suggested names, catalog category, slug, fields, field map, packs with costs and price previews) and sends: the game (`nameAr`, `nameEn`, `categoryId` of the store catalog, `slug`, optional accent and region notes), the cover (`supplierImage: true` or an uploaded `coverFileId`), the input fields (S06 create rules), the field map (supplier field key → our field key), and the packs, rows `{ offerId, nameAr, gameAmount? }`, 1–100 from the node's subtree. In one transaction: the game (`paused`), its fields, the products (`paused`, S06 defaults, `max_quantity` 1 for `direct` and 10 for `code`), their enabled routes (RT1–RT3) and first prices (S07 P2: a first price applies at once), and the link (`game_id`) on the node. Refused when the node, an ancestor or a descendant is already linked to another game (`CATEGORY_LINKED`), when the node is missing (`CATEGORY_MISSING`), or when an offer is unsupported, ignored, mapped or of another kind (per-row errors, nothing created, as S07 RT8).
- SC8. **Link to an existing game:** the node, the game and a field map onto the game's existing fields (RT3), with pack rows that either add a route to an existing product (`{ offerId, productId }`, RT1–RT3; `ROUTE_EXISTS` when that product already has a route on this supplier) or create a new paused product (`{ offerId, nameAr, gameAmount? }`). The draft proposes, per pack, the existing product with the same game amount or name. Packs may be left out; they then count as new (SC5) until mapped or ignored.
- SC9. **Unlink** removes the node's link; the game, its products and routes stay. Audited.
- SC10. **"تفعيل الكل"** on a game: in one transaction sets the game `active` when CT3 allows it (else `CATALOG_INCOMPLETE`, nothing changes) and every paused, unarchived product of the game that would be `available` once resumed (a current price and a usable profitable route); the answer lists the products activated and those skipped with their reason ("لا مسار صالح"، "بانتظار مراجعة السعر"، "لا سعر"). Products the admin paused one by one are activated too: the panel's confirmation shows the count first.
- SC11. **New packs notice** (owner, 2026-10-12): the "الموردون" navigation item and the supplier card show the number of new offers (SC5); the daily summary gains a line "باقات جديدة في فئات مستوردة: 7 (WDGZone)". No immediate Telegram message.
- SC12. **Field suggestions** (`suggestInputFields`): per supplier field, our key = the supplier key lower-cased with characters outside `[a-z0-9_]` turned to `_`, prefixed `f_` when it does not start with a letter, cut to 32 and made unique; the Arabic label from a dictionary (`player_id`, `user_id`, `uid` "معرّف اللاعب"; `server_id`, `server` "السيرفر"; `zone_id` "رقم المنطقة"; `role_id` "معرّف الشخصية"; `riot_id` "Riot ID"; `region` "المنطقة"), else the supplier's label; type `digits` (1–32) for `player_id`, `user_id`, `uid`, `zone_id`, `server_id`, `role_id`, else `text` (1–64); required. A product that asks for a player id without listing a field suggests `player_id`. The admin edits everything; the field map is prefilled from the suggestion.
- SC13. **Pack names:** the supplier's pack name, with " · <leaf name>" when the chosen packs span more than one leaf and the leaf name is not already in it, cut to 60; the game amount is the first whole number in the pack name, when there is one. The admin edits both.
- SC14. **Store category:** `direct` suggests "ألعاب", `code` "بطاقات هدايا"; the English name and slug come from the root's name (slug made unique with a number).

### Supplier images
- IM1. The panel shows a category's image through `GET /api/admin/suppliers/:code/categories/:categoryId/image`: the API fetches the stored `image_url` only from the HTTPS hosts the adapter declares (`wdgzone.tech` for WDGZone), without following redirects to other hosts, at most 2 MB and 5 seconds; decodes it with the pixel limit of S06 CT10, re-encodes a WebP of at most 256 px, and answers with `Cache-Control: private, max-age=86400`. The API keeps a memory cache of 500 thumbnails. A failure answers `404` and the panel shows a placeholder. The panel never loads a supplier's host directly (its CSP is unchanged).
- IM2. On import (SC7) with `supplierImage`, the API downloads the image before the transaction under the same host rules with S06's 5 MB limit, runs CT10 (decode, strip metadata, fit within 1600 px, WebP) and stores it as a `catalog_image` that becomes the cover. A failure answers `IMAGE_FETCH_FAILED` and the dialog asks for an upload instead. The store serves only stored files.
- IM3. The cover stays replaceable with S06's upload. "استخدام صورة المورد" on a game linked to a category downloads it again by IM2 and sets it as the cover (a new file; stored files never change).

### Supplier fields
- SF1. **Offers table** (S07 "العروض", and the packs of a category): the supplier's offer id, leaf category id and path, cost, original price and discount (`⌊(original − cost) × 100 / original⌋` %, shown only when the original is known and above the cost), stock (a number, or "غير محدود"), the fields with labels, types and options, supported or the reason, the mapped product, ignored. Filters gain category (subtree), supported, ignored and low stock.
- SF2. **Low stock** (owner, 2026-10-12): an offer that an unarchived, enabled route maps to an `active` product of an `active` game is `low` when its stock is reported and below `low_stock_units` (10), and `out` when it is not in stock or its stock is 0. After each successful sync, offers whose level rose (`ok` → `low`, `ok` or `low` → `out`) since their stored `stock_alert` get one `supplier_stock_low` message per run (up to 10 named, then a count) and their `stock_alert` is set; an offer back at or above the threshold clears it, so the next drop alerts again. The panel shows "مخزون منخفض" or "نفد" on the offer, the route drawer and the game page.
- SF3. **Statement** (capability `statement`): the supplier page's "كشف الحساب" tab reads the supplier's wallet transactions and order history live, one page at a time (WDG `GET /transactions`, `GET /orders`), at most one request per 5 seconds per supplier, each recorded in `supplier_calls`. Nothing is stored. Orders are matched to our attempts by `supplier_order_id`: a matched row links to our order and shows the attempt's state; an unmatched supplier order is marked "غير مطابق لطلب عندنا" (a possible double purchase, settled with an S13 supplier correction). Transactions show their type, amount, balance after, reference and time, and link to our order when they name a matched supplier order.
- SF4. **Nearby supplier orders** for an open or held attempt with the `statement` capability: the supplier's orders for the same offer and quantity within 15 minutes of `sent_at`, each marked whether it is already matched to another attempt. Read live on the admin's request, never applied automatically.
- SF5. **Platform status** (capability `platformStatus`): the supplier card and page show the supplier's own status and catalog update time (WDG `GET /health`, no key), read by the API when the panel asks, cached 60 seconds.
- SF6. The panel reads of SF3–SF5 and the image fetches are recorded in `supplier_calls` but left out of the health window (S07 H1 counts the operations orders depend on).

### Two fields and select fields (PR4; Q19 answered by WDG support on 2026-10-13, owner decisions the same day)
- MF1. **Sending several fields** (WDG: "include them as JSON keys in the body: `{"player_id": "12345678", "zone_id": "1234"}`"; owner, 2026-10-13: JSON keys, never a delimiter). A WDG offer with one field sends it as `player_id`, as today. An offer with several fields sends every field under its own supplier key, plus `player_id` with the value of the account field: the field keyed `player_id`, else the first present of `user_id`, `uid`, `role_id`, `riot_id`, `id` (a route's field map is a JSON object whose key order is not kept, so "first" is this list, not the catalog's order). An offer with several fields and none of those keys stays unsupported (`fields_unsupported`). WDG's delimiter form (`USER_ID|ZONE_ID`, `12345678(1234)`) is never sent.
- MF2. **Select fields** (owner, 2026-10-13: the reply does not cover them; send the option's value under its field's key). A supplier `select` is sent as the supplier's option `value` (never its label), under its key, by MF1. Our select options are S06's (`value` `[a-z0-9_-]{1,32}`, 2–50 options), so the route keeps an **option map**: supplier field key → our option value → the supplier's option value. The adapter only ever receives a value from the supplier's own list. A supplier select with fewer than 2 options, or with options that do not parse, keeps the offer unsupported.
- MF3. **Import, link and routes.** Offers whose fields MF1 and MF2 can send are supported from PR4: `unsupported_reason` is cleared by the next sync, and `fields_unsupported` stays only for MF1's and MF2's leftovers. `suggestInputFields` proposes one input field per supplier field: a supplier `select` becomes our `select` with the first selected pack's options (labels kept, values sanitized as SC12 keys and made unique) and the route's option map; the admin may edit labels and remove options in the dialog. A route's option map must give a supplier value for every option of each of our select fields it maps (RT3 extended; else `fields_incomplete`), so a pack whose options for a key lack one of the field's options is refused on its row (`FIELD_OPTIONS_DIFFER`) and can be imported into another game or left out. Linking to an existing game (SC8) maps each of the game field's options to one of the supplier's (proposed by equal value or label). Route create and update (S07 RT1–RT3) accept the option map; the route drawer edits it. The attempt keeps the option map it was written with, beside its field map, so a re-send is the same request (S08 F3, F6).
- MF4. **Delivery replies** (WDG support, 2026-10-13; owner: in PR4). `delivery_items` are read as plain codes or as `{ code, pin }` objects, on the purchase reply, the poll and the webhook; a pin is kept in the same code text as `<code> · PIN: <pin>` (no pin: the code alone; owner, 2026-10-13), within S08's code limits. The poll's `200` is delivered only when its `status` is `COMPLETED` (any case) or absent; another status is `unknown`. The poll's `202` is also what WDG answers for a delivered direct top-up (no code), so a `202` is followed by `GET /orders/{id}`: `completed` is delivered without codes (S08 F1 still makes a `code` pack without codes `unknown`), `refunded`, `failed`, `cancelled` are `failed_definitive`, `pending`, `processing` stay `pending`, anything else or an unreadable reply is `unknown`. The poll's `410` (`{ data: { status, refunded: true } }`, no `error` object) keeps `data.status` (`REFUNDED`, `FAILED`, `CANCELLED`) as the supplier code.
- MF5. **Idempotency** (WDG support, 2026-10-13): the key is checked first; a repeated key answers `200` with the existing order and `idempotent_replay: true`, without checking balance or stock again or charging. A refused request is not kept under its key (seen live), so for WDG a refusal of a re-send means the first send made no order. RS1 still applies to WDG unchanged (it is the same rule for every supplier); relaxing it per supplier would be a new owner decision.

## Money flows
All USD, no rate (the SYP on an order is display only).
- AM1. **On behalf** of a customer: S08 M1 unchanged: journal `purchase`, key `order:<id>:purchase`; `customer_wallet:<customer>` **−total**, `sales_revenue:USD` **+total**; refunds S08 M3 to the wallet.
- AM2. **Owner-funded order** (`walk_in`, `gift`, `compensation`): journal `purchase`, key `order:<id>:purchase`; `owner_drawings:USD` **−total**, `sales_revenue:USD` **+total**. No balance check (a system account); the cap is AP7.
- AM3. **Refund of an owner-funded order:** journal `refund`, keys as S08 M3; `owner_drawings:USD` **+unit price × units**, `refunds:USD` **−the same**.
- AM4. Cost of goods per delivered attempt: S13 LS1 unchanged, whoever paid.
- Owner drawings are never settled by a movement; the cash a walk-in buyer gives the owner stays outside the books (ADR 0030). The catalog, images, statement and alerts move no money.

## API
Admin responses are `Cache-Control: no-store` except images (IM1). `:code` is a `supplier_code`; `:categoryId` is the supplier's category id.

| Method and path | Access | Request | Response | Error codes |
|---|---|---|---|---|
| `POST /api/admin/orders` | Admin, re-authentication, `Idempotency-Key`, 30 per 10 min | `createAdminOrderSchema` | `201` admin order detail (`200` on a replay) | `PURCHASES_STOPPED`, `PRODUCT_UNAVAILABLE`, `PRICE_CHANGED`, `VALIDATION_FAILED`, `NOT_FOUND`, `EMAIL_NOT_VERIFIED`, `ACCOUNT_FROZEN`, `PURCHASE_LIMIT_EXCEEDED`, `INSUFFICIENT_BALANCE`, `OWNER_DAILY_CAP_EXCEEDED`, `PLAYER_NOT_CONFIRMED`, `IDEMPOTENCY_KEY_REUSED`, `REAUTHENTICATION_REQUIRED`, `RATE_LIMITED` |
| `GET /api/admin/orders/purchase-context` | Admin | `customerId?` | `adminPurchaseContextSchema` (customer name, email, balance, frozen, cap left, saved IDs; owner cap, used today, left) | `NOT_FOUND` |
| `POST /api/admin/player-checks` | Admin, 30 supplier calls per 10 min | `adminPlayerCheckSchema` (`productId`, `fields`) | S09 PV6 answer | `VALIDATION_FAILED`, `RATE_LIMITED` |
| `GET /api/admin/orders` (S08) | Admin | adds `placedBy?`, `payer?`, `purpose?` | rows add mode, payer, admin | — |
| `GET` · `PUT /api/admin/orders/policy` (S08) | Admin; `PUT` re-authentication | adds `ownerDailyCapUsdUnits` | same | `REAUTHENTICATION_REQUIRED`, `VALIDATION_FAILED` |
| `GET /api/admin/orders/:id/attempts/:attemptId/supplier-orders` | Admin, 1 per 5 s per supplier | — | nearby `{ items: supplierOrderSchema[], complete }` (SF4) | `NOT_FOUND`, `CAPABILITY_UNSUPPORTED`, `SUPPLIER_UNAVAILABLE`, `RATE_LIMITED` |
| `GET /api/admin/suppliers/:code/categories` | Admin | `categoryListQuerySchema` (`parentId?`, `state?`, `kind?`, `q?`, page) | paged `supplierCategoryNodeSchema` | `CAPABILITY_UNSUPPORTED` |
| `GET /api/admin/suppliers/:code/categories/:categoryId/image` | Admin, 120 per min | — | WebP | `404` |
| `GET /api/admin/suppliers/:code/categories/:categoryId/import-draft` | Admin | `gameId?` (a link draft) | `importDraftSchema` | `NOT_FOUND`, `CATEGORY_MISSING` |
| `POST /api/admin/suppliers/:code/categories/:categoryId/import` | Admin | `importCategorySchema` | `201` `{ gameId, products }` | `CATEGORY_LINKED`, `CATEGORY_MISSING`, `IMAGE_FETCH_FAILED`, `NAME_TAKEN`, `SLUG_TAKEN`, `CATALOG_LIMIT_REACHED`, `OFFER_UNSUPPORTED`, `OFFER_IGNORED`, `OFFER_ALREADY_MAPPED`, `ROUTE_KIND_MISMATCH`, `ROUTE_FIELDS_UNMAPPED`, `VALIDATION_FAILED` (each row's error in `details.rows`) |
| `POST /api/admin/suppliers/:code/categories/:categoryId/link` | Admin | `linkCategorySchema` (`gameId`, `fieldMap`, rows) | `201` `{ gameId, products }` | as import, plus `ROUTE_EXISTS`, `PARENT_ARCHIVED` |
| `POST /api/admin/suppliers/:code/categories/:categoryId/unlink` · `/ignore` · `/unignore` | Admin | — | `supplierCategoryNodeSchema` | `NOT_FOUND` |
| `POST /api/admin/suppliers/offers/:id/ignore` · `/unignore` | Admin | — | `supplierOfferSchema` | `NOT_FOUND`, `OFFER_ALREADY_MAPPED` (ignore) |
| `GET /api/admin/suppliers/:code/offers` (S07) | Admin | adds `categoryId?`, `supported?`, `ignored?`, `lowStock?` | rows add SF1's fields | — |
| `POST /api/admin/catalog/games/:id/activate-all` | Admin | — | `activateAllResultSchema` | `CATALOG_INCOMPLETE`, `NOT_FOUND` |
| `POST /api/admin/catalog/games/:id/cover/from-supplier` | Admin | `{ supplier, categoryId }` (a node linked to this game) | game detail | `IMAGE_FETCH_FAILED`, `NOT_FOUND` |
| `GET /api/admin/suppliers/:code/statement/transactions` · `/orders` | Admin, 1 per 5 s per supplier | `page` | `supplierTransactionSchema[]` · `supplierOrderSchema[]` with matches | `CAPABILITY_UNSUPPORTED`, `SUPPLIER_NOT_CONFIGURED`, `SUPPLIER_UNAVAILABLE`, `RATE_LIMITED` |
| `GET /api/admin/suppliers/:code/platform-status` | Admin | — | `platformStatusSchema` | `CAPABILITY_UNSUPPORTED`, `SUPPLIER_UNAVAILABLE` |
| `GET /api/admin/suppliers` (S07) | Admin | — | adds new offers count, low-stock count, platform status when cached | — |
| `GET /api/orders` · `/api/orders/:id` (S08, customer) | Customer | unchanged | adds `placedByStore` (`on_behalf`, `gift`, `compensation` or null) and `customerNote`; no price for gift and compensation | — |

Supplier calls from the API (images, statement, nearby orders, platform status, admin player checks) go through the registry with credentials decrypted in memory per call, as S09's checks do. Every response that carries supplier text renders it as text.

## Jobs and integrations
- `suppliers.sync` (S07): reads categories first (SC2), then offers with the new fields (SC3); after commit, the low-stock step (SF2) and the run's counts. Safe twice: upserts by natural keys, alert levels stored per offer.
- `orders.poll` and `orders.sweep` (S08): the re-send rule RS1 when they re-send with the same key.
- Daily summary (S05 AL3): new packs (SC11), offers low or out of stock (SF2), and owner-funded orders today against the cap.
- Telegram (S05 write path): `admin_order_placed` (dedupe `admin-order:<orderId>`); `supplier_stock_low` (dedupe `stock:<runId>`): "مخزون منخفض في WDGZone: PUBG Mobile · 60 UC (4 متبقية)، …".
- `wdgzone` adapter: capabilities `categories`, `statement`, `platformStatus`; `listOffers` keeps unsupported offers with their reason (SC3) and adds stock (`999999` and above as unlimited), `original_price`, `category_id` and `required_fields` as field specs; `listCategories` (`GET /categories`), `listTransactions`, `listOrders` (`GET /transactions`, `GET /orders`, paged), `getPlatformStatus` (`GET /health`); image hosts `wdgzone.tech`. Their reply shapes beyond the documented examples are recorded from read-only live calls with the owner's key in PR2 and saved as sanitized fixtures (`docs/suppliers/wdgzone.md` updated).
- `fake` adapter: a category tree with images (bundled PNGs), stock, original prices and field specs, a statement built from its own orders, a platform status; the dev CLI gains `--order <offer> resend-refused` (PR1: the first send answers unknown, the re-send `INSUFFICIENT_BALANCE`), `--stock-count <offer> <n|unlimited>`, `--category-missing <id> on|off` and `--add-offer <category> <name> <usd>` (PR2).

## Screens
Admin (Arabic, RTL, light and dark). Store (phone width first, RTL, dark default).

- **`/orders/new` "شراء من اللوحة"** (button on `/orders`, "شراء لهذا الزبون" on the customer profile, "شراء" per pack on the game page, each preset):
  1. Mode: four cards (زبون مباشر، بطلب زبون من محفظته، هدية لزبون، تعويض لزبون) with who pays.
  2. Customer (not for walk-in): search by name, email or phone; the card shows balance, frozen, today's cap left; frozen or unverified customers are shown disabled with the reason.
  3. Pack: game, then pack with price (USD and SYP), availability (paused packs selectable for owner-funded modes, marked "موقوفة: شراء تجريبي"), basis supplier and stock level; quantity.
  4. Account fields: the game's fields for every pack (S08 O5, code packs too); for a direct pack also the customer's saved IDs as chips, the player check with its answer and the "not found" confirmation.
  5. Reason (internal, required), note to the customer (gift and compensation), a summary: total, who pays, the customer's balance after or today's owner total against the cap. "تأكيد الشراء" asks for re-authentication, then opens the order page.
  States: loading skeletons; errors in place with their translation (`PRICE_CHANGED` refreshes the price and asks again; `OWNER_DAILY_CAP_EXCEEDED` shows the amount left and a link to the policy).
- **`/orders`, `/orders/$id`, `/orders/live`:** mode chips and filters; the order page shows placer, mode, reason, payer, customer note; for walk-in orders the code reveal hint (AP12); an attempt refused on re-send (RS3) shows the code and "طلبات المورد القريبة" (SF4) beside S08's decisions.
- **`/orders/policy`:** the owner daily cap field.
- **`/suppliers`:** each card adds the platform status and catalog update time, new packs and low-stock counts; the navigation item shows the new packs count.
- **`/suppliers/$code` "الكتالوج":** the tree (SC4) with thumbnails, counts, state chips (غير مستوردة، مربوطة، باقات جديدة، متجاهلة) and the linked game; per node: "استيراد كلعبة جديدة"، "ربط بلعبة موجودة"، "تجاهل" / "إلغاء التجاهل"، "فك الربط". A selected node shows its packs (SF1) with per-pack ignore. Empty: "لا فئات بعد: شغّل المزامنة"; a supplier without the capability: "هذا المورد لا يعرض فئات".
- **Import dialog** (wide sheet, three sections): the game (Arabic and English names, store category, slug, cover preview from the supplier with "رفع صورة أخرى"), the input fields (suggested rows, editable, with the supplier's label, type and key beside each), the packs grouped by subcategory (checkbox, Arabic name, game amount, cost, original price and discount, stock, the price the store would charge, unsupported packs disabled with the reason), select all per group. Per-row errors stay in place. After success: "تم إنشاء اللعبة موقوفة" with links to the game page and to "تفعيل الكل".
- **Link dialog:** the game, the field map onto its fields, and per pack "باقة موجودة" (proposed match) or "باقة جديدة" (name, game amount) or leave out.
- **"العروض":** SF1's columns and filters; **"كشف الحساب":** transactions and orders tabs, page by page, matched rows linked, unmatched marked; "تحديث" respects the rate limit.
- **Game page (S06):** "تفعيل الكل" with a confirmation showing the count, then the activated and skipped lists; the linked supplier categories with "فك الربط"; "استخدام صورة المورد" beside the cover; stock chips on packs.
- **Reports (S13):** the "طلبات من مال المالك" line in R1 and R2; owner drawings in R6 and in the money places summary.
- **Store `/orders` and `/orders/[id]`:** the chip and note of AP11; gift and compensation orders without a price; walk-in orders never appear anywhere in the store.

## Audit and notifications
- Admin orders: S08's `order.paid` entry has the admin as actor and carries the mode, payer, customer, product, quantity, total and reason; refunds and decisions as S08. `order_policy.set` for the cap (before and after).
- Admin player checks: not audited (S09 records checks); the admin id is on the cache row.
- Catalog: `supplier.category_imported` (`{ supplier, categoryId, gameId, count }`) plus S06's `catalog_game.created`, `catalog_input_field.created`, `catalog_product.created` and S07's `product_route.created` per row; `supplier_category.linked` (`{ supplier, categoryId, gameId, count }`), `.unlinked`, `.ignored`, `.unignored`; `supplier_offer.ignored`, `.unignored`; `catalog_game.activated_all` (`{ gameId, activated, skipped }`) plus S06's per-row status changes; `catalog_game.updated` for a cover from the supplier.
- System changes (categories, stock levels, alert levels) live in their tables, not in audit (S07's rule).
- Notifications: the customer gets `order_placed_for_you` (email, center, push) for `on_behalf`, `gift` and `compensation`, then S08's order events; nothing for walk-in orders. The admin gets `admin_order_placed` and `supplier_stock_low` on Telegram and three daily summary lines.

## Abuse and fraud
| Threat | Control |
|---|---|
| A refusal on a re-send buys the order again on the next route (Q18) | RS1: only the first send of an attempt can fail it; any refusal of a re-send is unknown and waits for the admin |
| A stolen admin session buys gift cards from the owner's funds and reveals the codes | Re-authentication (TOTP) per order and per reveal, the $100 daily cap under a lock, a Telegram notice per order, audit; the cap changes only with re-authentication |
| A stolen admin session drains a customer's wallet "on behalf" | Re-authentication, the customer's own daily cap and freeze, an immediate email and push to the customer, Telegram notice, audit with the reason |
| Double submit or retry of an admin order | `Idempotency-Key` per dialog opening, unique among admin orders; same body returns the first order |
| Two admin orders racing past the daily cap | The `owner_drawings:USD` row locked `FOR UPDATE` while summing |
| A gift used to move value to an accomplice's account | Gifts never touch a wallet (goods only), count toward the owner cap, and are audited and reported on their own line |
| Hostile supplier images (huge, malformed, tracking) | Fetched only from the adapter's declared HTTPS hosts, size and time limits, decoded with a pixel limit and re-encoded, never loaded by the browser from the supplier; the store serves only stored files |
| Server-side request forgery through an image URL | The URL comes from the supplier's catalog, not the admin, and only declared hosts are fetched, without redirects elsewhere |
| Script injection through supplier names, labels and options | Rendered as text, length-bounded; suggestions sanitized into field keys and option values |
| Importing a pack that cannot be ordered correctly (two fields) | Unsupported offers are refused by import and routes (SC3) |
| A double purchase at the supplier going unseen | The statement marks supplier orders not matched to an attempt; reconciliation's supplier balance check (S13 E2) |
| Exhausting the supplier's rate limit from the panel | Statement and nearby-order reads 1 per 5 seconds per supplier, images cached, platform status cached 60 seconds; the sync keeps its own reserve (wdgzone.md) |

## Edge cases
1. An attempt times out, its re-send meets `INSUFFICIENT_BALANCE`: unknown (RS1), re-sent on schedule, held after 30 minutes; the admin checks the nearby supplier orders and confirms delivered or failed.
2. The sweep re-sends an attempt whose first call never left the worker (a crash) and the supplier refuses: unknown and held, at the cost of a wait; the admin confirms failed and the next route is tried.
3. Two admin orders at the cap's edge: the lock serializes them; the second is refused with what is left.
4. An owner-funded order refunded: owner drawings go back up, today's cap usage goes down by the refund.
5. The emergency stop is on: every admin order is refused (`PURCHASES_STOPPED`); fulfilment of orders already paid continues as S05 decides.
6. The customer is frozen between opening the dialog and confirming: refused `ACCOUNT_FROZEN`.
7. The price changes while the dialog is open: `PRICE_CHANGED`, the dialog shows the new price and asks again.
8. A gift to a test customer: test routes only (S08 R4); in production, where `fake` is off, it waits on the manual route or is refunded to owner drawings.
9. A walk-in order whose player is not found: the admin confirms (`confirmPlayer`) or corrects the fields.
10. A paused pack bought from owner funds for a trial: delivered or refunded as any order; the product stays paused.
11. A category already linked to a game and an import requested on its child: `CATEGORY_LINKED`; the child can be linked to the same game instead.
12. A category disappears at the supplier: kept with "اختفت من المورد"; its offers go missing by S07 SY4 and their routes become unusable; the link stays.
13. A category's subtree gets a new pack: state `new_packs`, the badge and the next daily summary count it until it is imported, linked to a product or ignored.
14. An import of 100 packs where one name is taken: nothing is created; the dialog marks the row.
15. The supplier image fails to download on import: `IMAGE_FETCH_FAILED` before anything is written; the admin uploads a cover and retries.
16. "تفعيل الكل" on a game without a cover: `CATALOG_INCOMPLETE`, nothing activated.
17. A pack's stock is unlimited (`999999`): stored as unlimited, never low.
18. A low-stock offer recovers and drops again: the second drop alerts again.
19. The statement read fails or the supplier is down: the tab shows the error with retry; nothing else changes.
20. A supplier order matched to an attempt of an order that was refunded: shown "مطابق، والطلب مُسترد": a possible delivery after refund, settled by an S13 supplier correction (S08 F5's conflict case).
21. Before PR4, unsupported offers stay visible but cannot be imported. From PR4 (Q19 answered), an offer with two fields or a select is imported and routed (MF1–MF3); a pack whose select options lack one of the game field's options is refused on its row (`FIELD_OPTIONS_DIFFER`); an offer that loses a field or an option at the supplier makes its route `fields_incomplete` until the admin maps it again.
22. An admin order for a customer archived since the dialog opened: `NOT_FOUND`.

## Open questions
- Q19 (WDGZone, two fields and select fields): resolved on 2026-10-13 (WDG support's answer, the owner's decisions): rules MF1–MF5.
- Not owner decisions, settled in PR2 from read-only live calls: the reply shapes of WDG's `GET /categories` paging, `GET /transactions` and `GET /orders` beyond the documented examples. Fields WDG does not send are hidden in the panel.

## Acceptance
- Owner, in the browser, with the fake supplier and test data:
  1. Script the fake supplier so an order's first send answers unknown and its re-send is refused (`supplier:fake --order <offer> resend-refused`): the attempt stays unknown, then held; "طلبات المورد القريبة" shows the fake's order; confirm delivered.
  2. `/orders/new`: a walk-in order for a code pack; re-authenticate; the order delivers; reveal the code with re-authentication; Telegram shows `admin_order_placed`.
  3. Set the owner cap to $1 in `/orders/policy` and try a $2 walk-in order: refused with the amount left; set it back to $100.
  4. An order on behalf of a test customer: the wallet goes down; the customer's "طلباتي" shows "أنشأه المتجر بطلبك" and the notification center has the event.
  5. A gift to the same customer with a note: no wallet change, "هدية من المتجر" with the note and no price; script it to fail and see "تعذّر تنفيذ الطلب" without an amount; owner drawings return in R6.
  6. `/reports`: the owner-funded line in R1; the dashboard's sales unchanged by owner orders; run the reconciliation: C4, C6, C7 pass.
  7. `/suppliers/fake` "الكتالوج": the tree with images and states; import a root category as a new game with two subcategories' packs, edited names and suggested fields; the game and packs are paused and priced; "تفعيل الكل" activates them; the store shows the game with the supplier's image.
  8. Add a pack to that category in the fake catalog and sync: "باقات جديدة" on the category and the navigation badge; ignore the pack: the badge clears.
  9. Link another fake category to an existing game, mapping one pack to an existing product and one as new.
  10. Set a mapped pack's stock to 5 and sync: one `supplier_stock_low` message and the chips; sync again: no second message; set it to 20 and back to 5: a new message.
  11. "كشف الحساب": transactions and orders of the fake supplier, matched to our orders; a scripted order the store did not make shows "غير مطابق".
  12. PR4: import the fake two-field category (player id and zone) and the select category (region): the dialog proposes two fields and a select with the supplier's options; activate and buy one pack of each in the store: the order delivers (the fake refuses a missing field or an unknown option, so delivery proves both fields and the option's supplier value were sent).
  13. PR4: link the select category to a game whose region field has fewer options than the supplier's: each option maps to a supplier option and the pack is linked; to a game whose region field has an option the supplier lacks: the pack's row is refused (`FIELD_OPTIONS_DIFFER`).
- Tests:
  - Unit (100% for the new contracts functions): `adminOrderShape`, `ownerCapRemaining`, `categoryState` (every state and the ancestor rules), `suggestInputFields` (keys, labels, types, uniqueness), `suggestProductName`, `parseGameAmount`, `discountPercent`, `stockLevel`, `isResendRefusal`.
  - Engine: RS1 for F3 and F6 re-sends with each refusal kind (with `inputRejected` too); a first send's refusal stays definitive.
  - API, per endpoint: success, 401, 403 (customer session on admin routes), re-authentication, idempotent replay and `IDEMPOTENCY_KEY_REUSED`; customers cannot read walk-in orders or other customers' admin orders; the store's order responses hide the price of gifts.
  - Money and concurrency: admin orders in each mode post AM1–AM3; two concurrent owner-funded orders at the cap's edge (exactly one passes); `on_behalf` with the customer's concurrent purchase never takes the wallet below zero; a refund of an owner-funded order credits owner drawings once; reconciliation C4, C6, C7 with owner-funded orders.
  - Database: the new checks on `orders`, the partial unique indexes, `player_checks` exactly-one check, `supplier_categories` grants.
  - Adapters: `wdgzone` categories, statement and platform status from recorded fixtures, unsupported offers kept with their reason, unlimited stock; image fetch refuses other hosts, redirects off-host, oversized and undecodable files.
  - PR4 adapters: `wdgzone` sends one field as `player_id` and several as their keys plus `player_id` (MF1), a select's supplier value (MF2), keeps unsupported only MF1's and MF2's leftovers; reads `{ code, pin }` and plain codes on purchase, poll and webhook, a `200` with another status as `unknown`, a `202` then `GET /orders/{id}` in each state, a `410` with `data.status` (MF4).
  - PR4 contracts and routes: `suggestInputFields` with selects (sanitized unique values, the option map), RT3 with option maps (`fields_incomplete`), import and link with `FIELD_OPTIONS_DIFFER`; the worker sends the attempt's option map on a re-send even after the route's map changed.
  - Import: all or nothing with per-row errors; `CATEGORY_LINKED` for ancestors and descendants; first prices written; link to existing products; "تفعيل الكل" activated and skipped lists.
  - Worker: low-stock levels alert once per level and clear on recovery; category read failure keeps the tree and the run goes on.
  - E2E and RTL screenshots (admin): `/orders/new` in each mode, the catalog tree, the import dialog, the link dialog, "كشف الحساب", "تفعيل الكل"; (store) an order placed by the store and a gift order on phone width.

## Settled in implementation
- PR 1 (2026-10-12):
  - RS3's "طلبات المورد القريبة" (SF4) needs the `statement` capability, which arrives in PR 2; PR 1 shows the refused re-send's code on the attempt, and the admin settles it with S08's decisions (owner, 2026-10-12).
  - `orders.idempotency_key` stays unique across every order (customer and admin keys are random UUIDs): a stronger form of the two partial indexes the Data section names, with no migration of the existing index. A customer's key never replays as an admin order and back (`IDEMPOTENCY_KEY_REUSED`).
  - The note on `order_placed_for_you` is the parameter `message`: rule NT3 refuses parameter names with `note`, which stand for the admin's internal notes.
  - The admin player check runs as a real customer's would (every route of the pack, the fake included where it is on); a pack the admin paused may be checked (AP5).
  - Stock levels on packs (SF2) and the stock line of the purchase dialog arrive with PR 2's offer fields.
  - Owner-funded orders stay out of the dashboard, R1, R2, R5 and the customer's daily cap; R6 shows `owner_drawing` and `owner_drawing_refund` lines and owner drawings at the start and end of the period.
  - Owner acceptance (2026-10-13): the store's order page names a failed gift or compensation "تعذّر تنفيذ الطلب" without the wallet or an amount (AM3), as the notification does; switching report tabs never draws another report's data in a view.
- PR 2 (2026-10-13):
  - The reply shapes of WDG's `GET /transactions` and `GET /orders` are not documented and no live call was made in PR 2 (the owner's key was not used; a $0 wallet would have answered empty lists): rows are read leniently field by field (`id`, `type`, `amount`, `balance_after`, `reference` or `description`, `order_id`, `product_id`, `product_name` or `product`, `quantity`, `status`, `total`, `currency`, `created_at`), anything else is left out and hidden in the panel, and a page ends the list by `pagination` when WDG sends it, else when it holds fewer than 50 rows. `GET /categories` follows a `pagination` object if WDG ever sends one. The fixtures for them are synthetic; recording them from read-only live calls stays open (`docs/suppliers/wdgzone.md`).
  - `categoryState` is `categoryStandings(nodes, offers)` in the contracts: every node's state, effective game and counts at once, so a page of 200 nodes reads the tree once.
  - The supplier's category list query is `supplierCategoryListQuerySchema` (`categoryListQuerySchema` is S06's store categories).
  - Rule SF2's alert levels compare by rank (`ok` and `unlimited` 0, `low` 1, `out` 2): `out` back to `low` keeps the stored `out`, so only a recovery at or above the threshold re-arms the alert (`stockAlertChange`). Offers no longer mapped to an active product lose their stored alert.
  - `supplier_policy.low_stock_units` is a `bigint` like every `*_units` column (migration 0058 widens 0056's integer; nothing was deployed between them).
  - Rule SC12 gives a supplier key shorter than two characters `_f` (S06 keys have 2 to 32), and looks the dictionary up by the sanitized key (`Zone-ID` reads as `zone_id`).
  - Routes and imports refuse an unsupported offer (`OFFER_UNSUPPORTED`) and an ignored one (`OFFER_IGNORED`); RT4 also makes an existing route on an offer that became unsupported unusable (`offer_unsupported`).
  - A route created by an import or a link keeps only the field map entries of its own offer's fields, so a supplier is never sent a field it did not ask for.
  - Rule SC8's link of a node already linked to the same game adds its rows without a new link; the per-row refusals of new packs come back numbered as the request's rows.
  - Rule SC10's skipped reasons: `review_pending` when a review holds the price, `no_route` without a usable route or none profitable at the current price, `no_price` without a price.
  - Rule SF3's limit is one read per 5 seconds per supplier and list (transactions, orders, nearby orders each), so the two tabs of "كشف الحساب" do not block each other. Panel reads (`list_transactions`, `list_orders`, `platform_status`, `fetch_image`) are recorded and left out of health; `list_categories` counts like `list_offers` (success rate, not p90).
  - Rule SF4 answers `{ items, complete }` (`nearbySupplierOrdersSchema`) instead of a bare list: `complete` is false when the three pages read did not reach the attempt's window or a supplier order carried no time, so an empty list is never read as "the supplier has no such order" (reviewer, 2026-10-13: confirming failed on an incomplete read could buy twice). A supplier order without a time, offer or quantity stays listed as a possible match.
  - Rule IM1's thumbnails come from the adapter's `fetchImage` (WDGZone: HTTPS on `wdgzone.tech`, redirects followed by hand only to declared hosts, without the API key; the fake: bundled PNGs on `fake-supplier.invalid`), so the API never calls a supplier host the adapter does not declare.
- PR 3 (2026-10-13):
  - Three reads the screens needed and PR 2 left out: route offers carry `stock` and `stockLevel` (the route drawer's chip), products carry `basisStockLevel`, the level of their basis offer (the game page and the purchase page, PR 1's deferral), and `GET /api/admin/catalog/games/:id/supplier-categories` lists the nodes linked to a game itself (its page's "فك الربط" and IM3's button). `STOCK_LEVELS` moved to `catalog.ts` (the suppliers contracts import it from there).
  - The import and link dialogs are wide side sheets. A refusal reads the draft again: a pack it now refuses (ignored, mapped, missing meanwhile) is unselected and disabled, with the refusal under it; a pack the draft gained comes unselected.
  - The link dialog's three choices per pack are "باقة موجودة" (the proposed match first, else the game's first pack), "باقة جديدة" and "اتركها"; refused packs can only be left out.
  - "تفعيل الكل" is a button on the game page's products tab and on the import's success view; its confirmation counts the paused unarchived packs.
  - The navigation badge reads the supplier list every minute in the background and adds each supplier's new packs; the cards read the platform status on their own (the API caches it a minute), so a supplier whose status read fails shows "تعذّرت قراءة حالة المنصة" without hiding the card.
  - "طلبات المورد القريبة" shows on routed attempts that are `sending`, `pending` or `unknown` at a supplier with the `statement` capability, read only when the admin asks.

- PR 4 (2026-10-13):
  - The owner's read-only scan of the 5,602 WDG top-ups (`docs/suppliers/wdgzone.md`, "Account fields"): 4,953 are supported under MF1–MF2 (3,669 before), 649 stay unsupported. MF2's "options that do not parse" are, besides fewer than 2: more than 50 options (S06's bound; 149 packs), an empty, repeated or over-64-character value (20). Within one game no supported select key has packs with different option values, so `FIELD_OPTIONS_DIFFER` refuses no WDG row today.
  - Rule MF3's sanitizing of option values is SC12's (lower case, characters outside `[a-z0-9_]` as `_`, cut to 32) made unique with `_2`, `_3`…; labels are cut to S06's 40. A supplier select outside 2–50 options is suggested as a text field (its offer is unsupported anyway).
  - RT3 with option maps (`unmappedOptions` in the contracts): a supplier select must map to one of our selects, and every option of that field needs a value from the supplier's list; our select mapped to a supplier text field sends our value as it is. Route create and update refuse a gap with `FIELD_OPTIONS_DIFFER` and `details.fields` (the supplier keys), import and link rows with it in `details.rows`; S07's offers import takes an `optionMap` too.
  - The link draft proposes each of the game's options onto the supplier's by equal value, else equal label, else equal sanitized value (`proposeOptionMap`); an option without one is left for the admin. It also maps a supplier field onto the game field with the same key underscores aside (`playerid` and `player_id`); the one-field fallback applies only to a single supplier field.
  - The panel reads a pack's `FIELD_OPTIONS_DIFFER` again as the admin removes options (import) or maps them (link): such a pack comes selected and is kept out until its options can be sent. The add-route dialog edits the option map too, since a select offer's route needs it from creation.
  - An attempt with a field map but no option map (written before PR 4) sends `{}`; one without a field map (before S08's column) follows the route's maps. The player check sends a select as the route's option value, as the order would.
  - The fake supplier's two-field category is Mobile Legends (`playerId`, `zoneId`) and its select category Genshin Impact (`region`: `os_usa`, `os_euro`, `os_asia`, `os_cht`); it refuses a missing field or a value outside the list with `FIELD_REFUSED`.
  - WDG's `GET /health` needs the key (`401` without it, seen 2026-10-13); the adapter always sent it.
  - MF4's code limit is S08's 200 characters per code text; an item with an empty code or a longer text makes the whole answer `unknown`. A `202`'s `GET /orders/{id}` maps `refunded`, `failed`, `cancelled` with the status upper-cased as the supplier code.

## Implementation plan
Owner preference: few PRs, each safe on its own.
1. **Re-send safety net and admin purchases:** contracts, db (order columns, checks and indexes, `player_checks`, the policy cap, `owner_drawings`), the engine's RS1, the api (`POST /api/admin/orders`, context, admin player checks, filters, the customer view), worker notices and summary line, reports, dashboard and reconciliation updates, the admin `/orders/new` and order page additions, the store chips, E2E. Updates `docs/suppliers/wdgzone.md` and the roadmap's WDGZone line (RS4).
2. **Supplier catalog, back end:** contracts, db (`supplier_categories`, offer and policy columns), the `wdgzone` and `fake` adapters (categories, offer fields, statement, platform status, image hosts, recorded fixtures), the sync and low-stock steps, the api catalog, import, link, ignore, images, statement, platform status and "activate all" routes.
3. **Supplier catalog, panel:** the catalog tab, import and link dialogs, offers columns, "كشف الحساب", supplier cards and badge, game page additions, E2E and screenshots.
4. **Two fields, select fields and WDG delivery replies (MF1–MF5; Q19 answered 2026-10-13):** contracts (`suggestInputFields` with selects, the option map schema and RT3's option check, `FIELD_OPTIONS_DIFFER`, import, link and route schemas), db (`product_routes.option_map`, `fulfilment_attempts.option_map`), the `wdgzone` adapter (MF1 and MF2 sending, which offers stay unsupported, MF4 replies with `GET /orders/{id}` after a `202`; fixtures: a select product from the owner's read-only call, else synthetic from the documented shape), the `fake` adapter (a two-field category and a select category; it refuses an order missing a field or with a value outside its options), the worker (option values through the attempt's option map), the api (import, link, routes), the admin (select fields and options in the import and link sheets, the route drawer's option map), E2E and screenshots. Updates `docs/suppliers/wdgzone.md`.
