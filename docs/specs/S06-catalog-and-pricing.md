# S06 — Catalog and pricing (F08, F10)

Status: Approved · Date: 2026-10-08 · Scope: `docs/product/v1-scope.md` §F08, §F10 (A06 margin guard, with S07) · ADRs: 0003, 0005, 0008, 0011, 0012, 0016, 0020

## Summary
Nothing can be sold until the store knows what it sells and at what price. S06 gives the admin the catalog (categories, games and apps with their artwork, accent color, ID guide and input fields, and their packs, either direct top-ups or codes) and the pricing engine's rules: a margin per category, game or product over a global default, the price math (cost + margin, rounded up to whole cents, never below the minimum margin), the margin guard predicate and the savings against an official price, with a preview that shows the price, the margin and the SYP price for any cost. Supplier costs arrive with S07: until a product is mapped to a supplier offer it has no price and is shown as unavailable (owner, 2026-10-08: pricing without mapping; ADR 0020).

## In scope / out of scope
- In:
  - Catalog (F08): admin-managed categories (seeded: games, apps, gift cards); games and apps (Arabic and English names, slug, category, cover image, accent color checked for contrast, ID guide image, region notes, status, order); input fields per game (key, Arabic label, type, required, length bounds or options, help text, order); products (packs) of two kinds, `direct` and `code`, with name, in-game amount, official price, maximum quantity, code region and redemption instructions, status, order. Create, edit, reorder, pause, archive and restore, all audited.
  - Catalog images: upload (re-encoded WebP through `files`), a public immutable image route.
  - Pricing (F10): margin rules (global, category, game, product), rule resolution, the price math, the margin guard predicate, savings, a preview endpoint and the admin pricing page. Rule changes need re-authentication and are audited.
  - Q7 and Q13 answered (owner, 2026-10-08); ADR 0020.
- Out (later or never):
  - Supplier offers, product mappings, route costs, stored product prices and their history, repricing on cost or rule changes, the price change review queue, the margin guard pausing products, the availability computation and the S03 rule that refuses a display step adding more than 2% to the cheapest active product: S07 (F09), which brings the costs these need. S07 uses S06's math and rules unchanged.
  - Mapping input fields to suppliers' field names and SHOP2TOPUP's requirements check: S07.
  - Validating a customer's field values, the price on the order, `PRICE_CHANGED` and the margin guard at pay time: S08 (F11). The validation rules of each field type are fixed here (CT7) and built with their first use there.
  - Store pages (home, game pages, packs, search, the "how many do I need" calculator) and the public catalog read API with its cache tags: S09 (F12, F15). Responsive image widths and AVIF: S09.
  - Search aliases and misspellings: S09 (F15) adds them to the catalog.
  - Coupons and discounts: out of V1.

## Access
| Action | Route kind | Who |
|---|---|---|
| Read a catalog image | Public | Anyone |
| Read, create, edit, reorder, pause, archive and restore categories, games, input fields and products; upload catalog images | Admin | The admin |
| Read margin rules; preview a price | Admin | The admin |
| Set or archive a margin rule | Admin, re-authentication | The admin |

## Data
All new tables are business tables (`id`, fields, `created_at`, `updated_at`, `archived_at`) unless noted. Text fields are plain text, trimmed, rendered as text (never HTML or Markdown).

### `catalog_categories` (new; owner: `catalog`)
- `name_ar` text 1–40, unique among unarchived rows; `slug` text (`^[a-z0-9]+(-[a-z0-9]+)*$`, 2–48), unique among all rows (archived included: URLs are never reused); `sort_order` int.
- Seeded by a custom migration: `games` "ألعاب", `apps` "تطبيقات", `gift-cards` "بطاقات هدايا" (sort 1–3).

