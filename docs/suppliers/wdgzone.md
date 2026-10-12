# WDGZone (`wdgzone`)

The backup supplier (ADR 0005): game top-ups and vouchers, cheaper than SHOP2TOPUP on some packs. Adapter: `packages/suppliers/src/wdgzone/`.

Sources: the public documentation at https://wdgzone.tech/docs/ and its OpenAPI document (https://wdgzone.tech/api/openapi.json, "WDG Reseller API" 1.3.0), read on 2026-10-12, and read-only calls to the live API with the owner's trial key on the same day (the wallet held $0, so no purchase could be charged). Anything neither source shows is under "Open questions".

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
| Purchase (`placeOrder`) | `POST /products/{id}/purchase` with `X-Idempotency-Key` | Body `{ quantity, player_id?, callback_url? }`. `201` new order, `200` a replay of the key. |
| Poll (`getOrder`) | `GET /orders/{id}/delivery` | By WDG's own order id. `200` ready, `202` processing, `410` failed and refunded, `404` not found. WDG suggests every 2–5 s; the order engine polls on its own schedule (S08 rule F7). |
| Player check (`validatePlayer`) | — | WDG does not check player ids. The capability is off; the store never asks WDG. |

Not used: `GET /catalog`, `/catalog/{type}/categories`, `/catalog/{type}/categories/{id}/products` (the guided tree: `SUBCATEGORY_REQUIRED` 409 until a leaf), `GET /categories` (3,573 categories), `GET /products/{id}`, `GET /orders`, `GET /orders/{id}`, `GET /transactions`, `GET /health` (`{ status: "operational", catalog_updated_at, time }`, no key needed).

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
- `required_fields`: the account fields, each `{ key, label, type: text | select, options? }` (`select` lists `{ label, value }`). Keys seen: `user_id`, `player_id`, `server_id`, `server`, `riot_id`, `region`, `uid`, `role_id`, `zone_id`… A product with `requires_player_id` and no listed field asks for `player_id`. Products with more than one field, or whose one field is a `select`, are left out (see "Open questions"); on 2026-10-12 that left 3,669 top-ups and 5,975 vouchers, 9,644 offers.
- A product that does not parse, has another currency or an unreadable price is skipped; the rest of the page is kept.
- WDG does not say how the list is sorted. A product that moves between pages while a read runs can be missed by that run (it reappears in the next one, 15 minutes later).
- A full read is about 117 requests. The adapter waits for the rate-limit window to reset whenever 20 or fewer requests are left in it, so orders keep room; a read took 85 s against the live API (two waits).

## Purchases and idempotency

- `X-Idempotency-Key` is required (`422 IDEMPOTENCY_KEY_REQUIRED` without it), up to 100 characters: the attempt id (a UUID, 36). The documentation: "Reuse the same value only when retrying the same order"; the OpenAPI document answers a replay with `200`.
- Seen live: a refused request is not kept under its key; the same key may be sent again and is judged afresh.
- One account field only, sent as `player_id` whatever its key (a product whose field is `user_id` still answers `PLAYER_ID_REQUIRED` without `player_id`). `player_id` is not checked by WDG; a missing one is refused before the balance.
- `quantity` 1–100 per the documentation; the order engine sends 1–50.
- `callback_url`: HTTPS only. The worker sends `${STORE_URL}/api/webhooks/suppliers/wdgzone` when `STORE_URL` is HTTPS (production), nothing in development.
- Reply: `{ order_id, status, delivery_items: [codes…], total }`. `status: "completed"` (any case) is delivered: codes are `delivery_items` when there are any, units the units asked. Any other status is `pending` with the order id, followed by polling.

## Status mapping

| Answer | Outcome |
|---|---|
| Purchase `2xx`, `status` `completed` | `delivered` (`quantity` asked, codes from `delivery_items`) |
| Purchase `2xx`, any other `status` | `pending` (order id kept) |
| Poll `202` | `pending` |
| Poll `200`, body `{ data: { delivery_items?, quantity? } }` | `delivered` with the attempt's units; `unknown` when `quantity` differs or the body does not parse |
| Poll `410` | `failed_definitive` (`error.code`, else `ORDER_FAILED`) |
| Poll `404 ORDER_NOT_FOUND`, `5xx`, timeout, other status | `unknown` |
| Poll without a WDG order id | `unknown`, nothing sent (an `unknown` attempt is re-sent with its key instead: S08 rule F3) |
| Webhook `order.completed` | `delivered` (`data.quantity`, codes from `data.delivery_items`); with `refunded: true`, malformed |
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
| before sending: a product id that is not WDG's digits, a key over 100 characters, two account fields | `PRODUCT_NOT_FOUND`, `IDEMPOTENCY_KEY_TOO_LONG`, `FIELDS_UNSUPPORTED` (ours) | — | definitive, nothing sent |

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

## Fixtures

`packages/suppliers/src/wdgzone/fixtures/`, sanitized: `products-*.json` and the `error-*.json` replies recorded from the live API on 2026-10-12 (request ids replaced, pages cut to a few products); `me.json` recorded with the account id, name and balance replaced; `purchase-completed.json` and `webhook-order-completed.json` from the documentation's examples with the code replaced (`TEST-CODE-0001`). Poll replies (`202`, `200`, `410`) are written in the tests from the documented status codes: their bodies are not documented. Webhook signatures in tests use a test key.

## Live checks done (2026-10-12, owner's trial key, $0 wallet)

`GET /me`, `/health`, `/catalog`, `/catalog/topups/categories`, `/categories`, `/products` (both types), `/orders`, `/transactions`, `/orders/{id}` and `/orders/{id}/delivery` (not found); purchases refused on the $0 wallet (`INSUFFICIENT_BALANCE`) and before it (`IDEMPOTENCY_KEY_REQUIRED`, `PRODUCT_NOT_FOUND`, `PLAYER_ID_REQUIRED`, `INVALID_JSON`); the built adapter's `getBalance`, `listOffers` (9,644 offers in 85 s), `placeOrder` (refused, `failed_definitive`) and `getOrder` (`unknown`). Nothing was bought.

## Open questions (for WDG support, or a funded test)

1. **Replay order of checks (must answer before routing real orders to WDG).** Is the idempotency replay checked before the product, stock and balance checks? If a key whose order was bought is re-sent when the balance or stock has since run out, does WDG answer `200` with the order, or `INSUFFICIENT_BALANCE` / `OUT_OF_STOCK`? The adapter takes those as definitive; the second answer would let the next route buy again. Test: fund the wallet with just one cheap order's price, buy it, then send the same key and body again.
2. **The poll's `200` body** (and `202`, `410`): field names, whether it has `quantity` and `status`, and whether `delivery_items` is present (empty?) for top-ups.
3. **Purchase states:** the full list of `status` values (`processing`, `pending`, `failed`…) and whether a `201` can already say `failed`.
4. **Several account fields** (`user_id` + `server_id`, `region` selects): how they are sent. Until then those products are left out of the catalog and an order with two fields is refused before sending.
5. **Webhook retries:** the backoff schedule (the adapter accepts an event up to 24 hours after its `created_at`) and whether `created_at` stays the same on retries.
6. **`order.refunded` after `order.completed`** (a voucher refunded later): when it happens. The engine treats it as a conflict for the admin (S08 rule F5).
7. **Webhook source addresses**, to add an nginx allow list.
8. **Sandbox:** its base URL and keys, for a funded test without real money.
9. **Catalog order:** the sort order of `GET /products`, so a read cannot miss a product that moves between pages.
