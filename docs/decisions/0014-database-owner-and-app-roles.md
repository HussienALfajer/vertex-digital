# 0014 — Database roles: an owner for migrations, a restricted role for the apps

Status: Accepted · Date: 2026-10-07 · Amends 0009

## Context
ADR 0003 requires that the role the apps use cannot update or delete ledger rows, and ADR 0009 gave the site one database role, which both runs the migrations and serves the apps. The first ledger tests showed that a single role cannot meet ADR 0003:
- PostgreSQL checks a foreign key with `SELECT … FOR KEY SHARE` as the owner of the referenced table, and that lock needs `UPDATE`. Revoking `UPDATE` on `ledger_journals` from its owner makes every posting fail.
- A table owner can always grant its privileges back to itself and can disable a trigger (`ALTER TABLE … DISABLE TRIGGER`). If the apps run as the owner, the append-only guard is a guard against mistakes only, not against a compromised process.

## Decision
- **Two roles per database**, on every machine (local, CI, cloud sessions, production):
  - `vertex_digital_owner` owns the schema and every table, and runs the migrations (`pnpm db:migrate`, `packages/db/dist/cli/migrate.js` in deploys). No app process connects with it.
  - `vertex_digital` is the role of the API and the worker. It owns nothing, cannot run DDL, change triggers or grant privileges, and is never a superuser.
- **Privileges:** the database setup (`scripts/setup-local-db.mjs` locally, in CI and in cloud sessions; the provisioning script in production) creates both roles and the databases owned by the owner role, grants the app role `CONNECT` and `USAGE` on `public`, and sets default privileges so every table the owner creates grants the app role `SELECT, INSERT, UPDATE, DELETE` (sequences: `USAGE, SELECT`). `CONNECT` and `TEMPORARY` are revoked from `PUBLIC`: the app role cannot create a temporary table that would shadow a table a trigger reads. Default privileges are set **before** the first migration.
- **Append-only tables** (ledger now; audit and order events later): their custom migration revokes `UPDATE, DELETE, TRUNCATE` from `PUBLIC` and from every role except the owner, whatever the app role is called, and adds the `append_only_guard` trigger, which also refuses the owner. Ledger accounts lose `DELETE` and `TRUNCATE` (archived, never deleted).
- **Trigger functions that read tables** name them with their schema (`public.ledger_postings`) and pin `SET search_path = public, pg_temp`.
- **Environment:** `DATABASE_URL` and `TEST_DATABASE_URL` are the app role; `DATABASE_OWNER_URL` and `TEST_DATABASE_OWNER_URL` are the owner role, used only by migrations and by the tests that prove the triggers refuse even the owner.
- Everything else in ADR 0009 is unchanged.

## Consequences
- ADR 0003's guarantee holds against the apps themselves: a bug or an attacker inside the API or the worker cannot alter the ledger, its triggers or its privileges.
- Libraries that create their own tables at runtime (pg-boss, PR 3) cannot do so as the app role: their schema is created by the owner (a migration or a setup step) before the app starts.
- One more secret per environment (the owner password). In production it lives in the server's `shared/.env` for the deploy script only; the PM2 processes do not read it.