### `catalog_games` (new; owner: `catalog`)
A game or an app (the store calls both "لعبة/تطبيق"; one table).
- `category_id` uuid FK `catalog_categories` (indexed); `slug` as categories, unique among all games; `name_ar` text 1–60, unique among unarchived games; `name_en` text 1–60 (Latin, shown under the Arabic name and used by search later).
- `status` enum `catalog_status` (`active`, `paused`), default `paused`: a new game stays hidden until it is complete and the admin activates it (CT3).
- `cover_file_id` uuid nullable FK `stored_files`; `id_guide_file_id` uuid nullable FK `stored_files`; `accent_color` text nullable (`^#[0-9A-F]{6}$`, upper case); `region_notes_ar` text nullable ≤ 500.
- `sort_order` int (within its category).
- Index `(category_id, sort_order)`.

### `catalog_input_fields` (new; owner: `catalog`)
- `game_id` uuid FK (indexed); `key` text (`^[a-z][a-z0-9_]{1,31}$`, e.g. `player_id`, `zone_id`), unique per game among all rows and immutable (orders and supplier mappings refer to it); `label_ar` text 1–40; `help_ar` text nullable ≤ 200.
- `type` enum `input_field_type`: `digits`, `text`, `select`, `phone`; immutable after creation.
- `required` boolean; `min_length`, `max_length` int nullable (`digits`: 1–32, `text`: 1–64, `min ≤ max`; null for `select` and `phone`); `options` jsonb nullable (`select` only: 2–50 items `{ value: ^[a-z0-9_-]{1,32}$, labelAr: 1–40 }`, values unique).
- `sort_order` int. At most 10 unarchived fields per game.

