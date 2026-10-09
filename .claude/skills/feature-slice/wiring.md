# feature-slice: wiring and patterns

## Wiring checklist

Everything a new module, error, job or screen must be connected to. Tests catch the items marked **(test)**; the others fail silently, so tick each one that applies in `TASKS.md`. Paths are the ones ADR 0011 fixes; the Phase 0 scaffold creates the files named here, and the first feature that needs a missing one creates it in that place.

### contracts (`packages/contracts/src/`)
- [ ] `<module>.ts` created and re-exported from `index.ts`.
- [ ] Every schema the API exposes has `.meta({ id })`; list responses use the shared page schema with their own id.
- [ ] Sensitive admin routes (money moves, rates, keys, switches) marked for re-authentication as the spec's "Access" table says; a test per route that it answers `REAUTHENTICATION_REQUIRED`. There is no permission map: one admin, full access (ADR 0016).
- [ ] New error codes added to the error code list, with their Arabic text in the store and/or admin catalog in the **same PR** (the catalogs are typed).
- [ ] New audit actions (`<entity>.<verb>`) and entity types added to the audit lists, with their labels in the admin catalog.
- [ ] Fixed value lists (states, kinds, networks) are `as const` arrays with a `z.enum`, reused by the db enum; a new state is added to the transition table with tests for every allowed and refused move.
- [ ] Money: amounts typed through the shared money types and scales; no local rounding helpers.

### db (`packages/db/src/schema/`), through `/db-migration`
- [ ] `<module>.ts` created and re-exported from `schema/index.ts`.
- [ ] The file has an owner in `TABLE_OWNERS` (`apps/api/test/architecture.test.ts`) **(test)**.
- [ ] Business columns, UUIDv7 ids, timestamptz, indexed foreign keys, unique external references **(test: `conventions.test.ts`)**; indexes for the filters and sorts the list endpoints offer.
- [ ] Append-only tables have the refuse-update trigger and revoked grants **(test)**.
- [ ] Schema and generated migration committed together **(CI: drift)**.

### api (`apps/api/src/`)
- [ ] `modules/<module>/` with `<module>.module.ts`, controllers (`<module>.controller.ts` for customers, `<module>.admin.controller.ts` for the admin), `<module>.service.ts`, `index.ts` (the Nest module and only the services other modules call).
- [ ] The module is imported in `app.module.ts` through its `index.ts`.
- [ ] Every route declares `@CustomerRoute()`, `@AdminRoute()` or `@Public()`; admin routes only under `/api/admin/` **(test)**; imports from other modules go through their `index.ts` **(test)**; only the module's own tables **(test)**.
- [ ] Customer reads and actions filter by the caller's id; a record of another customer answers 404.
- [ ] Money and order changes go through `packages/db/src/ledger` and `packages/db/src/orders`; idempotency keys on every journal, deposit and order; `Idempotency-Key` required on money endpoints.
- [ ] Every state change writes the audit entry in the same `db.transaction`; jobs are enqueued on the same transaction.
- [ ] New public or money endpoints have their rate limit (API and the matching nginx zone in `deploy/`) and ALTCHA where ADR 0008 asks.
- [ ] Archive and restore set and clear `archivedAt`; no `DELETE` of business rows.
- [ ] `test/<module>.test.ts`: per endpoint success, 401, 403 (customer session on an admin route, admin session on a customer route) and other customers' records; the spec's numbered rules each have a test; money paths have concurrency and double-submit tests; seeded rows removed in `afterAll`.
- [ ] `docs/architecture.md` ("API modules") updated if module ownership differs from the table there.

### worker (`apps/worker/src/`)
- [ ] Queue names and schedules in `packages/contracts` (jobs list); the job in `jobs/<area>/<name>.job.ts`.
- [ ] The job is safe to run twice (state checked in the database, unique keys), retries with backoff only on retryable errors, and reports final failures to Sentry and Telegram.
- [ ] Supplier calls only through `packages/suppliers`; chain reads only through the chain-reader interface; tests use the fake supplier and fixtures, never live services.
- [ ] Changes that customers or the admin watch live send `pg_notify` after commit (a customer event: `notifyCustomer` does it).

### bridge
- [ ] The OpenAPI document and the admin client types regenerated and committed **(CI: OpenAPI drift)**.
- [ ] A changed response shape: the screens and E2E mocks that use it are adapted in the same PR.

