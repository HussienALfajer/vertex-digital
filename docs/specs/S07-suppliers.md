# S07 — Suppliers, product mapping and price sync (F09)

Status: Approved · Date: 2026-10-08 · Scope: `docs/product/v1-scope.md` §F09 (A06, A07, A08; with §F10 and §F08 CT9) · ADRs: 0003, 0004, 0005, 0008, 0011, 0016, 0019, 0020, 0021

## Summary
S06 built the catalog and the price math, but nothing has a cost, so everything is out of stock. S07 connects the suppliers: their encrypted keys, their offers and costs read every 15 minutes, bulk import of offers into paused products, the mapping of each product to one route per supplier with its input fields, and the stored prices that follow the cheapest usable route. Large cost changes wait in a review queue, the margin guard pauses products that would sell at a loss, supplier health and balances are watched with Telegram alerts, and each supplier can be paused. It is built and accepted with the `fake` and `manual` suppliers; the SHOP2TOPUP and WDGZone adapters follow in their own PRs once their documentation arrives (Q12, ADR 0021).

## In scope / out of scope
- In:
  - Suppliers: the four rows (`shop2topup`, `wdgzone`, `manual`, `fake`), credentials entered in the panel and stored encrypted (AES-256-GCM), a per-supplier switch, a low-balance threshold, health state with history, balance reads.
  - Offers: read by sync (A06) every 15 minutes and on demand, with cost history; manual offers created by the admin with a cost.
  - Routes (mapping): one route per supplier per product, with priority, enable switch and input field mapping; bulk import of offers into paused products.
  - Prices: stored with their history, repriced on cost, route, mapping, switch, health, staleness and rule changes (PR9), the review queue for cost changes above 10%, the margin guard's pauses, and real availability (CT9).
  - Health (A08) and balances (A07) with Telegram messages; the sync summary message; new lines in the daily summary.
  - The ADR 0003 rule refusing a display step that adds more than 2% to the cheapest available product (S03, S06 deferred it here).
  - The `fake` adapter's catalog scripting and a dev CLI for it; the supplier policy settings page.
- Out (later or never):
  - The `shop2topup` and `wdgzone` adapters: one PR each through `/supplier-adapter` when the owner shares their documentation (Q12, ADR 0021). Their credential fields below are provisional and may be renamed by that PR.
  - Orders, routing an order, fulfilment attempts, the supplier webhook endpoint and its events, polling, cost of goods: S08 (F11). S08 records its order calls into `supplier_calls`, so they count toward health.
  - Player validation, its cache and quota display: S09 (F13), through the same adapters and `supplier_calls`.
  - Showing service status and measured delivery times on the store: S09 (F12), from the health and availability built here.
  - Recording supplier funding in the ledger and reconciling it: S13 (F20) (owner, 2026-10-08).
  - Live calls in tests or CI: never. A live call happens only from the owner's own panel action with their real keys, or the `/supplier-adapter` smoke test.

## Access
| Action | Route kind | Who |
|---|---|---|
| Read suppliers, offers, sync runs, health, balances, routes, prices, price history, reviews, the policy | Admin | The admin |
| Set or replace a supplier's credentials; change the supplier policy or a supplier's low-balance threshold | Admin, re-authentication | The admin |
| Pause or resume a supplier (the S05 switch) | Admin, re-authentication | The admin |
| Request a sync now | Admin, rate limited (1 per minute per supplier) | The admin |
| Import offers; create, edit, enable, disable, archive or restore a route; create a manual route | Admin | The admin |
| Set a manual offer's cost | Admin, re-authentication | The admin |
| Accept or pause from a review (one or several) | Admin | The admin |
| Adjust the margin from a review | Admin, re-authentication (it sets a margin rule, S06) | The admin |
| Sync, balances, health, repricing, messages | Worker jobs | System |

Customers reach nothing new in S07: S09 reads availability and prices for the store.

## Data
New tables are owned by the api `suppliers` module (stored prices and reviews by `pricing`). Business tables have `id`, `created_at`, `updated_at`, `archived_at`; append-only tables have `id` (UUIDv7), `created_at` and no update or delete grant for the app role (ADR 0014). Money is USD units (micro-dollars, ADR 0003); every cost is > 0 and ≤ $10,000.

