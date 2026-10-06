# 0011 — Engineering conventions: layout, module anatomy, data, errors, tests

Status: Accepted · Date: 2026-10-06

## Context
V1 has about twenty API modules, a worker with money-moving jobs and two front ends, built by AI coding agents across many sessions (ADR 0010). Without one written shape each session invents its own and the codebase drifts. Rules that live only in prose are followed unevenly, so every rule a machine can check is enforced by a test or lint rule. These conventions follow the ones proven in Vertex Hub, adapted to this system.

## Decision

### Layout
- `apps/api/src/`: `main.ts`, `app.module.ts`, `app.setup.ts`; `core/` (config, database, access decorators, errors, jobs, SSE, rate limits); `modules/<module>/` for domain modules named as in `docs/architecture.md`; `cli/` for command-line entry points.
- `apps/worker/src/`: `core/` and `jobs/<area>/` (one file per queue, `<name>.job.ts`); Telegram bot under `telegram/`.
- `apps/store/src/`: `app/` (Next.js routes, thin: data loading and layout), `features/<area>/` (components, server data functions, actions of one area), `components/` (app-wide), `lib/` (API client, formatting, cache tags), `messages/` (Arabic catalog).
- `apps/admin/src/`: `routes/` (TanStack file routes, thin), `features/<module>/` (queries, mutations, components, forms), `components/`, `lib/`, `i18n/`.
- `packages/contracts/src/<module>.ts` and `packages/db/src/schema/<module>.ts`: one file per owning module. `packages/db/src/ledger/` and `packages/db/src/orders/` hold the shared write paths (ADR 0003, 0004).
- `packages/suppliers/src/<code>/`: one folder per adapter (`adapter.ts`, `schemas.ts`, `errors.ts`, `fixtures/`, tests) and `src/core/` for the interface and shared HTTP and HMAC helpers.

### API module anatomy
- Files: `<module>.module.ts`, `<module>.controller.ts` (customer routes), `<module>.admin.controller.ts` (staff routes under `/api/admin/`), `<module>.service.ts`, `index.ts`. A large service splits by topic (`<module>-<topic>.service.ts`). Kebab-case file names with a role suffix; one exported class per file.
- `index.ts` is the module's public surface. Code outside the folder imports only from it.
- No repository layer: services query Drizzle directly. Controllers are thin: validate with contract schemas, document for OpenAPI, delegate.
- A module queries only the tables it owns; other modules' data comes through their exported services.

### Access
- Every route declares who may call it: `@CustomerRoute()` (signed-in, verified customer), `@StaffRoute(permission…)` (staff with TOTP and the permission), or `@Public()`. A route with none fails the architecture test. Staff routes are only under `/api/admin/`.
- State-changing customer routes on money (deposits, purchases) also declare their rate limit and require `Idempotency-Key`.

### Contracts
- Schemas `<thing>Schema`, types `Thing = z.infer<…>`, inputs `create<Thing>Schema` / `update<Thing>Schema`; every schema in the API has `.meta({ id })`.
- Contracts hold shapes and pure rules only (money math, state transition tables, pricing, permission map): no I/O, no framework imports, 100% unit-tested.

### Data
- Business table: `{ id: id(), ...fields, ...timestamps(), archivedAt: archivedAt() }` from `packages/db/src/schema/columns.ts`; tables plural snake_case. Ledger, event and audit tables are append-only and have no `archived_at`/`updated_at`.
- UUIDv7 ids generated in the application; `timestamptz` in UTC, displayed in `Asia/Damascus`; every foreign key indexed; no floating-point columns.
- Money (ADR 0003): `bigint` units with a currency (or a currency-fixed name), helpers in `columns.ts`; exchange rates `numeric`.
- Idempotency keys and external references (supplier attempt ids, Sham Cash transaction numbers, `(network, txid)`, supplier event ids) have unique indexes: the database, not the code, is the last line against duplicates.
- Migrations come from `pnpm db:generate` and are never edited; hand-written SQL (triggers, grants, data fixes) goes in custom migrations.
- Multi-row changes run in `db.transaction`; the audit entry and any job (pg-boss `send` on the same connection) are written in the same transaction.

### Errors
- Services throw Nest's `HttpException` family; errors the UI must tell apart carry a stable code: `{ statusCode, code, message }` (`PRICE_CHANGED`, `INSUFFICIENT_BALANCE`, `NO_PROFITABLE_ROUTE`, `ACCOUNT_FROZEN`, …). Codes live in `packages/contracts`.
- Server messages are English and for logs. The front ends show the translation of `code`, never raw server text.

### Lists
- `page` (from 1), `pageSize` (default 50, max 100), `sort`/`order` where offered, named filters, all validated by a contract schema; responses `{ items, total, page, pageSize }`.

### Front ends
- Arabic text through the i18n catalog only; logical CSS only; components and tokens from `packages/ui`.
- Store: server components by default; `'use client'` only for interaction; data from the API client in `lib/`; cached reads tagged by entity; every page handles loading (streaming skeletons), empty and error states.
- Admin: server state in TanStack Query (`features/<module>/<module>.queries.ts`), API calls through the client generated from OpenAPI.
- Money is formatted by one shared function (USD with the SYP equivalent); Latin digits (`ar-u-nu-latn`), tabular figures.

### Tests
- Unit tests next to the code (`*.test.ts`). API integration tests call the real app over HTTP against the test database: every endpoint covers success, 401, 403 (wrong role or customer on a staff route) and other customers' records.
- Money and fulfilment paths also test concurrency (two parallel debits, a webhook racing a poll, a double-submitted `Idempotency-Key`) and every state transition, allowed and refused.
- Supplier adapters are tested against recorded, sanitized fixtures and a local fake server; nothing calls a live service in tests.
- Test data is unique per run and removed in `afterAll`; tests never depend on order.
- UI changes add or update a Playwright RTL screenshot (store: dark and light, phone width first; admin: light and dark).

### Enforcement
| Rule | Enforced by |
|---|---|
| Every route declares its access; staff routes only under `/api/admin/` | `apps/api/test/architecture.test.ts` |
| Modules meet only through `index.ts` and query only their own tables | `apps/api/test/architecture.test.ts` |
| UUID ids, business columns, timestamptz, no floats, indexed foreign keys, unique external references | `packages/db/src/conventions.test.ts` |
| Ledger and audit tables reject `UPDATE`/`DELETE`; journals balance | `packages/db` tests (trigger and grants) |
| Logical CSS only, colors from tokens | `packages/ui/src/conventions.test.ts` |
| Migrations match the schema | CI (`pnpm db:generate` leaves no diff) |
| No secrets committed | gitleaks in CI |
| Formatting, imports, lint rules | Biome (CI, and the Claude Code hook on every edit) |
| Anything else in this record | Review against this record (`reviewer`) |

## Consequences
- New modules look the same, so an agent learns the pattern from one module and applies it everywhere.
- Moving a rule from "review" to a test is always welcome; changing a rule means a new record and an update to the tests.
- Shared helpers (lists, errors, money columns) are written with their first real use, not ahead of it.
