# FazerCards (`fazercards`): evaluation, not integrated

A B2B aggregator of game top-ups, gift cards, game keys, Steam and Telegram products. **Status: evaluated on 2026-10-15, no adapter, not routed.** WDGZone stays the only automatic supplier (ADR 0031) until the owner decides otherwise and `docs/open-questions.md` Q17 is answered.

Sources, all read on 2026-10-15: the public site and API reference (https://reseller.fazercards.com/en, `/en/docs`, `/en/docs/webhooks`, `/en/pricing`, `/en/terms`, `/en/suppliers`), the OpenAPI document (`https://api.fzr.cards/public/docs/openapi.json`, "FazerCards Public API" 0.1.0, 47 paths), the official Node SDK (`fazercards` 0.2.0 on npm, MIT, whose types say they were checked against live replies), and the owner's trial account in the reseller panel (read only: nothing was bought, funded, activated or written). Trustpilot reviews were read for the risk section.

## Connection

| | |
|---|---|
| Base URL | `https://api.fzr.cards/api/v2` (the site's own sample also shows `https://reseller.fazercards.com/api/v2`; the OpenAPI server and the SDK use `api.fzr.cards`) |
| Authentication | `X-API-Key: fc_…` or `Authorization: Bearer fc_…`. One key per account, shown in the panel (Profile → API key); **changing it needs FazerCards support**. Backend only: anyone with it spends the balance. |
| Content | JSON. Success `{ ok: true, … }`; error `{ ok: false, error, code? }` (`code` optional, machine-readable). |
| Naming | Catalog and order bodies are `snake_case`; account, transaction and Steam/Telegram order bodies are `camelCase` (SDK note). |
| Money | USD decimal strings with 4 decimals (`"0.8711"`, balance `"0.0000"`). Read exactly into micro-dollars (ADR 0003). |
| Rate limits | Per category, sliding window: catalog reads 120/min, order create 60/min, order status 120/min, account reads 30/min, payment writes 15/min, other 120/min. `429` with `Retry-After`; the docs ask for ±15% jitter and a 5–15 minute catalog cache. |
| Sandbox | None. Every order is charged to the real balance. |
| IP allowlist | None documented. Webhook source addresses are not published. |
| Other | An MCP endpoint (`https://api.fzr.cards/mcp`, `mcp_` tokens from the panel's "Connect to AI") spends the real balance: never create one for this store. |

## Plans and prices

The plan sets the purchase price ("rebate tier"); every plan has the full catalog, the API and webhooks.

| Plan | Fee per 30 days (panel, 2026-10-15) | Stated rebate |
|---|---|---|
| Trial | free, 5 days, Gold prices | as Gold; no card or KYC (email, username, password) |
| Bronze | $3.99 | entry-level; Steam top-up 2.5% |
| Silver | $6.99 | improved; Steam top-up 3% |
| Gold | $9.99 | maximum; Steam top-up 3.55%; personal integration help |

- The fee is debited from the USD balance (`POST /subscription/activate-from-balance`); auto-renewal is a flag (`PATCH /subscription/auto-renew`); an upgrade charges the new plan and starts a new 30-day period, a downgrade applies at once without a refund (`PATCH /subscription/plan`). A partner promo code applies to the first paid activation only.
- Per-category rebate percentages are not published; live prices per SKU appear in the panel and the API for the account's current plan. Only Gold prices could be read (the trial is Gold).
- An earlier summary of the public pricing page gave $9.99 / $19.99 / $29.99. The panel showed $3.99 / $6.99 / $9.99 on 2026-10-15: trust `GET /subscription/plans`.

### Live Gold prices against WDGZone (2026-10-15)

| Pack (direct top-up) | FazerCards Gold | WDGZone Auto (public catalog) | Difference |
|---|---|---|---|
| PUBG Mobile Global 60 UC | $0.88 | $0.887 | −0.8% |
| 325 UC | $4.38 | $4.435 | −1.2% |
| 660 UC | $8.76 | $8.870 | −1.2% |
| 1800 UC | $21.90 | $22.176 | −1.2% |
| 3850 UC | $43.94 | $44.295 | −0.8% |
| 8100 UC | $87.15 | $88.200 | −1.2% |
| Free Fire MENA 110 Diamonds | $0.91 | $0.919 | −1.0% |
| 231 Diamonds | $1.82 | $1.838 | −1.0% |
| 583 Diamonds | $4.57 | $4.604 | −0.7% |
| 1188 Diamonds | $9.14 | $9.209 | −0.7% |

- The public marketing table ($0.80 for 60 UC, $79.84 for 8100 UC) is not what the account pays: the live Gold price is about 9% higher. FazerCards' public page itself notes a "base −1%" display and that live rates need a login.
- About 1% below WDGZone on Gold; Bronze and Silver pay more than Gold, so likely more than WDGZone. At $9.99 a month, Gold pays for itself only above roughly $1,000 of purchases a month.
- "PUBG Mobile (Manual)" (1800 / 3850 / 8100 UC at $22.57 / $43.86 / $86.70) states 5–15 minute delivery and a success rate of "approximately 50/50": never route to it.
- Free Fire has a MENA category (110 / 231 / 583 / 1188 / 2420 Diamonds), absent from the public catalog page.

## Funding

USDT on TRC20, BEP20, TON and Aptos, 3 to 5,000 USDT per invoice (panel); Binance Pay through the API (`binancepay`, `GET /payments/methods` lists what the account may use). `POST /payments/create` returns an invoice whose **`uniqueAmount` is the exact sum to send**; sending `amount` instead, a different sum, a wrong network or a missing memo leaves the invoice unmatched and goes to manual review (2–5 business days in FazerCards' replies to reviews). Funding stays a manual admin action recorded as a treasury movement (S13), as for WDGZone.

## Endpoints

All under `/api/v2`. "Use" names the `SupplierAdapter` method it would serve (ADR 0005).

| Group | Call | Use |
|---|---|---|
| Account | `GET /me` (login, email, plan, `planExpiresAt`, `planAutoRenew`, `subscriptionActive`, totals) | plan expiry watch (new, see "Integration") |
| | `GET /balance` → `{ balance: "12.3400", currency: "USD" }` | `getBalance` |
| | `GET /transactions?page&limit≤100`, `GET /transactions/{txN}`: `id`, `type` credit/debit, `status` completed/processing/cancelled, `amount`, `balanceBefore`, `balanceAfter`, `note`, `createdAt` | `listTransactions` |
| Webhook settings | `GET`, `PUT { url, enabled }`, `DELETE /account/webhook`; `POST /account/webhook/secret/regenerate`; `POST /account/webhook/test`; `GET /account/webhook/deliveries` (last 50) | set once by the admin; secret stored with the key |
| Orders | `GET /orders?page&limit≤100`; `GET /orders/{ord-N}` | `listOrders`; `getOrder` |
| Top-ups | `GET /topups?limit≤500&cursor&include_ui=1` (categories: `category_id`, `name`, `note`, `imageurl`) | `listCategories` |
| | `GET /topups/offers?category_id=` → `offers: [{ offer_id, name, price_usd }]`, `fields: [{ key, label, type: text\|select, options }]` | `listOffers` |
| | `POST /topups/order` `{ category_id, offer_id, fields: { key: value } }` + `Idempotency-Key` | `placeOrder` (direct) |
| | `GET /topups/validate-id` (games that support it, with their fields); `POST /topups/validate-id` `{ category_id, fields }` → `valid`, `player_name`, `player_id`, `region`; `422` could not confirm | `validatePlayer` |
| Gift cards | `GET /giftcards`, `GET /giftcards/cards?category_id=` (`card_id`, `price_usd`, `stock`, `min_order_quantity`, `max_order_quantity`), `POST /giftcards/order` `{ category_id, card_id, quantity 1–100 }` + `Idempotency-Key`; the completed order carries `cards` | `listOffers`, `placeOrder` (code) |
| Game keys | `GET /gamekeys`, `/gamekeys/keys`, `/gamekeys/region-restriction`, `POST /gamekeys/order` (`keys` on the order) | out of V1 scope |
| Steam | `GET /steam-topup/rates`, `POST /steam-topup/check-login`, `POST /steam-topup/order`; `GET /steam-gifts/games`, `/steam-gifts/games/{appid}`, `POST /steam-gifts/order` | out of V1 scope |
| Telegram | `GET /telegram/stars`, `/telegram/premium`, `POST /telegram/stars/buy`, `/telegram/premium/buy` | possible later (V1 sells chat apps) |
| Manual services | `GET /manual-services`, `/{id}/offers`, `POST /manual-services/order`, order chat `GET`/`POST` | never (manual delivery) |
| Subscription | `GET /subscription`, `GET /subscription/plans`, `GET /subscription/activation-quote?plan`, `POST /subscription/activate-from-balance`, `PATCH /subscription/auto-renew`, `PATCH /subscription/plan` | read only from the store; plan changes stay in the panel |
| Payments | `GET /payments/methods`, `POST /payments/create`, `GET /payments/{id}`, `POST /payments/{id}/verify` (Binance Pay) | never from the store (admin funds by hand) |
| FunPay | `POST /funpay/login`, `GET /funpay/me` | not relevant |

There is no health or status endpoint (`platformStatus` off) and no category tree: top-up categories are a flat list, each one game and region ("PUBG Mobile (Auto)", "Free Fire (MENA)").

## Orders

- An offer is the pair `(category_id, offer_id)`: the same `offer_id` string is reused across categories. The adapter's `offerId` must carry both (for example `topup:<category_id>:<offer_id>`, `gift:<category_id>:<card_id>`).
- The balance is charged when the order is created; the reply is `{ ok, order }` with `order.status` usually `processing`.
- `Idempotency-Key` (≤255 characters) is optional on every order endpoint: a repeat with the same key returns the original order without charging. A `409` on an order usually means the key was reused for another product type. The adapter always sends the attempt id.
- Statuses: `created`, `processing`, `completed`, `failed`, `refund`; the last three are terminal. A failed order is refunded to the FazerCards balance automatically. A delivered order is final: wrong player id or region is the store's loss.
- Order body (SDK `OrderResource`): `id` (`ord-N`), `kind` (`topup`, `gift_card`, …), `status`, `offer_id`, `category_id`, `price_usd` / `total_usd`, `cards` (gift cards), `fail_reason`, `status_history`, `created_at`, `completed_at`. Steam and Telegram orders use camelCase keys instead.

## Webhooks

- One URL per account, set in the panel (Settings → Webhook) or by `PUT /account/webhook`; it receives **every** order of the account, panel orders included. The secret is generated by FazerCards (not derived from the key), rotated by `secret/regenerate`.
- Events: `order.created`, `order.status_changed`, `manual_service.chat.message`, `manual_service.chat.waiting_reply`, `webhook.test`.
- Headers: `X-Webhook-Signature: sha256=<hex>` (HMAC-SHA256 of the raw body with the secret; a bare hex digest is also accepted by the SDK), `X-Webhook-Event`, `X-Webhook-Event-Id` (UUID, stable across retries), `X-Webhook-Delivery-Attempt`.
- Body: `{ event, event_id, timestamp, data: { order_id, type, status, previous_status } }`. It carries no codes and not our idempotency key: the order is found by `order_id` (`supplier_order_id`), and a completed gift card needs `GET /orders/{id}` for its `cards`.
- No signed timestamp header: `timestamp` in the signed body is the only clock (tolerance as for WDGZone).
- Retries: up to 3 after a non-2xx or a 10-second timeout (about 1, 5 and 30 minutes); the webhook is disabled after 50 consecutive failures.

## Errors

| HTTP | Meaning (docs, SDK) | On an order |
|---|---|---|
| 400 | validation or business rule (`code` sometimes) | definitive, except unknown codes mapped after a funded test |
| 401 / 403 | missing or invalid key / account blocked or product not enabled for the key | `unknown` (as WDGZone) |
| 404 | unknown product or route | definitive for a product, `unknown` for a route |
| 409 | conflict, most often an idempotency key reused for another product type | `unknown` |
| 422 | validate-id could not confirm the player | `validatePlayer` answers "not confirmed" (S09 warning) |
| 429 | rate limited, `Retry-After` | `unknown` |
| 5xx, 502, 503, timeout | upstream or internal | `unknown` |

The list of `code` values is not published.

## Integration with this project (if the owner approves)

Built through `/supplier-adapter fazercards` after Q17 is answered, as its own PRs:

1. **Database** (`/db-migration`): `fazercards` in the supplier code enum and its `fazercards_paused` store switch, a seeded supplier row; credentials `apiKey` and `webhookSecret` (two values, unlike WDGZone).
2. **Adapter** (`packages/suppliers/src/fazercards/`, copying `wdgzone/`): `SupplierHttp`, Zod schemas from the OpenAPI document, fixtures recorded read-only with the owner's key. Capabilities: `validatePlayer`, `webhooks`, `balance`, `catalog`, `categories` (flat), `statement` on; `platformStatus` off. Image hosts from `imageurl`.
3. **Catalog sync**: a full read is one request per category (1,000+ categories) at 120 a minute, over the 15-minute sync budget. Read only the categories the admin linked to a game (S16 SC5), paced inside the catalog limit, and the category list once a day.
4. **Orders**: `placeOrder` with the attempt id as `Idempotency-Key`; `getOrder` by `ord-N` (`PlacedOrder.supplierOrderId`), re-sending with the key when no order id is known; webhook as in "Webhooks", a gift card completion followed by `GET /orders/{id}`.
5. **Player check**: `POST /topups/validate-id`, mapping our route's category to a validate-id `category_id` (S09 quotas apply).
6. **Subscription watch (new)**: the worker reads `GET /me` with the balance; a Telegram alert 48 hours before `planExpiresAt` and when `subscriptionActive` is false. Orders on an expired plan are not documented: pause the supplier rather than find out live.
7. **Routing**: direct top-ups only at first (PUBG Mobile (Auto), Free Fire (MENA)), as a second route behind WDGZone; never "Manual" categories and never gift cards or codes until a funded test shows clean codes.

## Risks seen

- Operator unnamed: no legal entity, address or governing law; contact by Telegram only. The terms let FazerCards delay or refuse payouts and adjust balances; liability is capped at the fees paid in 12 months.
- Trustpilot (2026-10-15): 2.0 out of 5 from 26 reviews, 77% one star, most from September–October 2026: used or invalid codes (PUBG UC, PSN, Roblox), orders stuck in processing, deposits not credited, support replying only by bot for days. FazerCards answers that a one-week disruption caused the delays.
- An aggregator: quality depends on its sub-suppliers per product.

## Open questions (for FazerCards support, or a funded test)

1. Prices on Bronze and Silver for the same packs.
2. What an order does when the plan has expired.
3. The `code` values of `400` replies.
4. Whether `POST /topups/validate-id` category ids match the order category ids.
5. Webhook source addresses, for an nginx allow list.
