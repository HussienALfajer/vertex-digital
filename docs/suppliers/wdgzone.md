# WDGZone (`wdgzone`)

The automatic supplier (ADR 0005, 0031): game top-ups and vouchers. Adapter: `packages/suppliers/src/wdgzone/`.

Sources: the public documentation at https://wdgzone.tech/docs/ and its OpenAPI document (https://wdgzone.tech/api/openapi.json, "WDG Reseller API" 1.3.0), read on 2026-10-12, read-only calls to the live API with the owner's trial key on the same day (the wallet held $0, so no purchase could be charged), WDG support's written answer to Q19 on 2026-10-13 (idempotency, several fields, the delivery poll), and a read-only scan of every top-up on 2026-10-13 (S16 PR 4, "Account fields": `GET /products?type=topup` pages and one `GET /products/{id}`; nothing was bought or written). Anything these sources do not show is under "Open questions".

## Connection

| | |
|---|---|
| Base URL | `https://wdgzone.tech/api/v1/` (in code, ADR 0021) |
| Authentication | `X-API-Key: wdg_live_…` on every request. The key is tied to the WDG wallet: backend only. |
| Credentials in the panel | `apiKey` only. The webhook secret is derived from it (see "Webhooks"). |
| Content | JSON. Every reply has `request_id` and `success`; `true` with `data` (and `pagination` on lists), `false` with `error: { code, message, … }`. |
| Rate limit | 60 requests a minute per key (`X-RateLimit-Limit`, `X-RateLimit-Remaining`, `X-RateLimit-Reset` in Unix seconds); `429 RATE_LIMITED` beyond it. |
| Timeouts | 15 s per request; 30 s for a purchase (WDG reserves wallet and stock before it answers). |
| IP allowlist | None documented: the key alone authenticates. Webhooks come from addresses WDG does not publish, so nginx has no allow list for them. |
| Sandbox | The home page mentions one; the documentation does not say how to reach it. |
| Other headers seen | `X-Request-Id`, `X-Response-Time`. |

## Endpoints used

| Use | Call | Notes |
|---|---|---|
| Balance (`getBalance`) | `GET /me` | `data.balance` (JSON number, USD, e.g. `125.750`), `data.currency` (`USD`), `account_id`, `name`. |
| Catalog (`listOffers`) | `GET /products?type=topup&limit=100&page=N`, then `type=voucher` | Pages of up to 100 with `pagination: { page, limit, total, total_pages }`; a page past the end answers `data: []`. |
| Purchase (`placeOrder`) | `POST /products/{id}/purchase` with `X-Idempotency-Key` | Body `{ quantity, player_id?, <other field keys>?, callback_url? }` (see "Account fields"). `201` new order, `200` a replay of the key (`idempotent_replay: true`). |
| Poll (`getOrder`) | `GET /orders/{id}/delivery` | By WDG's own order id. `200` ready, `202` processing or a direct top-up without a code, `410` failed and refunded, `404` not found (bodies under "Status mapping"). WDG suggests every 2–5 s; the order engine polls on its own schedule (S08 rule F7). |
| Order state (`getOrder` after a `202`, S16 MF4) | `GET /orders/{id}` | `status`: `pending`, `processing`, `completed`, `refunded`, `failed`, `cancelled` (WDG support, 2026-10-13). Read for that field only (`data.status`): the rest of its body is not documented. |
| Player check (`validatePlayer`) | — | WDG does not check player ids. The capability is off; the store never asks WDG. |
| Category tree (`listCategories`, S16 SC1) | `GET /categories` | The whole active tree in one array (3,573 nodes on 2026-10-12): `id`, `parent_id`, `name`, `type`, `product_count`, `in_stock_products`, `image_url`. A `pagination` object, should WDG send one, is followed page by page within the rate limit. `manual` nodes are left out, as their products are. |
| Statement (`listTransactions`, `listOrders`, S16 SF3) | `GET /transactions?limit=50&page=N`, `GET /orders?limit=50&page=N` | Newest first. Their rows are not documented: each is read leniently (see "Statement"). |
| Platform status (`getPlatformStatus`, S16 SF5) | `GET /health` | `{ status: "operational", catalog_updated_at, time }`, read at the top or in `data`. Needs `X-API-Key` like every call: without it, `401 UNAUTHORIZED` (seen 2026-10-13). |
| Category images (`fetchImage`, S16 IM1) | the node's `image_url` | HTTPS on `wdgzone.tech` only, without the API key; redirects followed by hand, at most 3, only to `wdgzone.tech`. Any other host's URL is stored as none. |

