# apps/api

NestJS 12 HTTP API, a modular monolith (ADR 0001, 0002). Code shape: ADR 0011. Access: ADR 0007, 0016. Protection: ADR 0008. Money, orders, suppliers: ADR 0003–0005. Module map (tables, routes, owners): `docs/architecture.md`.

## Layout
- `src/main.ts` (imports `instrument.ts` first: Sentry) · `src/app.module.ts` (global pipe, serializer, error filter, guards) · `src/app.setup.ts` (shared by `main.ts` and the tests: prefix `/api`, trust proxy on loopback, `sameOriginOnly`, `privateNoStore`, Better Auth handlers, OpenAPI at `/api/docs` outside production).
- `src/core/`: infrastructure, no business logic: `config` (Zod env; `routing-context.ts`), `database` (`DATABASE` token, app role; `isUniqueViolation`, `violatedConstraint`), `access`, `errors`, `rate-limit`, `altcha`, `http` (same-origin, request id and meta, `api-query.ts`, `idempotency-key.ts`, secret scrubbing, `private-no-store.ts`), `jobs`, `lists/cursor.ts`, `images/pango-text.ts` (fonts and text blocks for generated images).
- `src/modules/<module>/`: one folder per domain module, named as in `docs/architecture.md`; list the folder for the current set.
- `src/cli/`: entry points of the package scripts in the root `AGENTS.md` commands table; `seed-local.ts` drives `cli/seed/` through the services.
- `test/`: integration tests over HTTP against the test database.

## A module
- Files: `<module>.module.ts`, `<module>.controller.ts` (customer and public routes), `<module>.admin.controller.ts` (admin routes under `admin/`), `<module>.service.ts` (split by topic as `<module>-<topic>.service.ts`), `index.ts` (the only import surface for other modules). Kebab-case, one exported class per file. Pattern: `src/modules/health/`.
- Controller: validate with contract schemas (`@Body({ schema })`, `@Query({ schema })` plus `@ApiQueryOf(schema)` so OpenAPI lists the filters),
  shape with `@SerializeOptions({ schema })` (an array response gives the item schema), document with `@Api*Response({ standardSchema })`, then one service call. No logic. Pattern: `src/modules/auth/auth.controller.ts`.
- Service: logic and Drizzle queries through `@Inject(DATABASE)`; no repository layer; query only the module's own tables.
  Multi-row changes in `db.transaction`, with `recordAudit(tx, …)`, emails (`NotificationsService.queueEmail(tx, …)`, or `notifyCustomer(tx, …)` for any customer event) and jobs (`JobsService.send(tx, …)`) in the same transaction. Pattern: `src/modules/auth/auth-account.service.ts`.
- Register the module in `src/app.module.ts` through its `index.ts`. A new schema file in `packages/db` gets an owner in `TABLE_OWNERS` (`test/architecture.test.ts`).
- Module imports are one-way (there is no `forwardRef` in the app): before importing a module, check it does not import yours, directly or through another.
- After changing a route or a contract it uses: build, `pnpm --filter @vertex-digital/api openapi:export`, then `pnpm --filter @vertex-digital/admin api:generate`; commit `apps/api/openapi.json` and `apps/admin/src/lib/api/schema.gen.ts` (`pnpm verify` and CI fail on drift).