### admin (`apps/admin/src/`)
- [ ] `features/<module>/<module>.queries.ts` with keys that start with the module name; mutations invalidate every query the change affects.
- [ ] Thin routes; `validateSearch` for URL filters. Regenerate the route tree before typecheck and commit it.
- [ ] Navigation item with its label.
- [ ] i18n keys: the module namespace, `errors.<CODE>`, audit labels.
- [ ] Loading (`Skeleton`), empty (`EmptyState`), error states; forms show server errors by code; sensitive actions ask for re-authentication.

### store (`apps/store/src/`)
- [ ] Routes in `app/` stay thin; the feature lives in `features/<area>/`.
- [ ] Cached reads use `use cache` with tags from `lib/cache-tags`; the API revalidates those tags when the data changes.
- [ ] Client components only where interaction needs them; no secrets or admin data in client bundles.
- [ ] Money shown through the shared price component (USD with SYP); i18n keys for every string; loading, empty and error states; phone width first.
- [ ] Money actions send an `Idempotency-Key` per attempt and handle `PRICE_CHANGED`, `INSUFFICIENT_BALANCE` and rate-limit answers.

### e2e
- [ ] Flow spec for the feature's main paths, using the fake supplier.
- [ ] Every new screen in the screenshot specs (store: phone width, dark and light; admin: light and dark).

### docs
- [ ] The spec updated where implementation settled a detail it left open; `docs/open-questions.md` if an answer was recorded.
- [ ] The folder `CLAUDE.md` updated if this feature became the better pattern to copy.

## Patterns to copy

Filled after the first feature of each kind ships; until then, follow ADR 0011 and the folder `CLAUDE.md` files.