Not used: `GET /catalog`, `/catalog/{type}/categories`, `/catalog/{type}/categories/{id}/products` (the guided tree: `SUBCATEGORY_REQUIRED` 409 until a leaf), `GET /products/{id}` (WDG names it as the place of `required_fields`; read once on 2026-10-13, it answers the same product body as `GET /products`, `required_fields` included: `fixtures/product-select.json`).

## Catalog

A product:

```json
{
  "id": 235203, "name": "60 UC", "description": null,
  "category_id": 14693, "category": "Auto", "brand": "PUBG Mobile",
  "type": "topup", "price": 0.881, "original_price": 0.881, "discount_percent": 0,
  "currency": "USD", "stock": 999999, "available": true,
  "requires_player_id": true,
  "required_fields": [{ "key": "player_id", "label": "Player ID", "type": "text" }],
  "image_url": "https://wdgzone.tech/panel/category-image.php?name=PUBG%20Mobile"
}
```

- `type`: `topup` (5,602 products on 2026-10-12), `voucher` (5,975) or `manual` (about 64,500: fulfilled by hand at WDG, often Steam gifts, some with a placeholder price of `999`). Only `topup` (kind `direct`) and `voucher` (kind `code`) are listed; `manual` is left out (V1 sells automatic delivery).
- Offer: id `String(id)`; group `brand` (the game), else `category`; name `"<category> · <name>"` when the category is neither the brand nor the name (`Auto · 60 UC`, `MENA · 110 Diamonds`), else `name`; in stock when `available` and `stock` is missing or above 0.
- `required_fields`: the account fields, each `{ key, label, type: text | select, options? }` (`select` lists `{ label, value }`). A product with `requires_player_id` and no listed field asks for `player_id`. Since S16 PR 4 a product is unsupported (`unsupported_reason = fields_unsupported`: shown in the panel, never routed or imported) only when its fields cannot be sent by MF1–MF2 ("Account fields"); the counts of the 2026-10-13 scan are there.
- S16: the offer keeps `category_id` (its leaf), `stock` (`999999` and above, or none, is unlimited), `original_price` (the price before WDG's discount) and `required_fields` as field specs (key, label, type, a select's options).
- A product that does not parse, has another currency or an unreadable price is skipped; the rest of the page is kept.
- WDG does not say how the list is sorted. A product that moves between pages while a read runs can be missed by that run (it reappears in the next one, 15 minutes later).
- A full read is about 117 requests. The adapter waits for the rate-limit window to reset whenever 20 or fewer requests are left in it, so orders keep room; a read took 85 s against the live API (two waits).

## Purchases and idempotency

- `X-Idempotency-Key` is required (`422 IDEMPOTENCY_KEY_REQUIRED` without it), up to 100 characters: the attempt id (a UUID, 36). The documentation: "Reuse the same value only when retrying the same order"; the OpenAPI document answers a replay with `200`.
- WDG support (2026-10-13): the key is checked first. A repeated key answers `200` with the existing order and `"idempotent_replay": true`, without checking balance or stock again and without charging again. The adapter reads a replay like any reply (the flag is not needed).
- Seen live: a refused request is not kept under its key; the same key may be sent again and is judged afresh. With the replay checked first, a refusal of a re-sent key means the first send made no order; the engine still applies S16 RS1 to it (the same rule for every supplier).
- One account field is sent as `player_id` whatever its key (a product whose field is `user_id` still answers `PLAYER_ID_REQUIRED` without `player_id`). `player_id` is not checked by WDG; a missing one is refused before the balance. Several fields and selects: "Account fields".
- `quantity` 1–100 per the documentation; the order engine sends 1–50.
- `callback_url`: HTTPS only. The worker sends `${STORE_URL}/api/webhooks/suppliers/wdgzone` when `STORE_URL` is HTTPS (production), nothing in development.
- Reply: `{ order_id, status, delivery_items, total }`. `status: "completed"` (any case) is delivered: codes are `delivery_items` when there are any, units the units asked. Any other status is `pending` with the order id, followed by polling.
- `delivery_items` (S16 MF4) are read as plain codes or as `{ code, pin }` objects, on the purchase reply, the poll and the webhook alike; a pin is kept in the code text as `<code> · PIN: <pin>` (no pin: the code alone). An empty code, or a text over S08's 200 characters, makes the answer `unknown`.

