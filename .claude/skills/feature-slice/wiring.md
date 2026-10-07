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
- [ ] Changes that customers or the admin watch live send `pg_notify` after commit.

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
| Ledger posting and its concurrency tests | — (first: F03) |
| Order transition and its tests | — (first: F11) |
| Supplier adapter with fixtures | — (first: `/supplier-adapter shop2topup`) |
| API module, controllers, service, integration test | `apps/api/src/modules/audit/`, `apps/api/test/audit.test.ts` |
| Worker job with retries and idempotency | — (first: F06) |
| Admin list page, form, detail page | `apps/admin/src/features/audit/` (URL filters, cursor list, detail sheet), `features/customers/test-customers-page.tsx` (form dialog, one-time secret) |
| Store page with cached reads | — (first: F12) |
| E2E flow and screenshots | `apps/store/e2e/accounts.spec.ts`, `apps/admin/e2e/accounts.spec.ts` |