| Need | Copy from |
|---|---|
| Contract: entity, inputs, list query, page | `packages/contracts/src/audit.ts`, `customers.ts` (cursor list: `lists.ts`) |
| Ledger posting and its concurrency tests | `apps/api/src/modules/wallet/wallet-adjustments.service.ts` (lock, idempotency replay, journal + audit + email in one transaction), `apps/api/test/wallet.test.ts` (parallel debits, reversals, one key in parallel), `packages/db/src/ledger/wallet.test.ts` |
| Order transition and its tests | `packages/db/src/orders/` (`transition.ts`: `UPDATE … WHERE status = <from>` with its event, null on a lost race; `outcome.ts`: order then attempt `FOR UPDATE`, a result only on an open attempt; `purchase.ts`: a key's advisory lock, then replay; `OrderError` with its code), `orders.test.ts` (parallel purchases, one key in parallel, a waiting repricing, a webhook and a poll at once, guards for the app role and the owner); API: `apps/api/src/modules/orders/order-decisions.service.ts` (a decision's key replayed after waiting on the lock), `apps/api/test/orders.test.ts` |
| A write path shared by the API and the worker, with bulk reads and locks in id order | `packages/db/src/pricing/` (`routing.ts`: facts read in bulk then decided by the contracts' pure rules; `reprice.ts`: games `FOR SHARE`, products `FOR UPDATE`, each in id order), `reprice.test.ts` (parallel callers on one row) |
| Secrets at rest (AES-256-GCM, associated data, key version) | `packages/db/src/suppliers/credentials.ts` and its test; the key from the environment, derived locally, required in production (`apps/api/src/core/config/env.ts` `SUPPLIER_KEYS_SECRET`) |
| Supplier adapter with fixtures | — (first: `/supplier-adapter shop2topup`) |
| API module, controllers, service, integration test | `apps/api/src/modules/audit/`, `apps/api/test/audit.test.ts`; a paged list (`page`, `pageSize`, `total`) and archive/restore/reorder under parent locks: `apps/api/src/modules/catalog/` (`catalog.service.ts` `games`, `catalog-records.ts`), `apps/api/test/catalog.test.ts`; a public immutable image route and an admin upload: `catalog.controller.ts`, `catalog.admin.controller.ts`; a module above another that changes its rows in the caller's transaction (`CatalogItemsService.lockProduct`, `importProductsIn`) and per-row refusals in `details.rows`: `apps/api/src/modules/suppliers/`, `apps/api/test/suppliers.test.ts`; decisions each in its own transaction with a result per item: `PricingService.decide` |
| Worker job with retries and idempotency | `apps/worker/src/jobs/deposits/usdt-verify.job.ts`, `usdt-scan.job.ts` (state re-read under the row lock, retries from a stored start time, reader errors never conclude); a job that calls a supplier: `apps/worker/src/jobs/suppliers/` (`SupplierRegistry.connect`, `recordedCall`, the call outside the transaction, one run at a time by a partial unique index, `sanitizedMessage`), tested with scripted adapters in rolled-back transactions (`test/suppliers.test.ts`); an order job: `apps/worker/src/jobs/orders/` (the attempt committed before the call, the answer applied under the order lock by the write path, the sweep only queuing the owning jobs), tested with the in-process fake supplier in rolled-back transactions and a committed race on its own offer (`test/orders.test.ts`) |
| Admin list page, form, detail page | `apps/admin/src/features/audit/` (URL filters, cursor list, detail sheet), `features/customers/test-customers-page.tsx` (form dialog, one-time secret), `features/wallet/` (search in the URL, detail page with a cursor table), `features/deposits/` (tabs and search in the URL, a review page with a decision form and dialogs, a background-polled navigation badge; `transfers-page.tsx`: filters in the URL and a dialog that picks a customer, then opens another module's form prefilled); `features/catalog/` (category tabs and filters in the URL, cards with move up / move down, a detail page with tabs in the URL, add/edit dialogs by kind, image uploads with preview, archive filters), `features/pricing/` (a live preview read with `useQuery` over a POST, `rule-dialog.tsx`); `features/suppliers/` (a page with tabs and table filters in the URL, rows selected across pages into an all-or-nothing dialog that shows the refused rows in place: `offers-tab.tsx`, `import-dialog.tsx`; a drawer editing a row's children from a table: `routes-drawer.tsx`; a detail read again in the background while a job runs: `supplierQuery`); `features/pricing/reviews-page.tsx` (a decision list: bulk action with a result per row, a stale refusal shown on its row) |
| Admin money dialog (re-authentication, `Idempotency-Key`, typed confirmation) | `apps/admin/src/features/wallet/adjust-dialog.tsx`, `adjustment-form.tsx` (`useIdempotencyKey`, refusals by field), `wallet.queries.ts` |
| Store page with cached reads | — (first: F12) |
| Store page read in the browser with the session (no cache) | `apps/store/src/features/wallet/` (`requests.ts` with its test, skeleton, error, sign-in redirect, load more), the header chip `balance-chip.tsx`; a dynamic `[id]` route (`useParams` under `<Suspense>`, `notFound()`), multipart upload and a money form with `Idempotency-Key` and ALTCHA: `apps/store/src/features/deposits/`; a page that polls while open (10 s visible, 30 s hidden) with one view per sub-state: `usdt-deposit.tsx` |
| Customer notification and its email from a change | `notifyCustomer` in `packages/db/src/notifications` (API: `NotificationsService.notifyCustomer(tx, …)`; worker: `notifyCustomer(tx, bossJobSender(boss), …)`), tests in `notify-customer.test.ts` |
| Live updates over SSE | `apps/api/src/modules/notifications/notification-stream.service.ts` (one `LISTEN` per process, fan-out by customer, heartbeat, session re-check, `resync`), `apps/api/test/notifications.test.ts` (an SSE reader over `fetch`); store: `apps/store/src/features/notifications/live.ts` (`useNotificationEvents`), the E2E mock `api.stream(...)` |
| Telegram bot flow and its jobs | `apps/api/src/modules/telegram/telegram-bot.service.ts` (buttons and prompts, decisions through the domain service with the channel `telegram`), `apps/api/test/telegram-decisions.test.ts` (webhook updates, races with the panel); worker: `apps/worker/src/jobs/telegram/deposit-card.job.ts` (send once, edit to the outcome), `review-reminder.job.ts` (a scheduled job with fixed instants), `test/telegram-jobs.test.ts` (jobs in a rolled-back transaction) |
| E2E flow and screenshots | `apps/store/e2e/accounts.spec.ts`, `apps/admin/e2e/accounts.spec.ts`; a stateful money mock: `apps/admin/e2e/wallets.spec.ts` and `deposits.spec.ts` with their state in `e2e/test.ts`; a whole module's mock with the spec's rules in its own file: `apps/admin/e2e/catalog-mock.ts` (used by `catalog.spec.ts`, `pricing.spec.ts`), and one built on another with the contracts' pure rules and a test's scripted changes: `apps/admin/e2e/suppliers-mock.ts` (`suppliers.spec.ts`); store flows with images and multipart: `apps/store/e2e/deposits.spec.ts` |