## Account fields

WDG support (2026-10-13): standard games take `player_id`. Products that need a user id and a server or zone id take them "separated by a delimiter in the player_id field (e.g. `USER_ID|ZONE_ID` or `12345678(1234)`), or include them as JSON keys in the body: `{"player_id": "12345678", "zone_id": "1234"}`"; the structure per product is its `required_fields`. Selects are not covered by the answer.

The owner's decisions (2026-10-13, S16 MF1–MF2), applied since S16 PR 4:
- One field: sent as `player_id`, as before.
- Several fields: every field under its own key, plus `player_id` with the account field's value (the field keyed `player_id`, else the first present of `user_id`, `uid`, `role_id`, `riot_id`, `id`). A product with several fields and none of those keys stays unsupported, and an order with several fields and none of them is refused before sending (`FIELDS_UNSUPPORTED`, ours). The delimiter form is never sent. Empty values are left out of the body.
- A field asking for a password (`password`, `pass`…) keeps the offer unsupported until the owner decides (`docs/open-questions.md` Q20), and so does a field named `quantity` or `callback_url` (the purchase body's own keys, which are always ours: no account field can replace them).
- A `select` is sent as the supplier's option `value` (never its label) under its key; the route's option map (`product_routes.option_map`, kept on the attempt) turns the customer's choice into that value. A select with fewer than 2 or more than 50 options (S06's bounds), or with an empty, repeated or over-64-character value, stays unsupported.

Read-only scan of every top-up on 2026-10-13 (57 pages of `GET /products?type=topup&limit=100`, then one `GET /products/{id}` for a select product), counted with the adapter's rules:

| | Top-ups |
|---|---|
| Listed | 5,602 |
| With a `select` field | 883 |
| With several fields (at most 3) | 1,933 |
| Supported before S16 PR 4 (one text field) | 3,669 |
| Supported from S16 PR 4 (MF1–MF2) | 4,944 (1,275 with several fields, 427 with a select) |
| Still unsupported | 658: 354 several fields without an account field (`email` and `password`, `character_id`, `account`…), 126 a select with one option, 149 a select with 51–72 options (LifeAfter, Lineage W, Lineage2M), 20 option values over 64 characters (Ragnarok Origin), 9 a password beside an account field (Q20) |

Selects within one game (rule MF3, `FIELD_OPTIONS_DIFFER`): among the supported packs, 25 game and select-key pairs, none with packs whose option values differ, so an import of a game's packs refuses no row today. Over all top-ups, 3 of 41 pairs differ: Love and Deepspace only in the labels' case (same values: no refusal), Sword of Justice and Undawn only between one-option selects (unsupported anyway). Nine more ask for an `email` and a `password` beside an account field: MF1 could send them, but they stay unsupported until the owner decides (Q20).

## Status mapping