### Contracts (`suppliers.ts`, new; `pricing.ts`, `catalog.ts`, `settings.ts`, `telegram.ts` extended)
- `SUPPLIER_CODES` (`shop2topup`, `wdgzone`, `manual`, `fake`); `SUPPLIER_HEALTH_STATES` (`healthy`, `degraded`, `down`); `SUPPLIER_CALL_OPERATIONS` (`list_offers`, `get_balance`, `validate_player`, `place_order`, `get_order`); `SUPPLIER_CALL_RESULTS` (`ok`, `refused`, `error`): `ok` answered, `refused` a definitive refusal (the supplier is working), `error` no trustworthy answer (timeout, connection, 5xx, unreadable reply, `unknown` order outcome).
- `SUPPLIER_CREDENTIAL_FIELDS`: per code, the named secret fields the panel asks for. Provisional: `shop2topup` `apiKey` (the `<keyId>.<secret>` token, ADR 0005) and `webhookSecret`; `wdgzone` `apiKey` and `webhookSecret`; `fake` `webhookSecret`; `manual` none.
- `SYNC_RUN_TRIGGERS` (`schedule`, `admin`); `SYNC_RUN_STATUSES` (`running`, `succeeded`, `failed`); `PRICE_CHANGE_CAUSES` (`cost_sync`, `route_change`, `rule_change`, `review_accepted`, `margin_adjusted`); `PRICE_REVIEW_STATUSES` (`open`, `accepted`, `margin_adjusted`, `paused`, `superseded`).
- Pure functions (100% coverage): `supplierHealth(window, policy, previous)` (H1–H5), `routeUsability(route, facts, now, policy)` (RT4), `priceBasis(routes)` (P1), `needsReview(basisCostThen, costNow, thresholdBp)` (P3), `productAvailability` extended with routes and price (P6), `displayStepAllowed(stepUnits, rate, cheapestPriceUnits)` (P9). Schemas for every request and response below.
- `STORE_SWITCHES` gains `shop2topup_paused`, `wdgzone_paused`, `manual_paused` (default `false`), as S05 planned.
- Error codes: `SUPPLIER_NOT_CONFIGURED`, `SUPPLIER_UNAVAILABLE`, `OFFER_ALREADY_MAPPED`, `ROUTE_EXISTS`, `ROUTE_KIND_MISMATCH`, `ROUTE_FIELDS_UNMAPPED` (`details.fields`), `OFFER_MISSING`, `REVIEW_CLOSED`, `REVIEW_STALE` (`details.proposedPriceUsdUnits`), `DISPLAY_STEP_TOO_LARGE` (`details.maxStepSypUnits`). Each with its Arabic text in the panel.
- Audit entity types `supplier`, `supplier_policy`, `supplier_offer`, `product_route`, `price_review`; actions in "Audit and notifications".

### `suppliers` (new; business table, never archived)
- `code` enum `supplier_code`, unique; `name_ar` text 1–40 (seeded: "SHOP2TOPUP"، "WDGZone"، "يدوي"، "مورد تجريبي"); `low_balance_usd_units` bigint, whole cents, $0–$100,000, default $50 (A07; ignored for `manual`).
- Seeded by a custom migration with the four rows. Base URLs are not stored: they live in each adapter (ADR 0021).

### `supplier_credentials` (new; append-only; the newest row per supplier is in force)
- `supplier_id` FK; `ciphertext` bytea (AES-256-GCM of the JSON of the credential fields; random 96-bit IV; key `SUPPLIER_KEYS_SECRET`, 32 bytes base64, in the api and worker environments; the supplier id as associated data, so a ciphertext cannot be moved to another supplier; a key-version prefix for rotation); `hints` jsonb (per field, the last 4 characters only, for the masked display); `admin_id` uuid (no FK).
- Index `(supplier_id, created_at desc)`. The API never returns ciphertext or values.

