# packages/suppliers

One adapter per wholesale supplier behind one interface (ADR 0005). Used by the worker (fulfilment, sync, polling, webhook processing) and the API (webhook verification, player validation). New or changed adapters follow the `supplier-adapter` skill.

## Layout
- `src/core/adapter.ts`: `SupplierAdapter` (capabilities, `listOffers`, `getBalance`, `validatePlayer`, `placeOrder`, `getOrder`, `verifyWebhook`, `parseWebhook`) and the outcome types.
- `src/core/errors.ts`: `SupplierError` (`retryable` / `definitive`, the supplier's code kept) and `outcomeOfOrderError`.
- `src/core/http.ts`: `SupplierHttp` (injected `fetch`, timeout, Zod parsing, error classification). `src/core/hmac.ts`: HMAC-SHA256, constant-time compare, timestamp tolerance.
- `src/<code>/`: one folder per adapter: `adapter.ts`, `schemas.ts` (Zod for every reply), `errors.ts` (the supplier's codes that are definitive, passed as `definitiveCodes`; any other refusal stays retryable), `fixtures/` (recorded, sanitized replies), tests. Its doc is `docs/suppliers/<code>.md`.
- `src/fake/`: the in-process `fake` supplier for development, tests and E2E (scripted by the `playerId` prefix: see the file header). S07: its catalog is ten offers in three groups with kinds and required fields, changed by a `FakeSupplierState` (`fakeSupplierStateSchema`: costs, stock, removals, a failing sync, every call failing, the balance) that the worker reads from the file the `supplier:fake` CLI writes. Pattern for the interface; real adapters also follow `SupplierHttp`.
- `src/testing/fake-http-server.ts` (`@vertex-digital/suppliers/testing`): the local server real adapter tests script with fixtures.

## Rules
- Adapters are pure HTTP clients: no database, no Nest, no `process.env`. Credentials, base URL and `fetch` are passed in by the caller (keys come decrypted from the database, never from the environment or the repository).
- Parse every reply with Zod; a reply that does not match is never trusted.
- `SupplierOffer` carries the supplier's `group`, `kind` and `requiredFields` when it gives them (S07): leave them out rather than guess.
- Order calls never throw. Classify every answer as `delivered`, `pending`, `failed_definitive` or `unknown` (ADR 0004). Only a definitive refusal is `failed_definitive`; a timeout, a lost connection or an unreadable reply is `unknown` (`outcomeOfOrderError`), because the goods may have been bought.
- Every order carries the caller's idempotency key to the supplier (its idempotency header or order id).
- Money is integer units with a currency (`SupplierMoney`, ADR 0003): convert the supplier's decimal strings exactly, never through floats.
- Webhooks: `verifyWebhook` with `verifyHmacSignature` (timing-safe, timestamp tolerance) over the raw body; `parseWebhook` returns the supplier's unique event id for replay protection.
- Never log credentials, signatures or player data. Fixtures hold no real keys, customers or player IDs.

## Tests
Next to the code (`*.test.ts`), against fixtures and the local fake server. Nothing calls a live supplier in tests; a live call happens only through a CLI smoke test the owner approves.

Run: `pnpm --filter @vertex-digital/suppliers test`.
