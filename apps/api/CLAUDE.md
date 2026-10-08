# apps/api

NestJS 12 HTTP API, a modular monolith (ADR 0001, 0002). Code shape: ADR 0011. Access: ADR 0007. Protection: ADR 0008.

## Layout
- `src/main.ts` (imports `instrument.ts` first: Sentry), `src/app.module.ts` (global pipe, serializer, error filter, guards), `src/app.setup.ts` (shared by `main.ts` and the tests: prefix `/api`, trust proxy on loopback, origin check, Better Auth handlers, OpenAPI at `/api/docs` outside production).
- `src/core/`: infrastructure, no business logic. `config` (Zod env), `database` (`DATABASE` token, app role), `access` (decorators and `AccessGuard`), `errors` (`CodedException`, `ErrorFilter`, validation pipe), `rate-limit` (also `sign-in-failures.ts`), `altcha`, `http/` (`same-origin.ts`, `request-meta.ts`, `api-query.ts`, `idempotency-key.ts`: `@IdempotencyKey()` and `@ApiIdempotencyKey()` for money routes), `jobs` (`JobsService.send(tx, …)`: pg-boss jobs in the caller's transaction), `lists/cursor.ts` (cursor lists).
- `src/modules/<module>/`: one folder per domain module (`docs/architecture.md`). Now: `auth` (customer Better Auth instance, account changes, profile, test customers), `admin` (admin Better Auth instance, CLI account functions, the admin's own account), `audit` (the audit log), `notifications` (the email outbox), `wallet` (balances, timelines, adjustments, the ledger summary), `rates` (the exchange rate; `RatesService.current()` for other modules), `health`.
- `src/cli/`: `openapi.ts`, `create-admin.ts`, `reset-password.ts`, `reset-two-factor.ts`. `test/`: integration tests over HTTP against the test database.

## A module
- Files: `<module>.module.ts`, `<module>.controller.ts` (customer routes), `<module>.admin.controller.ts` (admin routes under `admin/`), `<module>.service.ts`, `index.ts` (public surface). Kebab-case, one exported class per file. Pattern to copy: `src/modules/health/`.
- Controller: parameters validated with `{ schema }` from `@vertex-digital/contracts` (`@Body({ schema })`, `@Query({ schema })` plus `@ApiQueryOf(schema)` so OpenAPI lists the filters), responses shaped with `@SerializeOptions({ schema })` (an array response gives the item schema: Nest serializes item by item), documented with `@Api*Response({ standardSchema })`, then one call to the service. No logic. Pattern to copy: `src/modules/auth/auth.controller.ts`.
- Service: logic and Drizzle queries through `@Inject(DATABASE)`; no repository layer. Multi-row changes in `db.transaction`, with the audit entry (`recordAudit(tx, …)` from `@vertex-digital/db`), emails (`NotificationsService.queueEmail(tx, …)`) and jobs (`JobsService.send(tx, …)`) in the same transaction (ADR 0011). Pattern to copy: `src/modules/auth/auth-account.service.ts`.
- Register the module in `src/app.module.ts` through its `index.ts`. A new schema file in `packages/db` gets an owner in `TABLE_OWNERS` (`test/architecture.test.ts`).
- After changing a route or a contract it uses: `pnpm --filter @vertex-digital/api build`, then `pnpm --filter @vertex-digital/api openapi:export`, and commit `apps/api/openapi.json` (CI fails when it is stale).

## Access (ADR 0007)
- Every route has exactly one of `@Public()`, `@CustomerRoute()`, `@AdminRoute()`, `@AdminSetupRoute()` from `src/core/access/`. `AccessGuard` refuses a route with none. Module code imports `core/access/index.ts` (decorators only); the guard is imported by `app.module.ts` from its own file, since it reads the modules.
- `@CustomerRoute()`: customer session cookie, email verified (`403 EMAIL_NOT_VERIFIED`). `@AdminRoute()`: admin session cookie, not idle for 30 minutes (`401 SESSION_IDLE_EXPIRED`, the session is deleted), no pending password change (`403 PASSWORD_CHANGE_REQUIRED`), TOTP enrolled (`403 TWO_FACTOR_REQUIRED`); no roles or permissions, one admin with full access (ADR 0016). `@AdminSetupRoute()` skips the last two (the forced password change). Add `@Sensitive()` to an admin route that needs a re-authentication in the last 5 minutes (`403 REAUTHENTICATION_REQUIRED`). A request with `X-Background-Request: 1` (the panel's own polling) does not count as activity. Read the caller with `@CurrentCustomer()` / `@CurrentAdmin()`.
- Admin routes live under `admin/` (so `/api/admin/...`), and only admin routes do. Services apply record scopes (a customer's own records) as `where` filters: never return another customer's record.
- The two Better Auth instances are mounted in `app.setup.ts` at `/api/auth` and `/api/admin/auth`, each with its own secret, tables and cookie name. Better Auth keeps the sign-in, sign-out, sessions and TOTP; every path in `CUSTOMER_AUTH_NEST_PATHS` / `ADMIN_AUTH_NEST_PATHS` is passed on to a Nest route instead, so the change, its audit entry and its emails share one transaction. Changes the Better Auth plugins make (TOTP enabled, backup codes, the TOTP sign-in step) are audited right after, from its hooks. Customer sign-up is open only when `REGISTRATION_OPEN=true`.

## Protection (ADR 0008)
- `sameOriginOnly`: `/api/admin/*` refuses browser requests from any origin but `ADMIN_URL`; other routes refuse state changes from any origin but `STORE_URL` (`403 CROSS_ORIGIN_REFUSED`).
- Rate limits: a default per IP on every route; tighten one with `@RateLimit({ limit, perSeconds })`. Every new public route that changes state gets one, and a test that it refuses abuse. Counters that must survive a restart go in PostgreSQL: the email-code and sign-up limits use `modules/auth/rate-counter.ts` (`customer_rate_limits`).
- ALTCHA: `@RequireAltcha()` checks the `X-Altcha` header (sign-up, OTP requests, password reset, deposit and ticket creation). Challenges come from `GET /api/altcha/challenge`.

## Errors
- Every error answers `{ statusCode, code, message, details? }` (`ErrorFilter`). Throw `new CodedException(status, 'CODE', message, details?)` when the UI must tell the error apart; the code is added to `ERROR_CODES` in contracts with its first use. Server faults answer `500 INTERNAL_ERROR` without internals and go to the logs and Sentry.
- Messages are English, for logs. Logs go through the Nest logger (pino), never `console.log`; cookies, authorization and ALTCHA headers are redacted.

## Rules to apply yourself
- ESM: relative imports end in `.js`. No speculative helpers: they arrive with their first use.
- Money routes: `@IdempotencyKey()` with a replay of the first result (`201` written, `200` replayed); the wallet row is locked first so parallel requests with one key or one reversal queue instead of meeting the balance check. Pattern to copy: `src/modules/wallet/wallet-adjustments.service.ts`, `test/wallet.test.ts` (concurrency and double submit).
- Never log or return tokens, passwords, TOTP secrets, receipts or personal data beyond what the caller may see.

## Tests
`test/<module>.test.ts` over HTTP: start the app with `startApp({ controllers })` from `test/start-app.ts`; seed accounts with `seedCustomer` / `seedAdmin` (removes any earlier admin: there is only one) and sign in with `api(url).signInCustomer` / `signInAdmin` / `adminWithTotp` from `test/helpers.ts`; remove them with `removeAccounts` in `afterAll` (a customer with a wallet stays: the ledger references it for good); read queued emails and codes with `emailsTo` / `lastCode`, audit entries with `auditOf`, and solve ALTCHA with `api(url).altcha()`. Every endpoint covers success, 401, 401/403 (a customer session on an admin route, an admin session on a customer route) and another customer's record. `test/probe.controller.ts` holds test-only routes for the core. Files run one at a time (`fileParallelism: false`). Vitest emits decorator metadata through oxc (`vitest.config.ts`); no SWC.

Run: `pnpm --filter @vertex-digital/api test` (needs the test database URLs in `.env`) · `pnpm --filter @vertex-digital/api typecheck`.