| Answer | Outcome |
|---|---|
| Purchase `2xx`, `status` `completed` | `delivered` (`quantity` asked, codes from `delivery_items`) |
| Purchase `2xx`, any other `status` | `pending` (order id kept) |
| Poll `202` `{ data: { status: "PROCESSING", delivery_items: null } }` | followed by `GET /orders/{id}` (S16 MF4): `completed` → `delivered` without codes, `refunded` / `failed` / `cancelled` → `failed_definitive` (the status upper-cased as the code), `pending` / `processing` → `pending`, anything else or no readable reply → `unknown` |
| Poll `200` `{ data: { order_id, status: "COMPLETED", delivery_items: [{ code, pin }] } }` | `delivered` with the attempt's units, items read as codes or `{ code, pin }` (a pin as `<code> · PIN: <pin>`); `unknown` when `status` is present and not `COMPLETED` (any case), a `quantity` differs or the body does not parse (S16 MF4) |
| Poll `410` `{ success: false, data: { status: "REFUNDED" \| "FAILED" \| "CANCELLED", refunded: true } }` | `failed_definitive` with `data.status` as the code (S16 MF4), else `error.code`, else `ORDER_FAILED` |
| Poll `404 ORDER_NOT_FOUND`, `5xx`, timeout, other status | `unknown` |
| Poll without a WDG order id | `unknown`, nothing sent (an `unknown` attempt is re-sent with its key instead: S08 rule F3) |
| Webhook `order.completed` | `delivered` (`data.quantity`, codes from `data.delivery_items`, plain or `{ code, pin }`); with `refunded: true`, malformed |
| Webhook `order.failed`, `order.refunded` | `failed_definitive` (`supplierCode` the event name) |

The order engine still checks the codes: a `code` product needs one code per unit and a `direct` one none, else the attempt is `unknown` (`codes_missing`, S08 rule F1).

## Errors

Every error is `{ "success": false, "error": { "code": "…", "message": "…" } }`, sometimes with more fields (`available_stock`, `category_id`).

| HTTP | Code | Seen | On a purchase |
|---|---|---|---|
| 400 | `INVALID_JSON` | live | definitive |
| 401 | `UNAUTHORIZED` ("Missing or invalid X-API-Key") | live, docs | retryable → `unknown` (a re-send after a key change must not call a bought order failed) |
| 403 | `ACCOUNT_SUSPENDED` | docs | retryable → `unknown` |
| 404 | `PRODUCT_NOT_FOUND` | live | definitive |
| 404 | `ORDER_NOT_FOUND` | live (polls) | — (`unknown` on a poll) |
| 404 | `NOT_FOUND` ("Endpoint not found") | live, docs | retryable → `unknown` |
| 409 | `OUT_OF_STOCK` | docs | definitive (stock is reserved with the order); other 409 codes stay retryable |
| 409 | `SUBCATEGORY_REQUIRED` | live (catalog tree) | — |
| 422 | `IDEMPOTENCY_KEY_REQUIRED` | live | definitive |
| 422 | `PLAYER_ID_REQUIRED` | live | definitive (not `inputRejected`: it is our route's field map, not the customer's input) |
| 422 | `INSUFFICIENT_BALANCE` | live | definitive (the next route is tried) |
| 422 | `INVALID_REQUEST` | docs | definitive |
| 429 | `RATE_LIMITED` | docs | retryable → `unknown` |
| 5xx, timeout, unreadable body | — | — | `unknown` |
| before sending: a product id that is not WDG's digits, a key over 100 characters, several fields without an account field (S16 MF1) | `PRODUCT_NOT_FOUND`, `IDEMPOTENCY_KEY_TOO_LONG`, `FIELDS_UNSUPPORTED` (ours) | — | definitive, nothing sent |

Seen live: checks run as key, product, `player_id`, then the balance; `quantity` above 100 reached the balance check. Refusals before anything was sent (DNS, connection refused) are `unknown` too on a purchase (`outcomeOfOrderError`): the re-send with the same key settles them.

## Webhooks