## Access
- Every route has exactly one of `@Public()`, `@CustomerRoute()`, `@AdminRoute()`, `@AdminSetupRoute()` (`src/core/access/`); `AccessGuard` refuses a route with none and the architecture test fails. Module code imports `core/access/index.ts`; only `app.module.ts` imports the guard's file.
- Admin routes live under `admin/` (`/api/admin/...`), and only admin routes do. One admin account with full access: no roles or permissions (ADR 0016).
- Customer routes read only the customer cookie, admin routes only the admin cookie: a session of the other kind is `401 UNAUTHORIZED`, like no session.
- `@CustomerRoute()`: email verified, else `403 EMAIL_NOT_VERIFIED`. `@AdminRoute()`: not idle 30 minutes (`401 SESSION_IDLE_EXPIRED`), no pending password change (`403 PASSWORD_CHANGE_REQUIRED`), TOTP enrolled (`403 TWO_FACTOR_REQUIRED`). `@AdminSetupRoute()` skips the last two.
- `@Sensitive()` on an admin route needs a re-authentication in the last 5 minutes (`403 REAUTHENTICATION_REQUIRED`). When the need depends on the request (e.g. an approval above a threshold), the service calls `isRecentlyReauthenticated(admin)` instead.
- Which routes are `@Sensitive()` and each route's rate limits come from the module's spec (`docs/specs/`, its "Access" table); add both with the route.
- `X-Background-Request: 1` (panel polling) and `@NoActivity()` routes do not count as admin activity. Read the caller with `@CurrentCustomer()` / `@CurrentAdmin()`; long streams re-check the session with `@CustomerSessionCheck()` / `@AdminSessionCheck()`.
- Record scopes are `where` filters in the service: never return another customer's record (answer 404).
- Two Better Auth instances in `app.setup.ts`: `/api/auth` and `/api/admin/auth`, each with its own secret, tables and cookie.
  Better Auth keeps sign-in, sign-out, sessions and TOTP; paths in `CUSTOMER_AUTH_NEST_PATHS` / `ADMIN_AUTH_NEST_PATHS` go to Nest routes so the change, audit and emails share one transaction. Plugin changes (TOTP enabled, backup codes, TOTP sign-in) are audited from its hooks.
- Every check of the admin's password or re-authentication code (Nest routes and Better Auth's `/two-factor/enable`, `/generate-backup-codes`) counts in `countAdminPasswordCheck` (10 per 15 minutes; only a passing re-authentication clears it). The TOTP and backup-code steps refuse an HTTP call on an enrolled admin's session.
- Customer sign-up is open only while the `registration_open` switch is on; the sign-up stores the terms versions in force (`acceptedVersionsNow`).
- Passkeys (`modules/auth/passkeys.plugin.ts`): challenges used once, user verification required, the counter checked after the signature (`recordUse`); adding needs the password grant; 10 per customer, written under the customer's lock; a password reset deletes them all.

## Protection
- `sameOriginOnly`: `/api/admin/*` refuses browser requests from any origin but `ADMIN_URL`; other routes refuse state changes from any origin but `STORE_URL` (`403 CROSS_ORIGIN_REFUSED`).
- `privateNoStore` answers `no-store` under `/api/admin`, `/api/auth`, `/api/account`; a route that sets its own `Cache-Control` replaces it. Customer-specific answers elsewhere set `private, no-store` themselves.
- Rate limits: a default per IP on every route; tighten with `@RateLimit({ limit, perSeconds })`. Every public route that changes state gets one and a test that it refuses abuse. The store server's cached reads (loopback GET with `X-Store-Cache-Read: 1` and no `X-Forwarded-For`) skip the counter (`isStoreCacheRead`); so does the public catalog image route (`@SkipThrottle`: a page asks for dozens, nginx's `vdimage` zone counts them).
- Limits that must survive a restart (codes, sign-up, per-customer quotas) use `withinLimits` / `countHit` from `@vertex-digital/db` (`customer_rate_limits`), not the in-memory throttler.
- ALTCHA: `@RequireAltcha()` checks `X-Altcha` (sign-up, OTP requests, password reset, deposit and ticket creation); challenges from `GET /api/altcha/challenge`.
- Public webhooks are capped at 64 KB (`telegram/webhook-body-limit.ts`, `suppliers/webhook-body.ts`). The supplier intake reads the raw body before the JSON parser, verifies it with the supplier's adapter from `@vertex-digital/suppliers`, stores it once encrypted and queues `suppliers.webhook`.

## Errors and logs
- Every error answers `{ statusCode, code, message, details? }` (`ErrorFilter`). Throw `new CodedException(status, 'CODE', message, details?)` when the UI must tell it apart; add the code to `ERROR_CODES` in contracts with its first use.
  Map domain errors from `packages/db` (`OrderError`, `LedgerError`, …) to coded answers in the module. Faults answer `500 INTERNAL_ERROR` without internals.