### `supplier_offers` (new; business table, mirror of the supplier's catalog)
- `supplier_id` FK; `offer_id` text 1–128 (the supplier's id; for `manual`, a UUID the API generates); unique `(supplier_id, offer_id)`.
- `name` text ≤ 200 (the supplier's name, shown as received, as text); `group_name` text nullable ≤ 200 (the supplier's game or category, for filters); `kind` enum `product_kind` nullable (`direct` or `code` when the supplier says); `required_fields` text[] nullable (the supplier's own field names; null when the supplier does not publish them).
- `cost_usd_units` bigint nullable (null: no usable cost, e.g. another currency or an unreadable price; the raw value is kept in `cost_raw` text ≤ 64 for the admin); `in_stock` boolean.
- `cost_confirmed_at` timestamptz nullable (the last successful sync that listed the offer with a valid cost; for `manual`, when the admin set it); `last_seen_at`; `missing_since` timestamptz nullable (set when a successful sync no longer lists it).
- Index `(supplier_id, group_name)`, `(supplier_id, missing_since)`.

### `supplier_cost_changes` (new; append-only)
- `offer_id` uuid FK `supplier_offers`; `from_usd_units`, `to_usd_units` bigint nullable; `sync_run_id` uuid nullable (null for a manual cost set); `admin_id` uuid nullable. Index `(offer_id, created_at desc)`.

### `supplier_sync_runs` (new; business table, updated only from `running` to its end)
- `supplier_id` FK; `trigger` enum; `status` enum; `started_at`, `finished_at`; counts `offers_seen`, `offers_new`, `costs_changed`, `offers_missing`, `reviews_opened`, `products_repriced`; `error_code` text nullable, `error_message` text nullable ≤ 500 (sanitized: never credentials, URLs with keys or raw bodies).
- Partial unique index `(supplier_id) where status = 'running'`: one run at a time per supplier. Index `(supplier_id, started_at desc)`.

### `supplier_calls` (new; append-only)
- `supplier_id` FK; `operation` enum; `result` enum; `latency_ms` int ≥ 0; `supplier_code` text nullable ≤ 64 (the supplier's error code, never a message with player data). Index `(supplier_id, created_at desc)`.
- Written for every adapter call by the worker and the API (S07: sync, balance, probe; S08: orders and polls; S09: validation).

### `supplier_health_changes` (new; append-only; the newest row per supplier is its state; no row: `healthy`)
- `supplier_id` FK; `state` enum; `reason` text ≤ 200 (e.g. `success 42% < 50%`, `3 consecutive errors`, `probe ok`); window figures `calls`, `success_bp`, `p90_ms` nullable.

### `supplier_balance_reads` (new; append-only)
- `supplier_id` FK; `currency` enum; `amount_units` bigint (may be negative if the supplier reports credit); index `(supplier_id, created_at desc)`.

### `supplier_policy` (new; append-only; the newest row is in force; seeded with the defaults)
- `price_review_threshold_bp` int 100–5,000 (default 1,000 = 10%); `cost_stale_minutes` int 30–1,440 (default 120); `health_window_minutes` int 5–240 (30); `health_min_calls` int 1–100 (5); `degraded_success_bp` int (9,000); `degraded_p90_ms` int 1,000–120,000 (10,000); `down_success_bp` int (5,000, below `degraded_success_bp`); `down_consecutive_errors` int 1–20 (3); `probe_after_minutes` int 1–120 (10); `admin_id` uuid nullable (null for the seed).

### `product_routes` (new; business table; owner `suppliers`)
- `product_id` uuid FK `catalog_products`; `supplier_id` FK; `offer_id` uuid FK `supplier_offers`; `priority` int 1–9 (default 1; a tie-break only, RT6); `enabled` boolean (default `true`); `field_map` jsonb (`{ "<supplier field>": "<input field key>" }`, at most 10 entries).
- Partial unique indexes among unarchived rows: `(product_id, supplier_id)` (one route per supplier per product) and `(offer_id)` (an offer serves one product). Index `(product_id)`.

### `product_prices` (new; append-only; owner `pricing`; the newest row per product is its price)
- `product_id` FK; `price_usd_units` bigint, whole cents, > 0; `cost_usd_units` bigint (the basis cost); `route_id` uuid (the basis route); `rule_id` uuid and the rule values used (`percent_bp`, `fixed_usd_units`, `min_margin_usd_units`); `cause` enum; `review_id` uuid nullable. Index `(product_id, created_at desc)`.

### `price_reviews` (new; business table; owner `pricing`)
- `product_id` FK; `route_id`; `cost_before_usd_units` (the cost the current price was built on), `cost_after_usd_units`; `change_bp` int (signed); `price_before_usd_units`, `proposed_price_usd_units`; `status` enum; `decided_at`, `admin_id` nullable.
- Partial unique index `(product_id) where status = 'open'`: one open review per product.

## States and rules

### Suppliers and credentials
- SP1. A supplier is **configured** when it needs no credentials (`manual`) or has a credentials row, and **available** when the running app has its adapter: `manual` always; `fake` only when `SUPPLIER_FAKE_ENABLED=true`, which the api and worker refuse to start with in production; `shop2topup` and `wdgzone` once their adapter PRs land. An unavailable supplier shows "المحوّل غير جاهز" and its routes are unusable.
- SP2. Setting credentials writes a new `supplier_credentials` row (all fields of that supplier, each 1–500 characters, trimmed) and enqueues an `admin` sync, which is the connection test: its run reports success or the error code. Credentials are never returned, logged, put in jobs, audit details or Sentry; the panel shows the hints only ("…a1b2").
- SP3. The supplier switch (`<code>_paused`) uses the S05 write path (re-authentication, history, `switch_changed` Telegram notice). A paused supplier is still synced and its balance read; its routes are unusable (RT4).

### Sync (A06)
- SY1. The schedule enqueues `suppliers.sync` for each configured, available supplier with the catalog capability every 15 minutes (ADR 0021); `POST …/sync` enqueues one with trigger `admin`. A run that finds another `running` (the partial unique index) ends at once without a row. A run left `running` by a crash for over 10 minutes is closed as `failed` (`error_code` `ABANDONED`) by the next run.
- SY2. A run calls `listOffers` once and records the call. Each offer is checked: a cost in USD, > 0 and ≤ $10,000, parsed exactly, or `cost_usd_units` null with `cost_raw` kept.
- SY3. **Suspicious catalog:** when the list is empty, or would mark more than half of the supplier's mapped offers missing at once, the run fails with `CATALOG_SUSPICIOUS` and changes nothing. A run that fails changes nothing.
- SY4. A successful run, in one transaction: upserts every listed offer (name, group, kind, required fields, stock, cost; `last_seen_at` and, with a valid cost, `cost_confirmed_at` set to the run's start; `missing_since` cleared); sets `missing_since` on offers no longer listed; appends a `supplier_cost_changes` row per changed cost; then reprices every product with a route on a changed offer (P2) and closes the run with its counts.
- SY5. A cost is **stale** when `cost_confirmed_at` is older than `cost_stale_minutes` (2 hours). Manual offers never go stale. The health job reprices products whose basis route went stale (P2, cause `route_change`).

### Routes (mapping)
- RT1. A route links one product to one offer of one supplier. A product has at most one unarchived route per supplier (`ROUTE_EXISTS`) and an offer serves at most one product (`OFFER_ALREADY_MAPPED`, naming it).
- RT2. When the offer's `kind` is known it must match the product's kind (`ROUTE_KIND_MISMATCH`).
- RT3. **Fields:** `field_map` maps supplier field names to unarchived input field keys of the product's game. When the offer's `required_fields` is known, a route can be enabled only when each one is mapped (`ROUTE_FIELDS_UNMAPPED` lists the missing ones); when it is not known, the panel marks the route "المتطلبات غير معروفة" and the admin maps by the supplier's documentation. A field archived later makes the route unusable until it is remapped.
- RT4. **Usable route:** unarchived and enabled; the supplier available, configured, not paused and not `down`; the offer not missing, in stock, with a known cost that is not stale; the fields complete (RT3); and the supplier's newest balance, when it reports one, at least the offer's cost.
- RT5. **Tiers** (ADR 0021): healthy automatic routes, then degraded automatic routes, then the manual route. The manual supplier is used only when no automatic route is usable.
- RT6. Within a tier, routes are ordered by cost, then `priority`, then supplier code. S08's router follows the same order and skips routes unprofitable for the price paid (PR5).
- RT7. **Manual routes:** "إضافة مسار يدوي" creates a manual offer (name = the product's name, kind = the product's, no fields required) with a cost the admin enters, and its route, in one transaction. Changing that cost needs re-authentication, appends a `supplier_cost_changes` row and reprices at once (an admin entry is not reviewed).
- RT8. **Import:** from a supplier's offers the admin selects up to 100 unmapped offers and one game, and gives per offer a name (prefilled with the supplier's name, 1–60) and, when the offer's kind is unknown, a kind for the batch; plus one field map for the batch. In one transaction the API creates the products (status `paused`, defaults of S06, `CATALOG_LIMIT_REACHED` past 100 per game, `NAME_TAKEN` per row), their enabled routes and their prices. All or nothing; the response lists per-row errors when refused. The admin reviews the names and resumes the products (CT4).

### Prices (with F10)
- P1. **Basis:** a product's basis route is the first usable route by RT5–RT6; its price is `priceFromCost(basis cost, resolved rule)` (PR3).
- P2. **Repricing** runs for given products in one transaction, locking them in id order (`FOR UPDATE` on `catalog_products`). For each product, it computes the target price from P1. If the target equals the current price, nothing is written. Otherwise:
  - with an open review, the price is not changed: the review's `cost_after` and proposed price are refreshed to the target;
  - else, if the cause is a sync and P3 says review, a review is opened and the price is kept;
  - else a `product_prices` row is appended with the cause.
  A product with no usable route keeps its last price row; it is simply unavailable (P6).
- P3. **Review threshold** (ADR 0021): a sync change needs review when the basis route is the same route the current price was built on and `|cost now − cost of the current price| × 10,000 > threshold_bp × cost of the current price` (more than 10% either way, measured against the cost the price was built on, so small steps cannot add up unseen). A different basis route (a switch, a recovery, a new mapping) and a product's first price apply at once.
- P4. **Review decisions:** `accept` recomputes the target; when it differs from the proposed price the admin saw it is refused with `REVIEW_STALE` and the new figure, else a price row (`review_accepted`) is appended and the review closed. `pause` sets the product `paused` (CT4) and closes the review with the price unchanged. `adjust margin` sets a product margin rule (S06 PR9, re-authentication) and accepts in the same transaction (`margin_adjusted`). A decided review answers `REVIEW_CLOSED`. Several reviews can be accepted at once; each is decided on its own and the response lists the result per review.
- P5. **Rule changes** (S06 PR9) reprice every product the rule governs in the same transaction, with cause `rule_change`; products with an open review get their proposal refreshed instead.
- P6. **Availability** (CT9, ADR 0020), in order: `hidden`; `paused`; `out_of_stock` when the product has no current price or no usable route; `paused_by_margin_guard` when no usable route is profitable for the current price (`price − cost ≥ minimum margin` under the product's rule, PR5), which happens only while a review holds a price; otherwise `available`. Derived on read, never stored.
- P7. Price changes never touch orders already created: an `awaiting_balance` order keeps its price, and a purchase at a changed price is refused with `PRICE_CHANGED` (ADR 0004, S08).
- P8. Every price row is a whole cent and at least cost plus the minimum margin (PR3, PR4); a database check enforces whole cents and `price > cost`.
- P9. **Display step** (ADR 0003, S03 FX3): setting the exchange rate or the display step is refused with `DISPLAY_STEP_TOO_LARGE` when the step exceeds 2% of the SYP value (`usdToSyp(price, rate, 'down')`) of the cheapest available product. With no available product only FX3's bounds apply.

### Health (A08) and balances (A07)
- H1. The health job runs every minute per available supplier other than `manual` (always `healthy`), over the calls of the last `health_window_minutes`: success = (`ok` + `refused`) ÷ calls; p90 latency over all operations but `list_offers`.
- H2. `down` when the last `down_consecutive_errors` calls are all `error`, or, with at least `health_min_calls` calls, success < `down_success_bp`. `degraded` when, with at least `health_min_calls` calls, success < `degraded_success_bp` or p90 > `degraded_p90_ms`. Otherwise `healthy`; with fewer calls than the minimum and no consecutive errors, the state stays as it was.
- H3. **Probe:** `probe_after_minutes` after entering `down`, the job calls `getBalance` (or `listOffers` without the balance capability). Success makes it `degraded`; it becomes `healthy` only when the calls since the probe meet H2 with at least the minimum count. Failure keeps it `down` and the next probe waits again.
- H4. A state change appends a `supplier_health_changes` row, reprices the products routed to that supplier (cause `route_change`) and sends a `supplier_health` Telegram message. A paused supplier's health is still computed.
- H5. The balance job reads every configured, available supplier with the balance capability every 5 minutes and appends `supplier_balance_reads`. Below its threshold for the first time: a `supplier_balance_low` message; every 6 hours while it stays below, again; back at or above: a recovery message (dedupe keys `balance:<supplier>:<since>` and `…:<n>`). A balance below an offer's cost makes the route unusable (RT4) and reprices.

## Money flows
None (owner, 2026-10-08). S07 stores costs and prices; it posts no journal. Supplier funding is recorded with reconciliation (S13); cost of goods is posted by S08 when an attempt is delivered (ADR 0004).

## API
All admin responses `Cache-Control: no-store`; lists follow ADR 0011 (`page`, `pageSize`). `:code` is a `supplier_code`.

| Method and path | Access | Request | Response | Error codes |
|---|---|---|---|---|
| `GET /api/admin/suppliers` | Admin | — | `supplierSummarySchema[]` (name, available, configured, paused, health, newest balance and threshold, last run, offer and mapped counts) | — |
| `GET /api/admin/suppliers/:code` | Admin | — | `supplierDetailSchema` (credential hints and date, health history 20, balance history 20) | `NOT_FOUND` |
| `PUT /api/admin/suppliers/:code/credentials` | Admin, re-authentication | `setSupplierCredentialsSchema` (that supplier's fields) | `supplierDetailSchema` | `REAUTHENTICATION_REQUIRED`, `VALIDATION_FAILED`, `NOT_FOUND` |
| `PATCH /api/admin/suppliers/:code` | Admin, re-authentication | `updateSupplierSchema` (`lowBalanceUsdUnits`) | `supplierDetailSchema` | `REAUTHENTICATION_REQUIRED`, `VALIDATION_FAILED` |
| `POST /api/admin/suppliers/:code/sync` | Admin, 1 per minute | — | `202` `syncRunSchema` or the running one | `SUPPLIER_NOT_CONFIGURED`, `SUPPLIER_UNAVAILABLE`, `RATE_LIMITED` |
| `GET /api/admin/suppliers/:code/runs` | Admin | page | paged `syncRunSchema` | — |
| `GET /api/admin/suppliers/:code/offers` | Admin | `offerListQuerySchema` (`q?`, `group?`, `mapped?`, `missing?`, `inStock?`, page) | paged `supplierOfferSchema` (with the mapped product) | `VALIDATION_FAILED` |
| `GET /api/admin/suppliers/offers/:id/costs` | Admin | page | paged cost changes | `NOT_FOUND` |
| `POST /api/admin/suppliers/:code/import` | Admin | `importOffersSchema` (`gameId`, `kind?`, `fieldMap`, rows `{ offerId, nameAr }` 1–100) | `201` `{ products }` | `OFFER_ALREADY_MAPPED`, `ROUTE_KIND_MISMATCH`, `ROUTE_FIELDS_UNMAPPED`, `NAME_TAKEN`, `CATALOG_LIMIT_REACHED`, `PARENT_ARCHIVED`, `NOT_FOUND` (each with `details.rows`) |
| `GET /api/admin/catalog/products/:id/routes` | Admin | — | `productRoutingSchema` (routes with usability and reason, tier, basis, current price, open review, availability) | `NOT_FOUND` |
| `POST /api/admin/catalog/products/:id/routes` | Admin | `createRouteSchema` (`offerId`, `priority?`, `fieldMap`) | `201` `productRoutingSchema` | `ROUTE_EXISTS`, `OFFER_ALREADY_MAPPED`, `ROUTE_KIND_MISMATCH`, `ROUTE_FIELDS_UNMAPPED`, `OFFER_MISSING`, `NOT_FOUND` |
| `POST /api/admin/catalog/products/:id/routes/manual` | Admin, re-authentication | `createManualRouteSchema` (`costUsdUnits`) | `201` `productRoutingSchema` | `ROUTE_EXISTS`, `REAUTHENTICATION_REQUIRED` |
| `PATCH /api/admin/routes/:id` | Admin | `updateRouteSchema` (`priority`, `enabled`, `fieldMap`) | `productRoutingSchema` | `ROUTE_FIELDS_UNMAPPED`, `NOT_FOUND` |
| `POST /api/admin/routes/:id/archive` · `/restore` | Admin | — | `productRoutingSchema` | `ROUTE_EXISTS`, `OFFER_ALREADY_MAPPED`, `NOT_FOUND` |
| `PUT /api/admin/routes/:id/manual-cost` | Admin, re-authentication | `{ costUsdUnits }` | `productRoutingSchema` | `REAUTHENTICATION_REQUIRED`, `VALIDATION_FAILED`, `NOT_FOUND` |
| `GET /api/admin/catalog/products/:id/prices` | Admin | page | paged `productPriceSchema` | `NOT_FOUND` |
| `GET /api/admin/pricing/reviews` | Admin | `status?` (default `open`), `supplier?`, page | paged `priceReviewSchema` (product, game, supplier, costs, change, prices, margin) | — |
| `POST /api/admin/pricing/reviews/decide` | Admin | `{ decisions: [{ reviewId, action: 'accept' \| 'pause', expectedPriceUsdUnits? }] }` 1–100 | per review `{ reviewId, result, errorCode? }` | `VALIDATION_FAILED` |
| `POST /api/admin/pricing/reviews/:id/adjust-margin` | Admin, re-authentication | `marginRuleValuesSchema` | `priceReviewSchema` | `REVIEW_CLOSED`, `REAUTHENTICATION_REQUIRED` |
| `GET` · `PUT /api/admin/suppliers/policy` | Admin; `PUT` re-authentication | `supplierPolicySchema` | `supplierPolicySchema` | `REAUTHENTICATION_REQUIRED`, `VALIDATION_FAILED` |
| `GET /api/admin/catalog/games/:id` (S06) | Admin | — | adds per product the current price, basis supplier and availability | — |
| `PUT /api/admin/rates` (S03) | Admin, re-authentication | unchanged | unchanged | adds `DISPLAY_STEP_TOO_LARGE` |

The switches (`/api/admin/switches`, S05) take the three new values unchanged.

## Jobs and integrations
Queues in `packages/contracts` `QUEUES`; payloads carry ids only.
- `suppliers.sync` (`stately` per supplier; payload `{ supplierId, trigger }`): SY1–SY4. Retries: none; the next schedule tries again. Safe twice: the running-run index and upserts by `(supplier_id, offer_id)`.
- `suppliers.sync-schedule` (every 15 minutes): enqueues `suppliers.sync` per eligible supplier.
- `suppliers.balances` (every 5 minutes): H5.
- `suppliers.health` (every minute): H1–H4 and SY5's stale repricing. Safe twice: a state is written only when it differs from the newest row.
- Sync summary (owner, 2026-10-08): after a run that opened reviews, put products into `paused_by_margin_guard`, or found mapped offers missing, one `supplier_sync_summary` message: "مزامنة WDGZone: 3 تغييرات أسعار للمراجعة، باقتان أوقفهما حارس الهامش، عرض مربوط اختفى" with a link to the panel. Dedupe key `sync:<runId>`.
- Telegram (S05 write path, `telegram_messages`): new kinds `supplier_sync_summary`, `supplier_health` ("⚠️ WDGZone متراجع: نجاح 82%" / "⛔ … متوقف" / "✅ … عاد سليماً"), `supplier_balance_low` (and its recovery), `supplier_sync_failing` (after 3 consecutive failed runs, then once when costs go stale: "أسعار SHOP2TOPUP قديمة: 14 باقة غير متوفرة"). The daily summary (AL3) adds open reviews, products paused by the guard, suppliers not healthy and balances below threshold.
- Supplier calls: through the registry (`SupplierRegistry.get(code, credentials)`), credentials decrypted in memory per call, every call recorded in `supplier_calls`; adapters per ADR 0005. No call from the API in S07.
- `fake` supplier scripting (development and E2E only): its catalog grows to about ten offers with groups (PUBG Mobile, Free Fire, iTunes), kinds and required fields; the worker reads overrides from a git-ignored JSON file (`FAKE_SUPPLIER_STATE_FILE`) written by a dev CLI: `pnpm --filter @vertex-digital/worker supplier:fake --cost <offer> <usd> | --stock <offer> on|off | --remove <offer> | --fail-sync on|off | --errors on|off | --balance <usd>`.

## Screens
Admin only (Arabic, RTL, light and dark). Navigation adds "الموردون" (`/suppliers`) and, under "التسعير", "مراجعة الأسعار" with the open count.

- **`/suppliers`:** a card per supplier: name, chips (متاح / المحوّل غير جاهز، غير مهيّأ، موقوف، سليم / متراجع / متوقف), balance with "تحت الحد" when low and its read time, the last sync (time, result, counts), offers and mapped counts; "مزامنة الآن". `fake` is shown only when enabled. Loading skeletons; error with retry.
- **`/suppliers/$code`** tabs:
  - "الاتصال": the credential fields with hints and date, "تعيين المفاتيح" (form of empty password fields, re-authentication), then the result of the connection test (the sync run) live; the pause switch (the S05 dialog); the low-balance threshold.
  - "العروض": table (name, group, kind, cost with its freshness, stock, mapped product or "غير مربوط", missing since), filters and search, cost history per offer; select offers → "استيراد إلى لعبة" dialog (game, kind when unknown, field map from the supplier's required fields to the game's fields, editable names), with per-row errors shown in place. Empty: "لا عروض بعد: شغّل المزامنة". `manual`: the manual offers with their products.
  - "المزامنة": runs with trigger, duration, counts, error.
  - "الصحة": state and why, the window figures, history of changes, balance history.
- **Game page, "الباقات" (S06):** price (USD and SYP), basis supplier, availability with its reason ("غير متوفرة: لا مسار صالح"، "موقوفة بحارس الهامش"، "بانتظار مراجعة السعر"); per product "المسارات" opens a drawer: routes in tier order with usability and reason ("السعر قديم"، "المورد متوقف"، "الحقول ناقصة"…), the basis marked, add route (supplier → offer search → field map), add manual route (cost), priority, enable, archive / restore, the price history (newest 20).
- **`/pricing/reviews`:** open reviews (product and game, supplier, cost before → after with the change %, price now → proposed, margin), select several → "قبول المحدد"; per row accept, "تعديل الهامش" (the rule form with live preview, re-authentication), pause. `REVIEW_STALE` reloads the row with its new figures. Filter by status and supplier. Empty: "لا تغييرات بانتظار المراجعة".
- **`/suppliers/policy`:** the policy fields with their defaults, re-authentication on save.
- **`/settings/rates` (S03):** the step field explains `DISPLAY_STEP_TOO_LARGE` with the largest allowed step.
- Every error shows its code's translation; forms keep their values on error.

## Audit and notifications
Admin actor, channel `admin`, in the transaction of the change:
- `supplier.credentials_set` (`{ supplier, fields, hints }`: field names and hints, never values), `supplier.updated` (threshold before/after), `supplier.sync_requested`; switch changes are S05's `store_switch.changed`.
- `supplier_policy.set` (before/after).
- `supplier_offer.manual_cost_set` (before/after).
- `product_route.created` / `.updated` / `.archived` / `.restored` (values; `field_map` keys and values); an import writes `catalog_product.created` and `product_route.created` per row and one `supplier.import` (`{ supplier, gameId, count }`).
- `price_review.accepted` / `.paused` / `.margin_adjusted` (`{ productId, priceBefore, priceAfter }`), with the S06 `margin_rule.set` for the adjustment and `catalog_product.updated` for the pause.
- System changes (sync, repricing, health, balances) are not audit entries: they live in their append-only tables (`supplier_cost_changes`, `product_prices`, `supplier_health_changes`, `supplier_balance_reads`) and the sync runs.
- Notifications: Telegram to the admin as above. None to customers.

## Abuse and fraud
| Threat | Control |
|---|---|
| Selling below cost after a supplier raises its price | Repricing in the sync's transaction; reviews keep a price only while the guard (real, current cost) allows it, otherwise `paused_by_margin_guard`; S08 checks the guard again per attempt |
| A wrong or hostile catalog (a cost dropped to near zero, an empty list) | Costs bounded and parsed exactly; changes over 10% held for review; an empty list or half the mapped offers vanishing fails the run (SY3) |
| Selling on old costs while sync is broken | Costs stale after 2 hours make the route unusable; failing syncs alert after 3 runs |
| Stolen admin session redirecting purchases or reading keys | Keys never returned or logged; changing them, the policy, switches, manual costs and margins need re-authentication and are audited; base URLs are in code, so keys cannot be sent to another host |
| A leaked database dump exposing keys | AES-256-GCM with a key only in the server environment, the supplier id as associated data |
| Draining a supplier balance | Out of S07 (no orders); the balance alert and the route exclusion below cost are ready for S08 |
| Floods of "sync now" | 1 per minute per supplier, one running run per supplier |
| Script injection through supplier text | Supplier names and groups are rendered as text only, length-bounded |
| The fake supplier reaching production | It is registered only with `SUPPLIER_FAKE_ENABLED=true`, refused at start in production |

## Edge cases
1. Two syncs of one supplier at once: the second ends without a row (SY1).
2. A rule change and a sync reprice the same product at once: the product locks serialize them; each computes from fresh data.
3. A review is open and the supplier's cost moves again: the review's proposal is refreshed; if the cost returns within 10% of the price's cost, the review stays open until decided (the admin sees no change to make; accepting writes nothing new when the target equals the current price, and closes it).
4. The basis supplier goes down while a review is open: the price stays (review); the guard checks the backup's cost against the held price; if unprofitable, `paused_by_margin_guard`.
5. A mapped offer disappears: the route is unusable ("العرض اختفى من المورد"); the next route becomes the basis at once; reported in the sync summary. If it comes back, it is usable again on the next sync.
6. An offer's cost arrives in another currency or unreadable: cost null, route unusable, `cost_raw` shown.
7. A product whose every route is unusable: unavailable with its last price kept; when a route returns, the price follows it (a route change) unless a cost change on the same route since then needs review.
8. A supplier's credentials are replaced with wrong keys: the connection test fails, syncs fail, health falls to `down`, the admin is alerted; costs go stale after 2 hours.
9. A manual route only: always the basis when nothing automatic is usable, never stale; an archived manual route keeps its offer (restoring brings it back with its cost).
10. Import partly invalid (a name taken, the game at 100 products): nothing is created; per-row errors returned.
11. A game field archived that a route maps: the route is unusable until remapped (RT3); CT3 still guards activation.
12. The global margin rule changed with thousands of products: repriced in one transaction; products with an open review only have their proposals refreshed.
13. Exchange rate or step change that would make the cheapest available product's step exceed 2%: refused with the largest allowed step.
14. No adapter yet for `shop2topup` or `wdgzone`: credentials can be stored; sync answers `SUPPLIER_UNAVAILABLE`; nothing routes to them.
15. A health window with one call: no rate rule applies; only consecutive errors can move it to `down`.

## Open questions
- Q12 (part): the SHOP2TOPUP and WDGZone accounts and API documentation are still needed before their adapter PRs. Until then S07 is built and accepted with the `fake` and `manual` suppliers. Not a blocker for S07's three PRs.

## Acceptance
The owner's browser check (local, `pnpm dev`, `SUPPLIER_FAKE_ENABLED=true`, signed in to the panel, S06 games present):
1. `/suppliers`: four suppliers; SHOP2TOPUP and WDGZone show "المحوّل غير جاهز"; the fake one "غير مهيّأ". Set its webhook secret (re-authentication): the connection test succeeds and the offers appear.
2. "العروض": filter by group "PUBG Mobile", select three offers other than `fake-uc-60`, "استيراد إلى لعبة" ببجي موبايل with `playerId` → `player_id`: three paused products, each priced by PR3 from its cost and the rule in force. Resume one: the game page shows its price, SYP price and "متوفرة".
3. Map S06's "60 UC" to `fake-uc-60` from its routes drawer; add a manual route at $1.20. The basis is the fake route; the manual one is "ملجأ أخير".
4. `supplier:fake --cost fake-uc-60 0.92` (from $0.88) then "مزامنة الآن": the price moves at once (under 10%). `--cost fake-uc-60 1.10`, sync: a review appears in `/pricing/reviews` and a Telegram summary arrives (`TELEGRAM_TRANSPORT=log`); the price stays; since $1.10 leaves the held price below the margin, the product shows "موقوفة بحارس الهامش". Accept: the new price applies and the product is available.
5. `--errors on`, then "مزامنة الآن" three times a minute apart (or wait for the balance reads): the fake supplier turns متوقف after three failed calls, with a Telegram message; "60 UC" now follows the manual route's price. `--errors off`: after the probe it returns to سليم and the price goes back.
6. `--balance 20`: the low-balance message arrives; the balance shows "تحت الحد".
7. `--remove fake-uc-325`, sync: the mapped product becomes unavailable ("العرض اختفى من المورد"), reported in the summary. `--fail-sync on`: three failed runs alert; after 2 hours (or a policy of 30 minutes) the products become unavailable with "السعر قديم".
8. Pause the fake supplier from its page: its routes are unusable at once; resume.
9. Set the display step so it exceeds 2% of the cheapest available product: refused with the largest allowed step.
10. The audit log shows the credentials (field names and hints only), the import, the routes, the manual cost, the review decisions and the policy changes.

Tests:
- Contracts (100% coverage): `supplierHealth` (each threshold, the minimum count, consecutive errors, probe states), `routeUsability` (each reason), `priceBasis` tiers and ties, `needsReview` at exactly 10% and around it, both directions, `productAvailability` with routes and held prices, `displayStepAllowed`.
- API, every route: success, 401, a customer session on admin routes, re-authentication where required, every error code above, `no-store`, credentials never in a response.
- Database: the unique indexes (one route per supplier per product, one product per offer, one open review per product, one running run), append-only grants on the new append-only tables, whole-cent price check, the seeds (four suppliers, the policy).
- Repricing (real PostgreSQL): P2 for each cause, the review hold and refresh, rule changes with open reviews, concurrent sync and rule change on one product, an import of 100 rows.
- Worker: sync (success, suspicious list, failure, stale costs, missing offers, a second concurrent run), balances (threshold crossing, 6-hour repeat, recovery), health (transitions, probe), messages with their dedupe keys; credentials never logged (a log capture test).
- Encryption: round trip, a ciphertext moved to another supplier fails, a wrong key fails.
- E2E with RTL screenshots (admin, light and dark): `/suppliers`, each supplier tab, the import dialog with an error row, the routes drawer, `/pricing/reviews` with and without reviews, the policy page.

## Implementation notes
- Suggested split, each leaving `main` green:
  1. Contracts, db (tables, enums, seeds, switches, the repricing write path in `packages/db` used by the api and the worker), the `suppliers` API module and the `pricing` additions (routes, import, reviews, policy, credentials, the step rule), OpenAPI and the admin client.
  2. Worker: registry, credential decryption, `suppliers.sync`, schedule, balances, health, messages, the daily summary lines; the fake adapter's catalog and scripting CLI.
  3. Admin screens with E2E and screenshots.
  Later, one PR per real adapter through `/supplier-adapter` (Q12).
- The adapter interface gains optional `group`, `kind` and `requiredFields` on `SupplierOffer`; existing adapters stay valid.
- Module layering: `suppliers` sits above `catalog`, `settings` and `pricing`'s pure math; the repricing write path lives in `packages/db` (like the ledger's posting function) so the worker can run it. `pricing` reads availability facts from `suppliers` through its service.
- Update `docs/architecture.md` (`suppliers` and `pricing` rows, worker jobs), `.env.example` (`SUPPLIER_FAKE_ENABLED`, `FAKE_SUPPLIER_STATE_FILE`), the commands table for the fake CLI, and `docs/deployment.md` (`SUPPLIER_KEYS_SECRET` on both api and worker).