### `catalog_products` (new; owner: `catalog`)
- `game_id` uuid FK (indexed); `kind` enum `product_kind` (`direct`, `code`), immutable after creation.
- `name_ar` text 1–60 (e.g. "60 UC"، "بطاقة آيتونز 10$"), unique per game among unarchived rows; `game_amount` int nullable > 0 (the in-game amount delivered, e.g. 60 or 325; S09's calculator uses it).
- `official_price_usd_units` bigint nullable, whole cents, > 0 (Q13: entered by the admin; savings are hidden when it is null).
- `max_quantity` int 1–50: default 1 for `direct`, 10 for `code` (owner, 2026-10-08), editable per product.
- `region_ar` text nullable ≤ 64 and `redemption_ar` text nullable ≤ 2000: `code` products only (null for `direct`, a check enforces it).
- `status` `catalog_status`, default `active`; `sort_order` int (within its game). At most 100 unarchived products per game.
- Index `(game_id, sort_order)`.

### `margin_rules` (new; owner: `pricing`)
- `scope` enum `margin_scope` (`global`, `category`, `game`, `product`); `target_id` uuid nullable (null only for `global`, a check enforces it; no foreign key, since the target lives in another module's table: the API checks it exists and is not archived when the rule is set).
- `percent_bp` int 0–10,000 (basis points: 1000 = 10%); `fixed_usd_units` bigint 0–$50 whole cents; `min_margin_usd_units` bigint $0.01–$50 whole cents.
- Partial unique index `(scope, target_id) where archived_at is null` with `nulls not distinct`: one live rule per target and one global rule. Index `(target_id)`.
- Seeded by a custom migration: the global rule 10%, $0 fixed, $0.10 minimum (Q7, owner, 2026-10-08).

### `stored_files` (exists; new kind)
- `stored_file_kind` gains `catalog_image`: WebP, longest side at most 1600 px. Catalog image rows, like every stored file, are never changed or deleted; replacing a cover is a new file.

### Contracts
- `catalog.ts`: `CATALOG_STATUSES`, `PRODUCT_KINDS`, `INPUT_FIELD_TYPES`, `PRODUCT_AVAILABILITIES` (CT9); `slugSchema`, `accentColorSchema`; `categorySchema`, `createCategorySchema`, `updateCategorySchema`; `gameSchema`, `gameDetailSchema` (with fields and products), `createGameSchema`, `updateGameSchema`, `gameListQuerySchema`, `gamePageSchema`; `inputFieldSchema`, `createInputFieldSchema`, `updateInputFieldSchema`; `productSchema`, `createProductSchema`, `updateProductSchema`; `reorderSchema` (`{ ids }`); `catalogImageSchema` (`id`, `url`, `width`, `height`); `contrastRatio(hexA, hexB)` (WCAG 2) and `ACCENT_MIN_CONTRAST = 3`.
- `pricing.ts`: `MARGIN_SCOPES`, `marginRuleValuesSchema`, `marginRuleSchema`, `setMarginRuleSchema`, `pricingPreviewRequestSchema`, `pricingPreviewSchema`; pure functions `priceFromCost`, `isProfitable`, `resolveMarginRule`, `savings` (PR1–PR8).
- Error codes: `SLUG_TAKEN`, `NAME_TAKEN`, `FIELD_KEY_TAKEN`, `CATALOG_INCOMPLETE` (`details.missing`: `cover`, `input_fields`), `CATALOG_NOT_EMPTY`, `PARENT_ARCHIVED`, `ACCENT_CONTRAST_TOO_LOW` (`details.ratio`), `IMAGE_INVALID`, `CATALOG_LIMIT_REACHED`, `GLOBAL_RULE_REQUIRED`. Each comes with its Arabic text in the admin catalog.
- Audit: entity types `catalog_category`, `catalog_game`, `catalog_input_field`, `catalog_product`, `margin_rule`; actions in "Audit and notifications".

## States and rules

### Catalog (F08)
- CT1. Categories, games, input fields and products are archived, never deleted. Archiving hides a row from everything but the admin's archive filter; restoring brings it back as it was. A restore is refused with `PARENT_ARCHIVED` while its parent (category for a game, game for a field or product) is archived, and with `NAME_TAKEN` when an unarchived sibling now has its name.
- CT2. A category with unarchived games cannot be archived (`CATALOG_NOT_EMPTY`): move or archive its games first. A game can move to another unarchived category; it goes to the end of that category's order.
- CT3. A game can be set `active` only when it has a cover image and, if it has any unarchived `direct` product, at least one unarchived required input field; otherwise `CATALOG_INCOMPLETE` names what is missing. The same check refuses archiving the last required field, or creating or restoring a `direct` product, in an active game that would then be incomplete. New games start `paused`.
- CT4. **Statuses.** `paused` on a game hides none of its data from the admin and makes all its products unavailable to customers (CT9). `paused` on a product makes that product unavailable. Pausing or resuming takes effect at once and is audited.
- CT5. **Order.** Reorder takes the full list of unarchived ids of one parent (categories; games of one category; fields or products of one game) in their new order and rewrites `sort_order` as 1…n in one transaction. A list that is not exactly that set is refused (`VALIDATION_FAILED`). New rows go last. One audit entry per reorder.
- CT6. **Accent color.** Optional; when set, its WCAG contrast ratio against green-900 (`#0B2D28`, the store's dark surface) must be at least 3:1 (`ACCENT_CONTRAST_TOO_LOW` with the ratio). The ratio against white is computed and shown as a warning when below 3:1; S09 then uses the accent in the light theme only as a flat band without text (`brand/identity.md` §6). With no accent the store uses the brand's sand.
- CT7. **Input fields.** The key and type are fixed at creation. The value rules, built into a validation schema with the purchase flow (S08/S09), are: `digits` only `0-9`, length within the bounds; `text` printable characters without control characters, trimmed, length within the bounds; `phone` the S01 phone rules (E.164, Syrian by default); `select` one of the option values. A required field must be present; an optional one may be empty. Changing a label, help text, bounds, options or `required` takes effect for new orders only.
- CT8. **Products.** The kind is fixed at creation. `region_ar` and `redemption_ar` exist only for `code` products. `max_quantity` bounds the quantity a customer can order (S09); 1 for `direct` unless the admin raises it (packs the supplier sells in units, ADR 0004). The official price is optional, whole cents, and is a reference for savings only (PR7), never a price.
- CT9. **Availability** (F08, ADR 0020) of a product, derived and never stored, in this order: `hidden` (the product, its game or its category archived); `paused` (the game or the product paused); then, from S07, `paused_by_margin_guard` (the margin guard paused it) and `out_of_stock` (no healthy route with a known cost); otherwise `available`. Until S07 maps offers, every unarchived, unpaused product is `out_of_stock`. Customers see `paused`, `paused_by_margin_guard` and `out_of_stock` products greyed out in place, "غير متوفرة حالياً", with no price and no buy action (owner, 2026-10-08); a game whose products are all unavailable shows greyed out too. `hidden` products and archived games are not shown.
- CT10. **Images.** Upload accepts PNG, JPEG or WebP up to 5 MB and 25 megapixels; `files` decodes it with the pixel limit, strips metadata, fits it within 1600 × 1600 px and re-encodes it to WebP. Anything else is `IMAGE_INVALID`. The game form uploads first, then saves the returned id. Only `catalog_image` files are served by the public image route.

### Pricing (F10)
- PR1. **Values.** A margin rule is `{ percentBp, fixedUsdUnits, minMarginUsdUnits }` within the bounds of `margin_rules`.
- PR2. **Resolution.** A product's rule is the first live rule among its product, its game, its category, then the global rule. A rule replaces its parent entirely; fields are not inherited one by one. The global rule always exists and cannot be archived (`GLOBAL_RULE_REQUIRED`).
- PR3. **Price.** For a route cost `c` (USD units, > 0, ADR 0003) and a rule `r`: `markup = ⌈c × percentBp / 10,000⌉` units; `price = ceilToWholeCents(max(c + markup + fixedUsdUnits, c + minMarginUsdUnits))`. Integer math only, rounding only upward (Q7: whole cents, owner, 2026-10-08). Examples with the global rule: cost $0.89 → $0.99 (the $0.10 minimum governs); cost $8.50 → $9.35; cost $0.8875 → $0.99.
- PR4. **Margin** of a price is `price − cost`; by PR3 it is always at least the minimum margin and the price is always a whole cent.
- PR5. **Margin guard** (ADR 0005, 0020): a route with cost `c` is profitable for a price `p` under rule `r` when `p − c ≥ minMarginUsdUnits`. Routing (S08) never sends an order through a route that is not profitable for the price paid, and S07 pauses a product with no profitable route. ADR 0020 settles the boundary: a margin exactly at the minimum is profitable.
- PR6. **Price basis** (ADR 0020, owner, 2026-10-08): a product's price is computed from the cost of the cheapest healthy route in stock (degraded routes only when no healthy one exists, ADR 0005). A backup route is used only while it is still profitable for the price paid; otherwise the undelivered units are refunded (A04, ADR 0013). S07 stores and recomputes prices on that basis.
- PR7. **Savings** against an official price `o`: shown only when `o` is known and `price < o`; amount `o − price`; percent `⌊(o − price) × 100 / o⌋`, shown only when at least 1%.
- PR8. **SYP** prices are never stored: they are `sypDisplayPrice(price, rate, step)` from the current rate (S03, ADR 0003) wherever a price is shown.
- PR9. **Setting a rule** (`PUT /api/admin/pricing/rules`) upserts the live rule of `(scope, targetId)` in one transaction with its audit entry (before and after values). A target that does not exist or is archived is `NOT_FOUND`. Archiving a rule makes its target fall back to the parent rule. From S07, a rule change reprices the products it governs in the same transaction.
- PR10. **Preview** computes PR3–PR8 for a cost and either the rule that applies to a target or draft values from the form, with no write. It is how the admin checks a rule before saving it, and how S06 is accepted before costs exist.

## Money flows
None. S06 moves no money and stores no prices. Prices are stored and charged from S07 and S08, always computed by PR3 and guarded by PR5.

## API
All admin responses are `Cache-Control: no-store`. Lists follow ADR 0011 (`page`, `pageSize`).

| Method and path | Access | Request | Response | Error codes |
|---|---|---|---|---|
| `GET /api/catalog/images/:id` | Public, `Cache-Control: public, max-age=31536000, immutable` | — | `image/webp` (`X-Accel-Redirect` in production) | `NOT_FOUND` (missing, or not a `catalog_image`) |
| `POST /api/admin/catalog/images` | Admin | multipart `file` | `201` `catalogImageSchema` | `IMAGE_INVALID`, `PAYLOAD_TOO_LARGE`, `RATE_LIMITED` |
| `GET /api/admin/catalog/categories` | Admin | `archived?` | `categorySchema[]` with unarchived game counts | — |
| `POST /api/admin/catalog/categories` | Admin | `createCategorySchema` | `201` `categorySchema` | `SLUG_TAKEN`, `NAME_TAKEN` |
| `PATCH /api/admin/catalog/categories/:id` | Admin | `updateCategorySchema` (`nameAr`) | `categorySchema` | `NAME_TAKEN`, `NOT_FOUND` |
| `PUT /api/admin/catalog/categories/order` | Admin | `reorderSchema` | `categorySchema[]` | `VALIDATION_FAILED` |
| `POST /api/admin/catalog/categories/:id/archive` · `/restore` | Admin | — | `categorySchema` | `CATALOG_NOT_EMPTY`, `NAME_TAKEN`, `NOT_FOUND` |
| `GET /api/admin/catalog/games` | Admin | `gameListQuerySchema` (`categoryId?`, `status?`, `archived?`, `q?`, page) | `gamePageSchema` | `VALIDATION_FAILED` |
| `POST /api/admin/catalog/games` | Admin | `createGameSchema` | `201` `gameDetailSchema` | `SLUG_TAKEN`, `NAME_TAKEN`, `ACCENT_CONTRAST_TOO_LOW`, `PARENT_ARCHIVED`, `NOT_FOUND` (an image id that is not a `catalog_image`) |
| `GET /api/admin/catalog/games/:id` | Admin | — | `gameDetailSchema` (fields and products, archived ones included and marked) | `NOT_FOUND` |
| `PATCH /api/admin/catalog/games/:id` | Admin | `updateGameSchema` (everything but `slug`; `status`) | `gameDetailSchema` | `NAME_TAKEN`, `ACCENT_CONTRAST_TOO_LOW`, `CATALOG_INCOMPLETE`, `PARENT_ARCHIVED`, `NOT_FOUND` |
| `PUT /api/admin/catalog/categories/:id/games/order` | Admin | `reorderSchema` | `gameSchema[]` | `VALIDATION_FAILED`, `NOT_FOUND` |
| `POST /api/admin/catalog/games/:id/archive` · `/restore` | Admin | — | `gameDetailSchema` | `PARENT_ARCHIVED`, `NAME_TAKEN`, `NOT_FOUND` |
| `POST /api/admin/catalog/games/:id/fields` | Admin | `createInputFieldSchema` | `201` `inputFieldSchema` | `FIELD_KEY_TAKEN`, `CATALOG_LIMIT_REACHED`, `PARENT_ARCHIVED`, `NOT_FOUND` |
| `PATCH /api/admin/catalog/fields/:id` | Admin | `updateInputFieldSchema` (not `key`, `type`) | `inputFieldSchema` | `CATALOG_INCOMPLETE`, `NOT_FOUND` |
| `PUT /api/admin/catalog/games/:id/fields/order` | Admin | `reorderSchema` | `inputFieldSchema[]` | `VALIDATION_FAILED`, `NOT_FOUND` |
| `POST /api/admin/catalog/fields/:id/archive` · `/restore` | Admin | — | `inputFieldSchema` | `CATALOG_INCOMPLETE`, `CATALOG_LIMIT_REACHED`, `PARENT_ARCHIVED`, `NOT_FOUND` |
| `POST /api/admin/catalog/games/:id/products` | Admin | `createProductSchema` | `201` `productSchema` | `NAME_TAKEN`, `CATALOG_LIMIT_REACHED`, `CATALOG_INCOMPLETE`, `PARENT_ARCHIVED`, `NOT_FOUND` |
| `PATCH /api/admin/catalog/products/:id` | Admin | `updateProductSchema` (not `kind`; `status`) | `productSchema` | `NAME_TAKEN`, `NOT_FOUND` |
| `PUT /api/admin/catalog/games/:id/products/order` | Admin | `reorderSchema` | `productSchema[]` | `VALIDATION_FAILED`, `NOT_FOUND` |
| `POST /api/admin/catalog/products/:id/archive` · `/restore` | Admin | — | `productSchema` | `NAME_TAKEN`, `CATALOG_LIMIT_REACHED`, `CATALOG_INCOMPLETE`, `PARENT_ARCHIVED`, `NOT_FOUND` |
| `GET /api/admin/pricing/rules` | Admin | — | `marginRuleSchema[]` (live rules, each with its target's name and the number of unarchived products it governs) | — |
| `PUT /api/admin/pricing/rules` | Admin, re-authentication | `setMarginRuleSchema` (`scope`, `targetId?`, values) | `marginRuleSchema` | `REAUTHENTICATION_REQUIRED`, `NOT_FOUND`, `VALIDATION_FAILED` |
| `POST /api/admin/pricing/rules/:id/archive` | Admin, re-authentication | — | `204` | `REAUTHENTICATION_REQUIRED`, `GLOBAL_RULE_REQUIRED`, `NOT_FOUND` |
| `POST /api/admin/pricing/preview` | Admin | `pricingPreviewRequestSchema` (`target: { scope, id? }`, `costUsdUnits` 1 unit–$10,000, `values?` draft) | `pricingPreviewSchema` (the rule applied and where it comes from, price, margin and margin percent, SYP price or null without a rate, savings for a product) | `NOT_FOUND`, `VALIDATION_FAILED` |

## Jobs and integrations
None. No worker job, supplier call, email or Telegram message. The `catalog` module calls `FilesService` (`prepare`, `record`, `serve`); `pricing` reads the product → game → category path through `CatalogService` and the current rate through `RatesService.current()`.

## Screens

### Store
None in S06. S09 builds the store pages on this catalog, with CT6, CT9 and PR7–PR8.

### Admin (Arabic, RTL; light and dark)
- **Navigation:** "الكتالوج" (`/catalog`) and "التسعير" (`/pricing`).
- **`/catalog`:** category tabs (with "إدارة الفئات"), then the category's games as cards in their order: cover, Arabic and English names, status chip (نشطة، متوقفة), product count; filters for status and archived, a name search; "إضافة لعبة". Move up / move down buttons reorder (keyboard reachable; no drag only). Empty: "لا توجد ألعاب في هذه الفئة بعد" with the add button. Loading: skeleton cards. Error: retry.
- **Categories dialog:** list with rename, order, archive / restore (`CATALOG_NOT_EMPTY` explains which games are left), add.
- **`/catalog/games/new` and `/catalog/games/$id`:** tabs:
  - "البيانات": names, slug (read-only once created, with the note that it is the page address), category, cover and ID guide uploads with previews, accent color picker with both contrast ratios live (refused under 3:1 against the dark surface, warning against white), region notes, status toggle with the missing items when `CATALOG_INCOMPLETE`.
  - "حقول الإدخال": fields in order (label, key, type, required), add / edit dialog (type-specific bounds or options editor), order, archive / restore. Empty: "أضف حقل معرّف اللاعب قبل تفعيل باقات الشحن المباشر".
  - "الباقات": table in order (name, kind, in-game amount, official price, max quantity, status, availability "غير متوفرة: لا مورد مرتبط" until S07); add / edit dialog by kind (code products show region and redemption instructions); pause / resume; order; archive / restore with an archived filter.
  - "التسعير": the rule that applies to this game and where it comes from, "تخصيص هامش لهذه اللعبة" (opens the rule form), and per product the rule in force, with "تخصيص" per product.
- **`/pricing`:** the global rule (editable), category rules, then game and product overrides (target, values, products governed), each editable and archivable (not the global one); the rule form (percent, fixed, minimum margin) with a live preview for a sample cost (default $1.00) showing price, margin and SYP; a standalone calculator ("جرّب تكلفة") choosing a product, game or category and a cost. Saving opens re-authentication.
- Every error shows the translation of its code; forms keep their values on error.

## Audit and notifications
Every entry in the transaction of its change; admin actor, channel `admin`.
- `catalog_category.created` / `.updated` / `.archived` / `.restored`: the values, `updated` as before/after. `catalog_category.reordered`: `{ ids }`.
- `catalog_game.created` / `.updated` / `.archived` / `.restored` / `.reordered` (per category); status changes are `catalog_game.updated` with `status` before/after; image changes record the file ids.
- `catalog_input_field.created` / `.updated` / `.archived` / `.restored` / `.reordered`.
- `catalog_product.created` / `.updated` / `.archived` / `.restored` / `.reordered`.
- `margin_rule.set` (`{ scope, targetId, before, after }`, `before` null for a new rule) and `margin_rule.archived` (`{ scope, targetId, values }`).
- Not audited: image uploads by themselves (the game change that uses an image is), previews, reads.
- Notifications: none.

## Abuse and fraud
| Threat | Control |
|---|---|
| A price below cost from a bad rule or math | Integer math rounding only up, a minimum margin of at least $0.01 in every rule, the guard of PR5 at pay and routing time (S08), 100% tested contracts |
| A rule changed by a stolen admin session | Re-authentication (password + TOTP within 5 minutes) on every rule change, audit with before/after values |
| Malicious image upload (decompression bomb, polyglot, metadata) | Size and pixel limits, decode and re-encode to WebP, metadata stripped, random storage keys, served as `image/webp` with `nosniff`; admin only, rate limited |
| Public image route used to read other files | Only `catalog_image` rows are served; ids are UUIDs; receipts and QR images answer `NOT_FOUND` |
| Script injection through catalog text | Plain text only, rendered as text by React in both apps; no HTML or Markdown rendering |
| ReDoS through admin-defined patterns | No free regular expressions: fixed field types with length bounds and option lists |
| A URL reused for a different game | Slugs are immutable and unique across archived rows |

## Edge cases
1. Two panel tabs edit the same game: the last save wins; both are audited with before/after values.
2. A reorder sent with a stale list (a game added or archived meanwhile): `VALIDATION_FAILED`; the panel reloads the list.
3. Archiving a game whose category rule or own rule exists: the rules stay; they apply again on restore. `GET /api/admin/pricing/rules` marks rules whose target is archived.
4. A category is archived while the admin is moving a game into it: the move is refused with `PARENT_ARCHIVED`.
5. Changing a field from optional to required, or tightening its bounds, after customers saved player IDs (S10): affects new orders only; saved IDs are re-checked when used (S10).
6. An official price at or below the computed price: no savings shown (PR7); the preview says "لا توفير".
7. An official price far above the price (savings above 50%): shown as entered; the panel shows a warning that it should be checked, since the store will display it.
8. No exchange rate set yet: the preview shows the USD price and "لا يوجد سعر صرف" instead of SYP.
9. Image upload succeeds but the game form is never saved: the file stays unreferenced (stored files are append-only); it is never served from a page and costs only disk.
10. Restoring a product when its game already has 100 unarchived products, or a field over 10: `CATALOG_LIMIT_REACHED`.
11. A cost of 1 unit ($0.000001): price = $0.11 by PR3 with the global rule (the minimum margin governs, rounded up). A cost of $10,000 within bounds; larger costs are refused by the preview and, from S07, flagged for review.
12. Percent 0, fixed 0: allowed; the minimum margin still applies, so the price is never at cost.

## Open questions
None. Q7 (pricing policy) and Q13 (official price) were answered on 2026-10-08 and recorded in ADR 0020: global default 10% with a $0.10 minimum margin, editable per category, game and product; USD prices rounded up to whole cents; price on the cheapest healthy route; official price entered by the admin and savings hidden when unknown; unavailable products greyed out; admin-managed categories; code products limited to 10 per order by default. The S06/S07 boundary (pricing without mapping) was settled the same day.

## Acceptance
The owner's browser check (local, `pnpm dev`, signed in to the panel):
1. `/catalog`: three categories (ألعاب، تطبيقات، بطاقات هدايا). Add a game "ببجي موبايل" / "PUBG Mobile", slug `pubg-mobile`, in ألعاب. It is created paused.
2. Try to activate it: refused, "ينقصها: صورة الغلاف". Upload a cover and an ID guide; pick accent `#F2A900` (accepted, ratio against the dark surface shown) and then a very dark color such as `#102020` (refused with its ratio).
3. "الباقات": add a direct product "60 UC" (amount 60, official price $0.99). Activate the game: refused, "ينقصها: حقل إدخال مطلوب". Add the field `player_id` "معرّف اللاعب" (digits, 5–15, required). Activate: done.
4. Add "325 UC" and "660 UC", reorder them, pause one, archive one and restore it. The availability column says "غير متوفرة: لا مورد مرتبط".
5. Add a game "آيتونز" in بطاقات هدايا with a code product "بطاقة 10$" (region "الولايات المتحدة", redemption instructions); max quantity shows 10.
6. `/pricing`: the global rule shows 10%، $0.00، حد أدنى $0.10. The calculator with cost $0.89 shows $0.99 (margin $0.10), with $8.50 shows $9.35, both with the SYP price at the current rate.
7. Set a rule for ألعاب at 12% with a $0.15 minimum: re-authentication first. Preview "60 UC" at cost $0.89: $1.04, the rule shown as coming from the category, no savings against $0.99 ("لا توفير"). Set a product rule on "60 UC" at 5% with a $0.05 minimum: $0.94, savings 5%.
8. Archive the product rule: the category rule applies again. Try to archive the global rule: refused.
9. Archive the category ألعاب: refused while PUBG Mobile is in it.
10. The audit log shows every change above, the rules with before/after values.

Tests:
- API, every route: success, 401, a customer session on admin routes, every error code above, re-authentication on rule routes, `no-store` on admin responses, the public image route's headers and its refusal of non-catalog files.
- Catalog rules: CT1–CT8 and CT10 each allowed and refused (restore under an archived parent, archive a non-empty category, activation without cover or required field, the last required field, kind and key immutability, limits, reorder with a wrong set, slug reuse after archive).
- Concurrency (real PostgreSQL): two rule sets for the same target in parallel leave one live rule (unique index), two reorders of one game serialize to a consistent order, two creations with the same name leave one.
- Database: the partial unique indexes, the checks (whole cents, bounds, `target_id` null only for global, code-only fields), the seeds (three categories, the global rule), the new file kind.
- Unit (contracts, 100% coverage): PR3 across boundaries (1 unit, sub-cent costs, exact cents, the minimum governing and not, 0% and 100%, large costs), PR4–PR5 with the boundary at exactly the minimum, PR2 resolution order, PR7 rounding and thresholds, `contrastRatio` against known WCAG pairs, the schemas' bounds.
- E2E with RTL screenshots (admin, light and dark): `/catalog` with games and empty, the game page tabs (data with the contrast readout, fields, products with the archived filter, pricing), the categories dialog, `/pricing` with the preview, the re-authentication dialog on a rule save.

## Implementation notes
- Suggested split, each leaving `main` green:
  1. Contracts (`catalog.ts`, `pricing.ts`, errors, audit), db (tables, seeds, file kind), the `catalog` and `pricing` API modules with the image routes, OpenAPI and the admin client.
  2. Admin screens (`/catalog`, game pages, `/pricing`) with E2E and screenshots.
- Module layering: `pricing` sits above `catalog` (it calls `CatalogService` for a product's path and target checks) and `rates`; `catalog` never imports `pricing`. S07's `suppliers` module will call `PricingService` to compute and store prices.
- Update `docs/architecture.md` (the `catalog` and `pricing` rows, "built so far"), the admin navigation, and the `files` row (catalog images).
- Settled in implementation (PR 1):
  - Lists: `archived=true` lists archived rows only; the default lists unarchived ones. Games are ordered by category, then their order.
  - `CATALOG_NOT_EMPTY` names the games left in `details.games` (`id`, `nameAr`).
  - Reorder audit entries name the parent: the category for games, the game for fields and products, the first category of the new order for categories.
  - A field's `key` appears in audit details as `identifier` (the audit contract refuses any detail key that looks like a secret, `key` included).
  - The preview's margin percent is `marginBp`, the margin in basis points of the price, rounded down; `ruleScope` and `ruleId` are null for draft values.
  - Setting a rule to the values it already has writes nothing (no audit entry).
  - Image previews in the panel come from the admin host: nginx proxies `/api/catalog/images/<id>` there too (the panel's CSP allows its own host only).
