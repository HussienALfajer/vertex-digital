# packages/db

Drizzle schema, migrations, the database client and the shared money write paths (ADR 0002, 0003, 0011, 0014). Schema changes follow the `db-migration` skill.

## Layout
- `src/schema/<module>.ts`: tables of one owning API module (`wallet.ts`: the ledger; `auth.ts`: customer Better Auth tables; `staff.ts`: staff Better Auth tables and roles; `system.ts`: worker heartbeats), re-exported from `src/schema/index.ts`. Better Auth tables keep the property names Better Auth expects.
- `src/schema/columns.ts`: `id()`, `timestamps()`, `archivedAt()`, `amountUnits()`, `currencyEnum`. Enums reuse the `as const` lists of `@vertex-digital/contracts`.
- `src/ledger/`: `postJournal` (the only way to write journals and postings) and `accountBalance`. `src/orders/` (F11) will hold the order transition write path.
- `migrations/`: `0000_ledger.sql` and `0002_harsh_boom_boom.sql` (auth and staff tables, heartbeats) are generated; `0001_ledger_guards.sql` is hand-written (triggers, privileges). `migrations/meta/` is drizzle-kit state: never read or edit it.
- `src/migrate.ts` (`runMigrations`) and `src/cli/migrate.ts`: the Drizzle migrations, then pg-boss's tables (`installPgBoss`), as the owner role under an advisory lock. `pnpm db:migrate`, deploys (`node packages/db/dist/cli/migrate.js`) and the tests' global setup all run it.
- `src/jobs.ts`: `PG_BOSS_SCHEMA` and `createPgBoss` (app role: no schema changes, no index rebuilds). The `pgboss` schema itself is created, owned by the owner role with default privileges for the app role, by `scripts/setup-local-db.mjs` and the production provisioning.
- `src/testing.ts` (`@vertex-digital/db/testing`): test database URLs and the Vitest global setup the apps reuse.

## Roles (ADR 0014)
- The owner role (`DATABASE_OWNER_URL`) owns every table and runs the migrations (`pnpm db:migrate`, the migrate CLI, the tests' global setup). No app process uses it.
- The app role (`DATABASE_URL`) is what the API, the worker and the tests use. It owns nothing; default privileges give it `SELECT, INSERT, UPDATE, DELETE` on each new table, and append-only tables take the changes back.

## Rules the tests enforce
- `src/conventions.test.ts`: a business table is `{ id: id(), ...fields, ...timestamps(), archivedAt: archivedAt() }`; UUIDv7 `id` keys; every foreign key indexed; `timestamptz` only; no floating-point column; `*_units` columns are `bigint`; `idempotency_key` columns unique. An exception goes in `NOT_BUSINESS_RECORDS` or `NATURAL_KEYS`, with a reason; an append-only table also goes in `APPEND_ONLY_TABLES`.
- `src/ledger/guards.test.ts`: the app role is no superuser, owns no table and has no `UPDATE`, `DELETE` or `TRUNCATE` on journals and postings (no `DELETE`/`TRUNCATE` on accounts); it cannot disable the trigger or grant itself the privileges; the `append_only_guard` trigger refuses the owner role too; the app role cannot create temporary tables; journals have exactly their declared postings (none added later, a temporary table cannot fool the check) and balance per currency at commit; the database stamps `created_at`; a posting's currency is its account's; an account's id, code, kind and currency never change.
- `src/ledger/post-journal.test.ts`: balances, idempotency, refusals, and concurrency (parallel debits never overdraw, a key posted in parallel posts once, no deadlock).
- `src/jobs.test.ts`: pg-boss is installed in a schema the app role does not own and cannot create tables in; the app role creates queues, sends and works jobs.

## The ledger (ADR 0003)
- Write money only with `postJournal(tx, { idempotencyKey, kind, postings })`, inside the transaction that also writes the business change, its audit entry and its job. It is atomic on its own (a savepoint): a refusal leaves the caller's transaction usable.
- A journal declares its `posting_count`; the commit check refuses any other number of postings, so nothing can be added to a journal later. The database stamps `created_at`.
- A posting adds `amountUnits` to its account (negative takes from it); a balance is `accountBalance`, the sum. Customer wallets are USD, whole cents, never below zero; system accounts may go negative and keep sub-cent precision.
- `LedgerError` carries a contract code (`INSUFFICIENT_BALANCE`, `IDEMPOTENCY_KEY_REUSED`) for the API to return; any other `Error` is a bug.
- Transactions stay READ COMMITTED (PostgreSQL's default): `postJournal` refuses to debit a wallet under another isolation level.
- Corrections are new reversing journals. Never update or delete a ledger row, and never grant the app role privileges on it.
- A new append-only table (audit, order events) gets, in its custom migration, the `append_only_guard` trigger and the revokes of `0001_ledger_guards.sql` (from `PUBLIC` and every non-owner grantee, so the app role's name never appears in a migration); it joins `APPEND_ONLY_TABLES` and the trigger list in `guards.test.ts`.

## Rules to apply yourself
- A trigger function that reads a table names it with its schema (`public.<table>`) and has `SET search_path = public, pg_temp`, so no temporary table can stand in for it.
- Money columns: `amountUnits('<name>_units')` next to `currencyEnum('currency')`, or a currency-fixed name (`price_usd_units`). Exchange rates: `numeric`. Amounts are JS numbers checked as safe integers; math on them lives in `@vertex-digital/contracts`.
- Idempotency keys and external references (supplier attempt ids, Sham Cash transaction numbers, `(network, txid)`) get unique constraints.
- Migrations must stay backward compatible (expand, then contract); never edit one once generated; hand-written SQL goes in `drizzle-kit generate --custom`; never `drizzle-kit push`.

## Tests
Vitest's global setup migrates the test database as the owner (`TEST_DATABASE_OWNER_URL`); the tests run as the app role (`TEST_DATABASE_URL`), and as the owner only to prove a guard refuses it. Both roles come from `pnpm db:setup-local`; neither may be a superuser, or the privilege tests prove nothing. Ledger rows written by tests stay in the test database (append-only by design); every test uses new accounts and keys, so runs never collide.

Run: `pnpm --filter @vertex-digital/db test`. CI fails if `pnpm db:generate` produces a diff: commit the schema and its migration together.
