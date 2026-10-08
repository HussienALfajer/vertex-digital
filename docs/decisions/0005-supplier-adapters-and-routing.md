# 0005 — Supplier adapters and smart routing

Status: Accepted · Date: 2026-10-06 · Amended by [0016](0016-single-admin-account.md) (one admin account, no staff or roles), [0020](0020-pricing-engine.md) (the margin guard's boundary and the price basis)

## Context
Goods come from wholesale suppliers with different APIs, prices, features and reliability. The primary supplier validates player IDs and returns the in-game name; the backup is cheaper on some packs but cannot validate. Suppliers fail, change prices and run out of balance. Some products are fulfilled by hand.

## Decision

### Suppliers at launch
| Code | Role | API | Notes |
|---|---|---|---|
| `shop2topup` | Primary | REST, base `https://shop2topup.com/api/endpoints/v1`, `Authorization: Bearer <keyId>.<secret>` | Player validation with in-game name; HMAC-signed webhooks; idempotent `order_id`; automatic refunds on their side; price protection; IP allowlist (register the VPS outbound IP) |
| `wdgzone` | Backup, cheaper on some packs | REST, base `https://wdgzone.tech/api/v1`, `X-API-Key` header, `X-Idempotency-Key` | HMAC-signed webhooks; automatic refunds; no player validation |
| `manual` | Staff fulfil by hand | — | Orders wait in the live orders room (F17) for an operator to deliver and confirm |
| `fake` | Development, tests, E2E | In-process | Scripted outcomes: delivered, slow, pending then webhook, definitive failure, unknown/timeout, wrong signature |

Exact endpoints, payloads and limits are written in `docs/suppliers/<code>.md` when each adapter is built (`/supplier-adapter`), from the supplier's documentation the owner provides.

### One interface
- `packages/suppliers` holds one adapter per supplier behind a `SupplierAdapter` interface: capabilities (`validatePlayer`, `webhooks`, `balance`, `catalog`), `listOffers`, `getBalance`, `validatePlayer`, `placeOrder(idempotencyKey, …)`, `getOrder`, `verifyWebhook` and `parseWebhook`.
- Adapters are pure HTTP clients: injected `fetch`, timeouts, Zod parsing of every response, no database and no Nest. They return results classified as `delivered`, `pending`, `failed_definitive` or `unknown` (ADR 0004), and errors as `retryable` or `definitive` with the supplier's code kept.
- Credentials are passed in by the caller. They are entered in the admin panel and stored encrypted (AES-256-GCM, key from `SUPPLIER_KEYS_SECRET` in the server environment), shown masked, never logged, never in the repository.
- Tests use recorded, sanitized fixtures and a local fake HTTP server; tests never call a live supplier. A live call happens only through an explicit CLI smoke test the owner approves.

### Webhooks
- Received by the API at `/api/webhooks/suppliers/<code>`: HMAC verified with a timing-safe compare and a timestamp tolerance, IP allowlist where the supplier publishes its IPs, raw event stored once (unique supplier event id), job enqueued, `200` returned fast. The worker processes events; polling covers lost webhooks.

### Routing
- Each store product maps to supplier offers (supplier, offer id, priority, enabled).
- At fulfilment the router builds candidates: enabled mapping, supplier healthy (not `down`), offer in stock, cost known and **cost < price − minimum margin** (margin guard, F10). Order: lowest cost, then health score, then measured delivery time, then priority.
- On a definitive failure the next candidate is tried (A04); a route already tried for the order is skipped. When none is left, the order is refunded.
- A player validated by `shop2topup` may be fulfilled by `wdgzone`: validation is about the player, not the route.

### Input fields and player validation
- Each game's input fields (player ID, zone ID, server, region, phone…) are defined in the catalog (F08) and mapped per supplier offer to the supplier's own field names; SHOP2TOPUP's per-category requirements endpoint is used to build and check the mapping. An order is never sent with a field the route needs missing.
- Validation is a scarce, abusable resource (SHOP2TOPUP has a daily quota). The API validates only for signed-in, email-verified customers, after the field is complete (debounced or on blur, never per keystroke), with per-customer and per-IP limits, and caches results per game and account fields for a set time (valid and invalid alike). Quota use is tracked; near the quota the store falls back to "confirm the ID yourself" instead of failing purchases. Staff see quota use on the supplier page.
- **Health:** a rolling window per supplier of success rate, unknown-outcome rate and latency sets `healthy`, `degraded` (used only when no healthy route exists) or `down` (excluded; a half-open probe after a cool-down). Supplier balance below the cost of the order excludes it too (A07 alerts).
- **Price sync** (A06) refreshes costs on a schedule; a change beyond the configured threshold goes to the price change review queue, and the margin guard pauses products without a profitable route.

## Consequences
- Adding a supplier is an adapter, fixtures, a doc and a mapping: the order engine does not change.
- Routing decisions are recorded on each attempt (candidates and reason), so staff can see why a supplier was chosen.