- Sent to the purchase's `callback_url` when an order ends: `order.completed`, `order.failed`, `order.refunded`. Answer any `2xx` within 8 s; failures are retried up to 6 times with exponential backoff.
- Headers: `X-WDG-Event` (the event), `X-WDG-Event-ID` (a UUID, the same as the body's `id`), `X-WDG-Signature: sha256=<hex>`.
- Signature: HMAC-SHA256 of the exact raw body, hex, with the secret `sha256_hex(apiKey)` (WDG's PHP sample: `hash('sha256', getenv('WDG_API_KEY'))`). Compared in constant time.
- No signed timestamp header: the signed body's `created_at` must be within 24 hours of now (retries keep the event's time; the event id refuses replays; polling covers anything later).
- Body: `{ id, event, created_at, data: { order_id, product_id, quantity, total, currency, status, delivery_items, refunded } }`. It carries WDG's `order_id` only, never our key: the worker finds the attempt by `(supplier, supplier_order_id)` (index `fulfilment_attempts_supplier_order_id_idx`); none or more than one match is `unknown_key`. An attempt whose purchase timed out has no WDG id yet, so its webhook is kept as `unknown_key` and the re-send with the key settles it.
- Replays: the API stores each `(supplier, event id)` once (S08 rule F4).

## Refunds and money

- A failed order is refunded to the WDG wallet by WDG (`410` "Failed and refunded"); the order engine refunds the customer on `failed_definitive` as for any route.
- Prices and the balance are JSON numbers in USD with up to 3 decimals (`10.475`); read exactly into micro-dollars through `parseUsd(String(value), { subCent: true })` (the number's shortest decimal form; exponent forms, negatives, more than 6 decimals or more than 9 whole digits are refused). Prices move by a few tenths of a cent between reads (`60 UC` went 0.881 → 0.889 within minutes on 2026-10-12): the review threshold (ADR 0021) absorbs that.

## Statement (S16 SF3)

`GET /transactions` and `GET /orders` answered empty lists on the $0 trial wallet: their row shapes are not known. Each row is read on its own, and only what it carries is kept: a transaction's `id`, `type`, `amount` (signed, USD), `balance_after`, `reference` or `description`, `order_id`; an order's `id` (WDG's order id), `product_id`, `product_name` or `product`, `quantity`, `status`, `total`, `created_at`; a row in another currency keeps no amount. A row without an id is skipped. A page has a next one by `pagination`, else when it holds 50 rows. The API matches rows to our attempts by `supplier_order_id`.

Seen live on 2026-10-19 (system test F11-9, one read-only page of each list): an order row is `{ id, product_id, product_name, quantity, total_price, status, created_at, completed_at }` with `total_price` a decimal string (`"0.880"`), a transaction row `{ id, type, amount, reference_type, reference_id, description, created_at }` where a purchase names its order as `reference_type: "order"` with `reference_id` (a deposit names `"deposit"`), and there is no `balance_after`. The orders list carries `pagination { page, limit, total, total_pages }`; the transactions list none. Statement times have no zone and are WDG's own **UTC+4** (order 3940: `created_at` `2026-10-19 00:53:16`, its signed webhook `2026-10-18T20:53:23+00:00`; the same four hours on orders 3507 and 3457), so the adapter reads a zoneless WDG time as `+04:00`, never as the server's local time (Europe/Berlin), which showed every statement line two hours late. Webhook times carry their offset (`+00:00`) and are read as written. The four hours held on every row seen (2026-10-12 to 2026-10-19); if WDG's zone ever moves, the statement's times move with it while the webhook's stay right. `orders-page-live.json` and `transactions-page-live.json` hold that shape (ids, times and amounts from the live reply; names and descriptions written).

## Fixtures

`packages/suppliers/src/wdgzone/fixtures/`, sanitized: `products-*.json` and the `error-*.json` replies recorded from the live API on 2026-10-12 (request ids replaced, pages cut to a few products); `me.json` recorded with the account id, name and balance replaced; `purchase-completed.json` and `webhook-order-completed.json` from the documentation's examples with the code replaced (`TEST-CODE-0001`). Poll replies (`202`, `200`, `410`) and `GET /orders/{id}` are written in the tests from the bodies in WDG support's answer (2026-10-13). S16 PR 4: `products-topup-fields.json` holds five top-ups recorded on 2026-10-13 (Mobile Legends with a server id, Fashion Dream with a select whose values differ from its labels, and three that stay unsupported: email and password, a one-option select, a 72-option select) and `product-select.json` the `GET /products/{id}` reply of a select product (Asphalt 9: Legends), request ids replaced. Webhook signatures in tests use a test key. S16: `categories.json` is the documentation's example with a child, a `manual` node and an image on another host added; `health.json` the shape seen live on 2026-10-12; `transactions-page-1.json` and `orders-page-1.json` are synthetic (see "Statement"). `orders-page-live.json` and `transactions-page-live.json` (2026-10-19, F11-9) hold the live statement's shape: ids, times and amounts from the live reply, names and descriptions written.

## Live checks done (2026-10-12, owner's trial key, $0 wallet)

`GET /me`, `/health`, `/catalog`, `/catalog/topups/categories`, `/categories`, `/products` (both types), `/orders`, `/transactions`, `/orders/{id}` and `/orders/{id}/delivery` (not found); purchases refused on the $0 wallet (`INSUFFICIENT_BALANCE`) and before it (`IDEMPOTENCY_KEY_REQUIRED`, `PRODUCT_NOT_FOUND`, `PLAYER_ID_REQUIRED`, `INVALID_JSON`); the built adapter's `getBalance`, `listOffers` (9,644 offers in 85 s), `placeOrder` (refused, `failed_definitive`) and `getOrder` (`unknown`). Nothing was bought.

## Open questions (for WDG support, or a funded test)

1. ~~Replay order of checks~~ answered by WDG support (2026-10-13): the key first, a replay is `200` without new checks or charge ("Purchases and idempotency").
2. ~~The poll's bodies~~ answered (2026-10-13): "Status mapping". Still unknown: whether the purchase reply's and the webhook's `delivery_items` are `{ code, pin }` objects too (S16 PR 4 reads both forms everywhere).
3. ~~Purchase states~~ answered (2026-10-13): `pending`, `processing`, `completed`, `refunded`, `failed`, `cancelled`. Whether a `201` can already say `failed` is still unknown (it is followed by polling).
4. ~~Several account fields~~ answered (2026-10-13): "Account fields". Still unknown: how a `select` is sent (S16 MF2 sends its option value under its key) and the body of `GET /orders/{id}` beyond `status`. The first live order on each new kind of product (two fields, a select) is a walk-in order on the paused pack (S16 AP5) before it is activated.
5. **Webhook retries:** the backoff schedule (the adapter accepts an event up to 24 hours after its `created_at`) and whether `created_at` stays the same on retries.
6. **`order.refunded` after `order.completed`** (a voucher refunded later): when it happens. The engine treats it as a conflict for the admin (S08 rule F5).
7. **Webhook source addresses**, to add an nginx allow list.
8. **Sandbox:** its base URL and keys, for a funded test without real money.
9. **Catalog order:** the sort order of `GET /products`, so a read cannot miss a product that moves between pages.
10. **Statement and tree shapes (S16):** the rows of `GET /transactions` and `GET /orders`, and whether `GET /categories` pages. To record from read-only live calls on a funded account (owner's approval), then the fixtures replaced by sanitized recordings.
11. **Account passwords (owner, `docs/open-questions.md` Q20):** 9 top-ups ask for an `email` and a `password` beside an account field. The adapter keeps them unsupported until the owner decides.

## Web Purchase route (read 2026-10-15)

Source: the public catalog page https://wdgzone.tech/catalog/pubg-mobile-id-auto-22, read on 2026-10-15 (no key, no API call, nothing bought or written). The API itself was **not** queried: the facts about `type`, ids and `required_fields` below are unconfirmed (see "Not confirmed").

### Prices seen (USD, per pack)

| Pack | Web Purchase | Auto (our route) | Web vs Auto | Reserve | Manual | Fast |
|---|---|---|---|---|---|---|
| 60 UC | 0.877 | 0.887 | −1.1% | 0.887 | 0.905 | 0.909 |
| 325 UC | 4.385 | 4.435 | −1.1% | 4.447 | 4.472 | 4.559 |
| 660 UC | 8.618 | 8.870 | −2.8% | 8.894 | 8.739 | 9.118 |
| 1800 UC | 21.319 | 22.176 | −3.9% | 22.236 | 22.912 | 22.989 |
| 3850 UC | 41.328 | 44.295 | −6.7% | 44.295 | 44.518 | 44.944 |
| 8100 UC | 82.656 | 88.200 | −6.3% | 88.591 | 88.001 | 91.335 |

- The page groups the PUBG Mobile UC packs into five routes: Web Purchase (6 packs, names `WEB 60 UC` …), Auto (29 products, UC plus WOW coins, Prime, passes), Fast, Manual and Reserve (6 UC packs each). The savings grow with pack size, so the larger packs matter most.
- Web Purchase stock is shown as 1,000 per pack (999 for 660 UC); every other route shows 999,999. 999,999 is the adapter's "unlimited" (see "Catalog"), so 1,000 is a **real, small, finite stock**: a large order or a few orders can empty a pack.
- The page shows no product ids and says nothing about how Web Purchase works, its speed, or refunds (it only says "Instant automated delivery" for the store in general). Its images are served from `reseller.fazercards.com`, which suggests WDG resells FazerCards; unconfirmed.
- Prices move by a few tenths of a cent between reads (see "Refunds and money"): the table is one reading, not a stable spread.

### Read-only API check (2026-10-15, owner's key, `GET /products?type=topup` only)

- **No `type=topup` product of PUBG Mobile has `Web`/`Web Purchase` in its name or category**: the Web Purchase packs are **not** automatic top-ups in the API, so the adapter does not see them and the store cannot route to them today.
- The Auto packs match the page and the table above: ids 235203–235208 (60, 325, 660, 1800, 3850, 8100 UC), `category_id` 14693, `category` `Auto`, `type` `topup`, price 0.887 / 4.435 / 8.870 / 22.176 / 44.295 / 88.200, `stock` 999999, `required_fields` `player_id` (text).
- **`GET /products?type=manual` (same day, whole scan): the six packs are `type: manual`**, ids 286552–286557 (`WEB 60 UC` … `WEB 8100 UC`), `category_id` 928542, `category` `Web Purchase`, brand `PUBG Mobile`, prices and stock as in the table (stock 1000, 999 for 660 UC), `available: true`, `requires_player_id: true` but **`required_fields` empty**.
- **Conclusion:** Web Purchase is a manual product: the adapter leaves `manual` out (V1 sells automatic delivery only), the API gives no field list to build the order from, and delivery is by hand at WDG. It is **not** an automatic route for the store and the cheaper price cannot be used by the order engine as it is. The routing gap below is therefore secondary until WDG makes it automatic (question 12).

### Not confirmed

1. **API `type`:** answered above: `type=manual`, not `topup`. Their product ids, `category_id`, `category` (expected `Web Purchase`), `required_fields`, `stock` and `available`. The page lists the Manual route's UC packs too, so the page cannot tell the types apart.
2. **Delivery:** speed, success rate and refund behaviour of Web Purchase. If the packs are `type=manual`, they would be fulfilled by hand at WDG and are not an automatic route for us at all.
3. **Fields:** whether `WEB` packs ask only for `player_id` like Auto.

To settle 1 and 3 with read-only calls (owner's approval to use the supplier key needed): `GET /products?type=topup&limit=100&page=N` filtered for `brand` "PUBG Mobile" and a name or category containing `WEB`/`Web Purchase`, and the same with `type=manual`. In the admin, the supplier catalog (S16) shows them after the next sync if they are `topup`.

### Routing: can both offers map to one store product?

ADR 0005's router builds candidates from a product's enabled routes and orders them by lowest cost, then health, then delivery time, then priority; a definitive failure moves on to the next candidate, and an out-of-stock offer is not a candidate. That is exactly the wanted behaviour (cheaper Web Purchase first, Auto when it is out of stock or fails). **Gap:** `product_routes` has a unique index on `(product_id, supplier_id)` among live rows (`packages/db/src/schema/suppliers.ts:472`), so a product can have **one route per supplier**: a second WDGZone offer cannot be mapped to the same product. Other consequences to decide before any change:
- Health is per supplier (ADR 0005), so Web Purchase failures and Auto failures would share one health score.
- The `supplier_offers_supplier_id_offer_id` and `product_routes_offer_id_live` indexes are fine (each offer maps once).
- The "route already tried is skipped" rule works per route, so it would still work once the index allows two WDG routes.
- Finite Web Purchase stock needs the sync to mark it out of stock quickly (sync runs every 15 minutes, "Catalog"); an order can still reach an emptied pack and fail definitively with `OUT_OF_STOCK`, after which Auto is tried (no customer impact, a few seconds lost).
- Unresolved: the margin guard and price basis (ADR 0020) use the cheapest healthy route; selling at the Web Purchase cost would drop the store price when Web Purchase runs out and Auto (dearer) is used, so the guard may pause the product at the Auto cost. This needs the owner's decision.

No code was changed. A change would be: relax the index to `(product_id, offer_id)` (migration, `/db-migration`), allow two routes of one supplier in the admin mapping screen, and review S07/S16 rules that assume one route per supplier. Proposed only after the open questions below are answered.

### Open questions (to add to the list above)

12. **Web Purchase:** answered by WDG support on 2026-10-18 (below, "WDG's answer and the catalog check"); delivery and refunds still to be seen in a live order. Originally: is it automatic and what does it mean (a web top-up by script, a reserved pool, a different source)? Typical delivery time, success rate, and are failures refunded to the wallet like Auto's `410`? Why is the stock limited to about 1,000 and is it replenished? Is the price stable or a promotion?
13. ~~**Owner:** approve read-only calls with the supplier key to identify the `WEB` products (item 1 above), and decide the pricing question under "Routing".~~ done 2026-10-18: the catalog check below and the S17 interview (price on the Auto cost).

Draft question for WDG support (English, for the owner to send):

> Hello, on your PUBG Mobile (ID) catalog page there is a "Web Purchase" route (products named "WEB 60 UC" … "WEB 8100 UC") priced 1–7% below the Auto route, with about 1,000 in stock per pack. Through the reseller API: (1) are these returned by `GET /products?type=topup` as automatic top-ups, and what are their product ids? (2) How does Web Purchase deliver (typical time, success rate), and are failed orders refunded to the wallet automatically as with Auto (`410`, `order.refunded`)? (3) Why is the stock limited and how often is it replenished? (4) Do they need only `player_id`? Thank you.

### WDG's answer and the catalog check (2026-10-18)

WDG support wrote to the owner on 2026-10-18 (question 12): the six Web Purchase packs were converted to `type=topup` with `player_id` required; stock 1,000 per pack, refreshed daily at 00:00 UTC; failures refunded automatically (status `refunded`); delivery 5–30 minutes. The account was raised to Tier-2 VIP: `discount_percent` 2.00 on eligible items, threshold $5,000 a month, 30-day grace.

Read-only check the same day, in the admin supplier catalog (offers tab, after the 15:22 sync; no call was made by hand, nothing was bought or linked):

| Pack | Id | Cost (Web) | Stock | Auto id | Cost (Auto) | Auto original |
|---|---|---|---|---|---|---|
| 60 UC | 286552 | 0.87 | 1000 | 235203 | 0.88 | — |
| 325 UC | 286553 | 4.35 | 1000 | 235204 | 4.38 | 4.435 |
| 660 UC | 286554 | 8.55 | 999 | 235205 | 8.76 | 8.87 |
| 1800 UC | 286555 | 21.15 | 1000 | 235206 | 21.90 | 22.176 |
| 3850 UC | 286556 | 41.00 | 1000 | 235207 | 43.944 | — |
| 8100 UC | 286557 | 82.00 | 1000 | 235208 | 87.50 | — |

- **Confirmed:** the six `WEB` packs are listed (the adapter lists `topup` and `voucher` only), kind "شحن مباشر" (`direct`), category path `PUBG Mobile › Web Purchase`, one field `player_id` (Player ID, text), supported, not mapped. Answer 1 and question 3 of "Not confirmed" are settled: automatic top-ups, `player_id` only.
- **Not as stated:** the discount seen is about **1.2%**, not 2.00%: three Auto packs show an original price with costs 1.24% lower (the panel rounds it down to "خصم 1%"); 60, 3850 and 8100 UC show no original price; the Web packs show none either. The panel shows the discount derived from `original_price`, not WDG's `discount_percent` field, so whether 2.00% applies to other items, or the tier is not yet applied, is unconfirmed: ask WDG or read `discount_percent` in a later read-only call.
- **Not verifiable read-only:** delivery time, the refund behaviour and the daily refresh. The first live order (S17 Acceptance) and the next days' syncs show them.
- Web vs Auto now: −1.1% (60), −0.7% (325), −2.4% (660), −3.4% (1800), −6.7% (3850), −6.3% (8100).

S17 (`docs/specs/S17-wdg-web-route.md`, ADR 0032) maps both offers to one product: Web Purchase first, Auto as fallback, the price on the Auto cost.
