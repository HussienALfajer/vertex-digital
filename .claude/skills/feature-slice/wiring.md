# feature-slice: wiring and patterns

## Wiring checklist

Everything a new module, error, job or screen must be connected to. Tests catch the items marked **(test)**; the others fail silently, so tick each one that applies in `TASKS.md`. Paths are the ones ADR 0011 fixes; a file named here that does not exist yet is created in that place by the first feature that needs it.

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
- [ ] `test/<module>.test.ts`: per endpoint the access cases of `apps/api/CLAUDE.md` (success, `401` without a session or with the other kind, `404` for another customer's record, the route's own `403`s); the spec's numbered rules each have a test; money paths have concurrency and double-submit tests; seeded rows removed in `afterAll`.
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

The current best example of each kind. When a feature becomes the better pattern, update its row in the same PR.

| Need | Copy from |
|---|---|
| Contract: entity, inputs, list query, page | `packages/contracts/src/audit.ts`, `customers.ts` (cursor list: `lists.ts`) |
| Ledger posting and its concurrency tests | `apps/api/src/modules/wallet/wallet-adjustments.service.ts` (lock, idempotency replay, journal + audit + email in one transaction), `apps/api/test/wallet.test.ts` (parallel debits, reversals, one key in parallel), `packages/db/src/ledger/wallet.test.ts` |
| Order transition and its tests | `packages/db/src/orders/` (`transition.ts`: `UPDATE … WHERE status = <from>` with its event, null on a lost race; `outcome.ts`: order then attempt `FOR UPDATE`, a result only on an open attempt; `purchase.ts`: a key's advisory lock, then replay; `OrderError` with its code), `orders.test.ts` (parallel purchases, one key in parallel, a waiting repricing, a webhook and a poll at once, guards for the app role and the owner); API: `apps/api/src/modules/orders/order-decisions.service.ts` (a decision's key replayed after waiting on the lock), `apps/api/test/orders.test.ts` |
| A write path shared by the API and the worker, with bulk reads and locks in id order | `packages/db/src/pricing/` (`routing.ts`: facts read in bulk then decided by the contracts' pure rules; `reprice.ts`: games `FOR SHARE`, products `FOR UPDATE`, each in id order), `reprice.test.ts` (parallel callers on one row) |
| Secrets at rest (AES-256-GCM, associated data, key version) | `packages/db/src/suppliers/credentials.ts` and its test; the key from the environment, derived locally, required in production (`apps/api/src/core/config/env.ts` `SUPPLIER_KEYS_SECRET`) |
| Supplier adapter with fixtures | `packages/suppliers/src/wdgzone/` (`SupplierHttp` with status and headers, errors mapped per code, pages read within a rate limit, polling and webhooks by the supplier's order id, HMAC over the raw body), `adapter.test.ts` against the local fake server with recorded fixtures, `docs/suppliers/wdgzone.md` |
| API module, controllers, service, integration test | `apps/api/src/modules/audit/`, `apps/api/test/audit.test.ts`; a paged list (`page`, `pageSize`, `total`) and archive/restore/reorder under parent locks: `apps/api/src/modules/catalog/` (`catalog.service.ts` `games`, `catalog-records.ts`), `apps/api/test/catalog.test.ts`; a public immutable image route and an admin upload: `catalog.controller.ts`, `catalog.admin.controller.ts`; a module above another that changes its rows in the caller's transaction (`CatalogItemsService.lockProduct`, `importProductsIn`) and per-row refusals in `details.rows`: `apps/api/src/modules/suppliers/`, `apps/api/test/suppliers.test.ts`; decisions each in its own transaction with a result per item: `PricingService.decide` |
| Worker job with retries and idempotency | `apps/worker/src/jobs/deposits/usdt-verify.job.ts`, `usdt-scan.job.ts` (state re-read under the row lock, retries from a stored start time, reader errors never conclude); a job that calls a supplier: `apps/worker/src/jobs/suppliers/` (`SupplierRegistry.connect`, `recordedCall`, the call outside the transaction, one run at a time by a partial unique index, `sanitizedMessage`), tested with scripted adapters in rolled-back transactions (`test/suppliers.test.ts`); an order job: `apps/worker/src/jobs/orders/` (the attempt committed before the call, the answer applied under the order lock by the write path, the sweep only queuing the owning jobs), tested with the in-process fake supplier in rolled-back transactions and a committed race on its own offer (`test/orders.test.ts`) |
| Admin list page with URL filters, cursor list, detail sheet | `apps/admin/src/features/audit/` |
| Admin form dialog with a one-time secret | `apps/admin/src/features/customers/test-customers-page.tsx` |
| Admin review page with a decision form, dialogs and a polled navigation badge | `apps/admin/src/features/deposits/` (`transfers-page.tsx`: a dialog that picks a customer, then opens another module's form prefilled) |
| Admin detail page with tabs in the URL, dialogs by kind, image uploads, archive filters | `apps/admin/src/features/catalog/` |
| Admin rows selected across pages into an all-or-nothing dialog; a tree read level by level; a server draft sent whole | `apps/admin/src/features/suppliers/` (`offers-tab.tsx`, `import-dialog.tsx`, `catalog-tab.tsx`, `import-category-sheet.tsx`) |
| Admin decision list with a bulk action and a result per row | `apps/admin/src/features/pricing/reviews-page.tsx` |
| Admin decision panel: one re-authenticated dialog per decision with its `Idempotency-Key`; a live board on stream events | `apps/admin/src/features/orders/` (`order-page.tsx`, `live-page.tsx`, `live-sheet.tsx`) |
| Admin profile with tabs each read on its own, a status-dependent actions menu | `apps/admin/src/features/customers/` |
| Admin money dialog across two currencies; client-sorted report tables with an `.xlsx` download | `apps/admin/src/features/reconciliation/`, `apps/admin/src/features/reports/` |
| Admin money dialog (re-authentication, `Idempotency-Key`, typed confirmation) | `apps/admin/src/features/wallet/adjust-dialog.tsx`, `adjustment-form.tsx` (`useIdempotencyKey`, refusals by field), `wallet.queries.ts` |
| Public page rendered per request (never cached) with the visitor's address passed to the API | `apps/store/src/features/shares/` (`data.ts`, `metadata.ts`, a server card with a client time island; S10) |
| Store page with cached reads | `apps/store/src/features/catalog/` (`data.ts`: `'use cache'` + `cacheTag` + `cacheLife` over the API's public routes, read after `connection()` inside `<Suspense>` so the build never calls the API; `home-page.tsx`, `game-page.tsx` server components; prices rendered on the server and passed as `children` to client parts; heavy client parts through `next/dynamic`), the revalidation route `apps/store/src/app/%5Finternal/revalidate/route.ts` with `revalidation.ts`, `sitemap.ts`; E2E with the server-side catalog served by `apps/store/e2e/catalog-server.mjs` (`catalog.spec.ts`) |
| A cached part on every page that must never break it, and a dismissal that must not flash | `apps/store/src/features/content/` (S14: `data.ts` `siteContent()` answers null on a failed read; `announcement.tsx` a server-rendered bar with a constant script after it and one small client button, `dismissal.ts`; `site-links.tsx` footer links under `<Suspense>`), E2E against a third store reading other server-side fixtures (`apps/store/e2e/content.spec.ts`, `CONTENT_STORE_URL`) |
| Admin text editor with a live store preview, revisions and versions | `apps/admin/src/features/content/` (S14: `page-editor.tsx` problems by line from the contracts' parser, `StorePreview` at phone and desktop widths, Ctrl+S, the stale dialog, `useBlocker`; `faq-page.tsx` move buttons and native drag over one order list; `banner-dialog.tsx` an upload with refusals by reason; presentational parts shared with the store in `packages/ui`: `RichText`, `ActivityFeed`, `AnnouncementBar`), `apps/admin/e2e/content-mock.ts` with `content.spec.ts` |
| Store money form with a slider and a live check | `apps/store/src/features/purchase/` (`buy-box.tsx`: details then confirmation, `SlideToPay` from `packages/ui`, one `Idempotency-Key` per body with retry, refusals by code; `player-check.ts`: debounced, deduplicated per visit; `draft.ts`: fields kept in session storage through a sign-in), `apps/store/e2e/purchase.spec.ts` |
| Store page read in the browser with the session (no cache) | `apps/store/src/features/wallet/` (`requests.ts` with its test, skeleton, error, sign-in redirect, load more), the header chip `balance-chip.tsx`; a dynamic `[id]` route (`useParams` under `<Suspense>`, `notFound()`), multipart upload and a money form with `Idempotency-Key` and ALTCHA: `apps/store/src/features/deposits/`; a page that polls while open (10 s visible, 30 s hidden) with one view per sub-state: `usdt-deposit.tsx`; a list of cards and a detail page with a per-row action (a code revealed, then copied): `apps/store/src/features/orders/`; state kept on the device in `localStorage` (versioned, try/catch, a light key module for the header, `useSyncExternalStore`) with an all-or-nothing money action and refusals per row: `apps/store/src/features/cart/` (S10); a thread with multipart replies, refetched on a notification event, and a session flag disabling money controls across pages (frozen banner): `apps/store/src/features/support/`, `src/components/frozen-banner.tsx` (S12) |
| Customer notification and its email from a change | `notifyCustomer` in `packages/db/src/notifications` (API: `NotificationsService.notifyCustomer(tx, …)`; worker: `notifyCustomer(tx, bossJobSender(boss), …)`), tests in `notify-customer.test.ts` |
| Live updates over SSE | `apps/api/src/modules/notifications/notification-stream.service.ts` (one `LISTEN` per process, fan-out by customer, heartbeat, session re-check, `resync`), `apps/api/test/notifications.test.ts` (an SSE reader over `fetch`); store: `apps/store/src/features/notifications/live.ts` (`useNotificationEvents`), the E2E mock `api.stream(...)`; admin: `apps/admin/src/lib/admin-stream.ts`, the E2E mock `admin.stream` (`apps/admin/e2e/live.spec.ts`: an event moving a card, with no reconnect) |
| Telegram bot flow and its jobs | `apps/api/src/modules/telegram/telegram-bot.service.ts` (buttons and prompts, decisions through the domain service with the channel `telegram`), `apps/api/test/telegram-decisions.test.ts` (webhook updates, races with the panel); worker: `apps/worker/src/jobs/telegram/deposit-card.job.ts` (send once, edit to the outcome), `review-reminder.job.ts` (a scheduled job with fixed instants), `test/telegram-jobs.test.ts` (jobs in a rolled-back transaction) |
| A PWA and a browser capability behind a tap (S15) | `apps/store/src/features/pwa/` (a constant service worker tested by running it against fakes, routes read per request for their headers, an inline registration in the layout), `apps/store/src/features/push/` (pure rules apart from the browser calls, a light gate loading the card with `next/dynamic`), E2E with the browser API replaced in the page (`apps/store/e2e/push-browser.ts`) and the real worker only in `pwa.spec.ts` |
| E2E flow and screenshots | `apps/store/e2e/accounts.spec.ts`, `apps/admin/e2e/accounts.spec.ts`; a stateful money mock: `apps/admin/e2e/wallets.spec.ts` and `deposits.spec.ts` with their state in `e2e/test.ts`; a whole module's mock with the spec's rules in its own file: `apps/admin/e2e/catalog-mock.ts` (used by `catalog.spec.ts`, `pricing.spec.ts`), and one built on another with the contracts' pure rules and a test's scripted changes: `apps/admin/e2e/suppliers-mock.ts` (`suppliers.spec.ts`), and S16's `apps/admin/e2e/supplier-catalog-mock.ts` built on both (`supplier-catalog.spec.ts`); store flows with images and multipart: `apps/store/e2e/deposits.spec.ts`; a module mock on the contracts' decision rule with key replays: `apps/admin/e2e/orders-mock.ts` (`orders.spec.ts`); store: `apps/store/e2e/orders.spec.ts`; the books, treasury and reports on the contracts' posting rules: `apps/admin/e2e/reconciliation-mock.ts` (`reconciliation.spec.ts`, `reports.spec.ts`, S13); device state seeded once per test and server-rendered public pages fed by the catalog server (with the forwarded address checked): `apps/store/e2e/convenience.spec.ts` (S10) |
