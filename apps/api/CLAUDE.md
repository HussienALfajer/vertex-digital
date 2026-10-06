# apps/api

NestJS 12 HTTP API, a modular monolith (ADR 0001, 0002). Code shape: ADR 0011. Access: ADR 0007. Protection: ADR 0008.

## Layout
- `src/main.ts` (imports `instrument.ts` first: Sentry), `src/app.module.ts` (global pipe, serializer, error filter, guards), `src/app.setup.ts` (shared by `main.ts` and the tests: prefix `/api`, trust proxy on loopback, origin check, Better Auth handlers, OpenAPI at `/api/docs` outside production).
- `src/core/`: infrastructure, no business logic. `config` (Zod env), `database` (`DATABASE` token, app role), `access` (decorators and `AccessGuard`), `errors` (`CodedException`, `ErrorFilter`, validation pipe), `rate-limit`, `altcha`, `http/same-origin.ts`.
- `src/modules/<module>/`: one folder per domain module (`docs/architecture.md`). Now: `auth` (customer Better Auth instance), `staff` (staff Better Auth instance, CLI account functions), `health`.
- `src/cli/`: `openapi.ts`, `create-owner.ts`, `reset-two-factor.ts`. `test/`: integration tests over HTTP against the test database.

## A module
- Files: `<module>.module.ts`, `<module>.controller.ts` (customer routes), `<module>.admin.controller.ts` (staff routes under `admin/`), `<module>.service.ts`, `index.ts` (public surface). Kebab-case, one exported class per file. Pattern to copy: `src/modules/health/`.
- Controller: parameters validated with `{ schema }` from `@vertex-digital/contracts` (`@Body({ schema })`), responses shaped with `@SerializeOptions({ schema })`, documented with `@Api*Response({ standardSchema })`, then one call to the service. No logic.
- Service: logic and Drizzle queries through `@Inject(DATABASE)`; no repository layer. Multi-row changes in `db.transaction`, with the audit entry and any job in the same transaction (ADR 0011).
- Register the module in `src/app.module.ts` through its `index.ts`. A new schema file in `packages/db` gets an owner in `TABLE_OWNERS` (`test/architecture.test.ts`).
- After changing a route or a contract it uses: `pnpm --filter @vertex-digital/api build`, then `pnpm --filter @vertex-digital/api openapi:export`, and commit `apps/api/openapi.json` (CI fails when it is stale).

## Access (ADR 0007)
- Every route has exactly one of `@Public()`, `@CustomerRoute()`, `@StaffRoute(...permissions)` from `src/core/access/`. `AccessGuard` refuses a route with none.
- `@CustomerRoute()`: customer session cookie, email verified (`403 EMAIL_NOT_VERIFIED`). `@StaffRoute()`: staff session cookie, TOTP enrolled (`403 TWO_FACTOR_REQUIRED`), every listed permission from the map in `packages/contracts/src/staff.ts` (`403 FORBIDDEN`). Read the caller with `@CurrentCustomer()` / `@CurrentStaff()`.
- Staff routes live under `admin/` (so `/api/admin/...`), and only staff routes do. Services apply record scopes (a customer's own records) as `where` filters: never return another customer's record.
- The two Better Auth instances are mounted in `app.setup.ts` at `/api/auth` and `/api/admin/auth`, each with its own secret, tables and cookie name. Customer sign-up stays disabled until F01 adds email OTP, phone, ALTCHA and per-email limits.

## Protection (ADR 0008)
- `sameOriginOnly`: `/api/admin/*` refuses browser requests from any origin but `ADMIN_URL`; other routes refuse state changes from any origin but `STORE_URL` (`403 CROSS_ORIGIN_REFUSED`).
- Rate limits: a default per IP on every route; tighten one with `@RateLimit({ limit, perSeconds })`. Every new public route that changes state gets one, and a test that it refuses abuse. Counters that must survive a restart (OTP, deposits) go in PostgreSQL with their feature.
- ALTCHA: `@RequireAltcha()` checks the `X-Altcha` header (sign-up, OTP requests, password reset, deposit and ticket creation). Challenges come from `GET /api/altcha/challenge`.

## Errors
- Every error answers `{ statusCode, code, message, details? }` (`ErrorFilter`). Throw `new CodedException(status, 'CODE', message, details?)` when the UI must tell the error apart; the code is added to `ERROR_CODES` in contracts with its first use. Server faults answer `500 INTERNAL_ERROR` without internals and go to the logs and Sentry.
- Messages are English, for logs. Logs go through the Nest logger (pino), never `console.log`; cookies, authorization and ALTCHA headers are redacted.

## Rules to apply yourself
- ESM: relative imports end in `.js`. No speculative helpers: they arrive with their first use.
- Never log or return tokens, passwords, TOTP secrets, receipts or personal data beyond what the caller may see.

## Tests
`test/<module>.test.ts` over HTTP: start the app with `startApp({ controllers })` from `test/start-app.ts`; seed accounts with `seedCustomer` / `seedStaff` and sign in with `api(url).signInCustomer` / `signInStaff` / `staffWithTotp` from `test/helpers.ts`; remove them with `removeAccounts` in `afterAll`. Every endpoint covers success, 401, 403 (wrong role, or customer on a staff route) and another customer's record. `test/probe.controller.ts` holds test-only routes for the core. Files run one at a time (`fileParallelism: false`). Vitest emits decorator metadata through oxc (`vitest.config.ts`); no SWC.

Run: `pnpm --filter @vertex-digital/api test` (needs the test database URLs in `.env`) · `pnpm --filter @vertex-digital/api typecheck`.
