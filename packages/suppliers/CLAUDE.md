# packages/suppliers

One adapter per wholesale supplier behind one interface (ADR 0005). Used by the worker (fulfilment, sync, polling, webhook processing) and the API (webhook verification, player validation, the panel's live reads). New or changed adapters follow the `supplier-adapter` skill.

## Layout
- `src/core/adapter.ts`: the `SupplierAdapter` interface, its capabilities and the outcome types. Optional capabilities (categories, statement, platform status, offer quotes, offer windows, account) are declared in `capabilities`; an adapter without one answers its methods with `notSupported` (`core/errors.ts`).
- `src/core/errors.ts`: `SupplierError` (`retryable` / `definitive`, the supplier's code, the failure kind, `retryAt` for a rate limit) and `outcomeOfOrderError`.
- `src/core/http.ts`: `SupplierHttp` (injected `fetch`, per-request timeout, Zod parsing, failure classification: network, `rate_limited`, `http_5xx`, `http_4xx`, `unreadable`, `redirect`). `src/core/hmac.ts`: HMAC-SHA256, constant-time compare, timestamp tolerance. `src/core/image.ts`: `fetchImageFromHosts`, `imageUrlAllowed`.
- `src/<code>/`: one folder per adapter (`adapter.ts`, `schemas.ts`, `errors.ts`, `fixtures/`, tests); its doc, with the supplier's quirks, is `docs/suppliers/<code>.md`.
- Pattern to copy for a real adapter: `src/wdgzone/` (doc `docs/suppliers/wdgzone.md`). `src/fazercards/` shows an `offerWindow` catalog read one category at a time and composite ids (doc `docs/suppliers/fazercards.md`).
- `src/fake/adapter.ts`: the in-process `fake` supplier for development, tests and E2E; the worker reads its state from the file the `supplier:fake` CLI writes. How orders are scripted (by `playerId` prefix or per-offer scripts) is in its file header.
- `src/testing/fake-http-server.ts` (`@vertex-digital/suppliers/testing`): the local server real adapter tests script with fixtures.

## Rules
- Adapters are pure HTTP clients: no database, no Nest, no `process.env`. Credentials, base URL and `fetch` are passed in by the caller (keys come decrypted from the database, never from the environment or the repository).
- Parse every reply with Zod; a reply that does not match is never trusted.
- Offers carry the supplier's `group`, `kind`, `requiredFields`, `fieldSpecs`, stock and category when it gives them: leave them out rather than guess. An offer the store cannot sell is kept with its `unsupportedReason`, not dropped.
- Order calls never throw. Classify every answer as `delivered`, `pending`, `failed_definitive` or `unknown` (ADR 0004). Only a definitive refusal is `failed_definitive`; a timeout, a lost connection, a redirect or an unreadable reply is `unknown` (`outcomeOfOrderError`), because the goods may have been bought.
- `errors.ts` of an adapter lists only the supplier codes that are definitive (`definitiveCodes`); any other refusal stays retryable.
- `delivered` and `pending` carry `chargedUsdUnits` (what the supplier charged). An `unknown` the supplier itself answered (still processing, not found) is `answered: true` and is not a health error.
- Shared refusal codes: a stock refusal uses `OUT_OF_STOCK_CODE` (the worker marks a finite-stock offer out) and an inactive plan `SUBSCRIPTION_INACTIVE_CODE` (the worker stops orders and checks to that supplier).
- Every order carries the caller's idempotency key to the supplier (its idempotency header or order id). `getOrder(key, placed)` also receives the supplier's order id, and a webhook event may name its order by the key, the supplier's order id or both, for suppliers that know only their own ids.
- Money is integer units with a currency (`SupplierMoney`, ADR 0003): convert the supplier's decimal strings exactly, never through floats.
- Redirects: `SupplierHttp` follows at most 3, by hand, only for a `GET` on the same origin, because `fetch` would carry a custom credential header (`x-api-key`) to another host. Keep `redirect: 'manual'` in any new request path.
- Images: every adapter's `fetchImage` goes through `fetchImageFromHosts` (HTTPS on declared `imageHosts` only, default port, redirects only to declared hosts, size and time limits), never with credentials.
- Webhooks: `verifyWebhook` with `verifyHmacSignature` (timing-safe, timestamp tolerance) over the raw body; `parseWebhook` returns the supplier's unique event id for replay protection.
- Never log credentials, signatures or player data. Fixtures come from the supplier's documentation or a sandbox and are sanitized: no real keys, customers or player IDs. Agents never call a live supplier API.

## Tests and live checks
- Tests sit next to the code (`*.test.ts`) and run against fixtures and the local fake server. Run `pnpm verify packages/suppliers/src/<code>/adapter.test.ts`.
- Agents never call a live supplier API themselves. A new adapter is checked live by the owner: they enter the key in the admin panel's supplier page, then use its connection test (one live balance read), sync now (queues `suppliers.sync`) and, for suppliers with the `account` capability, the webhook test.
- The worker's `suppliers.health` job then probes the supplier every minute.