- Every request has a UUID in `X-Request-Id`, tagged on its Sentry event. Sentry's `beforeSend` is `scrubEvent` (`core/http/secret-headers.ts`). The panel's crashes arrive at `POST /api/admin/client-errors`. Live streams end in `beforeApplicationShutdown`.
- Messages are English, for logs. Log through the Nest logger (pino), never `console.log`; cookies, authorization and ALTCHA headers and private query values (`q`) are redacted in logs and Sentry. Never log or return tokens, passwords, TOTP secrets, receipts or personal data beyond what the caller may see.

## Rules to apply yourself
- ESM: relative imports end in `.js`. No speculative helpers.
- Money routes: `@IdempotencyKey()` + `@ApiIdempotencyKey()`, replaying the first result (`201` written, `200` replayed; another body with the same key is refused); lock the wallet row first so parallel requests queue instead of racing the balance check. Pattern: `src/modules/wallet/wallet-adjustments.service.ts`, `test/wallet.test.ts`.
- A write that claims a payment reference and credits a wallet locks the wallet first (`lockCustomerWallet`), then claims: the same order everywhere, or two writes for one customer deadlock.
- Every purchase and deposit creation locks the customer `FOR SHARE` first (`lockActiveCustomer`), then reads the switches with `SettingsService.valuesForCreation(tx)` under their shared lock.
- Inside a transaction never query through the pool (`RatesService.current(tx)`, `SettingsService.changeIn(tx, …)`, the `…(tx, …)` variants): a pool read while the transaction holds a connection and a lock can starve the pool. Reads in a transaction go through `readAll`, never parallel queries on one client (`packages/db/CLAUDE.md`).
- Prices are written only through `repriceProducts` / `appendProductPrice` from `packages/db` (ADR 0020); `core/config/routing-context.ts` gives them the time and the fake supplier's switch. Never sell below cost.
- Catalog locks: category, then game, then product; category and game `FOR NO KEY UPDATE` (an order's foreign key check must not wait); a move holds both categories in id order. A move, a select field's new options, or a game's/product's restore reprices the game in its transaction (`repriceGameProducts`).
- Pricing: list a rule's targets only after `CatalogService.lockPricingScope` has locked their categories and games `FOR SHARE`; lock the rule row `FOR NO KEY UPDATE` after the target's advisory lock, never `FOR UPDATE` (a repricing takes `FOR KEY SHARE` on it). Per-list rules take `ruleLock` per list and the list `FOR SHARE`.
- Route changes lock game then product and reprice in the same transaction; routes and imports refuse unsupported and ignored offers. Supplier catalog imports and links run under one advisory lock per supplier.
- Order decisions (poll, resolve, refund) lock the order first and replay the same key even after waiting on the lock. Order changes go through `packages/db/src/orders` with their audit entry; the key stays on the attempt it closed or delivered. A delivery proof is served only when an attempt of that order holds it.
- Support ticket writes: the ticket's advisory lock, then the customer `FOR SHARE` (`lockTicketCustomer`), then the ticket. Images are re-encoded before the transaction, only after the request's other refusals passed.
- Merchant approval and grant lock the customer, then the application. Merchant routes check `requireMerchant` (`NOT_MERCHANT`); frozen merchants read only.
- Every change a deposit's Telegram card shows queues `queueDepositCard`. Bot replies are outbox rows (`queueTelegramMessage`); the bot's deposit decisions run as a savepoint of the update's transaction; a button press is answered inline.
- Uploads: `FileInterceptor('file', { limits: { fileSize } })` (oversize is `413 PAYLOAD_TOO_LARGE`), `FilesService.prepare` before the transaction (size refusals in its `accept` check), `record` inside it; serve with `sendImage` (`modules/files/served-file.ts`). Pattern: `DepositsService.submitReceipt`.
- Store cache: an admin controller whose data the store shows uses `StoreRevalidateInterceptor` (`ContentRevalidateInterceptor` for content: the `content` tag only); a change that must refresh atomically (retail price list, content publish) queues `store.revalidate` in its transaction. The store's public reads never call a supplier.
- Generated images (`share-image.ts`, `price-list-image.ts`) escape every value in Pango markup. An export or statement is audited before it streams; a statement whose balance equation fails is an unhandled error, never a quiet answer.
- Lists: newest-first lists use `core/lists/cursor.ts` (`cursorTime`, `after`, `pageOf`; fetch `limit + 1`; the cursor keeps PostgreSQL's microsecond text, never a JS `Date`). Some admin tables use `page`/`pageSize` (ADR 0011); copy the module's existing list.

## Module notes (easy to miss)
- `settings`: a supplier's pause reprices its routed products; each change queues its Telegram notice.
- `rates`: a display step above 2% of the cheapest available product is refused (S07 rule P9).
- `pricing`: only write routes refresh the store, not the preview; only the retail list's changes queue `store.revalidate`; archiving a price list a live merchant level names is refused.
- `orders`: purchases through `purchaseOrder` (per-customer and per-address counters; a checkout counts as one request), panel purchases through `adminPurchaseOrder`. Player-check limits count supplier calls only.
- `support`: an admin reply on an archived customer's ticket is refused.
- `merchants`: tier level and settings changes run under one advisory lock, re-authenticated and audited, and requeue every merchant (`tiers_changed`); a tier's list must be the child of the tier below's. A grant and its end lock the customer and recompute inline; a revocation ends the open grant. Per-tier privileges (deposit limits, player checks, quantities) come from `merchantPrivileges` in `packages/db`. The merchant's tier routes never say where the tier comes from (granted or earned); the public certificate page answers the trade name, place and tier only. The `merchant_application` Telegram notice carries no personal data.
- `notifications`: push endpoints pass the contracts' `pushEndpointAllowed`; upsert by endpoint, 10 devices, under a per-customer advisory lock.
- `treasury`: a typed confirmation above $100 (SYP at today's rate).
- `catalog` quick links: internal targets only; an open is counted after the answer.
- `health` owns `worker_heartbeats` (the dashboard's `worker_silent` item).

## Tests
- `test/<module>.test.ts` over HTTP: `startApp({ controllers })` (`test/start-app.ts`); `seedCustomer` / `seedAdmin` (replaces any earlier admin); sign in with `api(url).signInCustomer` / `signInAdmin` / `adminWithTotp`; `removeAccounts` in `afterAll` (a customer with a wallet stays: the ledger references it).
  Helpers in `test/helpers.ts`: `emailsTo`, `lastCode`, `auditOf`, `api(url).altcha()`, `setSwitches` (e.g. open sign-up). Test-only core routes: `test/probe.controller.ts`.
- Access, on every endpoint: success; no session → `401`; a customer session on an admin route and an admin session on a customer route → `401`; another customer's record → `404`; plus the route's own `403`s (`EMAIL_NOT_VERIFIED`, `TWO_FACTOR_REQUIRED`, `REAUTHENTICATION_REQUIRED`).
- Money and fulfilment paths also test concurrency and a double-submitted `Idempotency-Key` (ADR 0011).
- Workers keep modules between files (`isolate: false`): leave nothing in module state. No `vi.mock` (the architecture test refuses it); spy on a method instead. `test/worker-env.ts` restores `process.env` and every `vi.spyOn` after each file.
- Leave no `supplier_calls` rows on the `fake` supplier (append-only; the worker's health tests read them): spy on `SupplierAdaptersService.recordCall` and test the write in a rolled-back transaction (`test/player-checks.test.ts`).
- Each Vitest worker has its own database (`test/global-setup.ts`, `test/worker-env.ts`, `packages/db/src/test-workers.ts`); files in one worker run in sequence, since rates and settings are global. Each app's pool opens at most 4 connections (`vitest.config.ts`). Decorator metadata comes from oxc; no SWC.
- Setup-file guards fail a file that sends a query on a pg client already running one (`test/no-concurrent-queries.ts`) or queries through the pool while the same request's transaction holds a connection (`test/no-pool-reads-in-transactions.ts`).
- Run only the files you work on, paths from the repo root: `pnpm verify apps/api/test/orders.test.ts apps/api/test/architecture.test.ts` (`--grep "<title>"` for some tests). Before the PR, `pnpm verify` once (`docs/testing.md`).
