---
name: db-migration
description: Change the database schema safely in packages/db — edit the Drizzle schema, generate the migration, review its SQL for backward compatibility and money safety, and test it. Use whenever a table, column, index, enum, constraint, trigger or grant is added, changed or removed.
argument-hint: <what changes>
effort: high
---

Schema change: **$ARGUMENTS**. Rules: `packages/db/CLAUDE.md` and ADR 0011 (Data); money tables also ADR 0003.

1. **Edit** `packages/db/src/schema/<module>.ts` with the helpers from `columns.ts`. A new schema file is exported from `schema/index.ts` and gets an owner in `TABLE_OWNERS` (`apps/api/test/architecture.test.ts`). Every new foreign key gets an index. Idempotency keys and external references (supplier ids, transaction numbers, TXIDs, event ids) get unique indexes.
2. **Append-only tables** (ledger, order events, supplier events, audit): no `updated_at` or `archived_at`; the custom migration that creates them also adds the trigger that refuses `UPDATE`/`DELETE` and revokes those privileges from the app role. Journals must balance: keep the balance check in the same migration as any change to postings.
3. **Generate:** `pnpm db:generate`. Read the new `.sql` file in `packages/db/migrations/` (never the `meta/` folder).
4. **Review the SQL.** The previous release must keep working against the migrated database (deploys and rollbacks). Stop and redesign as expand, then contract, if you see:
   - `DROP TABLE`, `DROP COLUMN`, or a `RENAME` of anything code still uses;
   - `ALTER COLUMN ... TYPE` that rewrites or narrows data (never on money columns without an owner decision);
   - `SET NOT NULL`, or a new `NOT NULL` column without a default, on a table that has rows;
   - a removed or renamed enum value (order and deposit states especially);
   - anything that changes or deletes ledger, audit or event rows.
   Contract steps ship in a later release, once no deployed code uses the old shape. Data backfills go in a custom migration (`pnpm --filter @vertex-digital/db exec drizzle-kit generate --custom`); a backfill never touches ledger rows: money corrections are new journals.
5. **Test:** `pnpm --filter @vertex-digital/db test` (runs the migrations, `src/conventions.test.ts` and the ledger tests), then the tests of every package that uses the tables. Use the `checker` subagent for these runs.
6. **Confirm no drift:** running `pnpm db:generate` again reports nothing to migrate.
7. **Dev database:** `pnpm db:migrate` changes the owner's local data, so ask before running it.

Never use `drizzle-kit push`, never edit a generated migration, and commit the schema and its migration together.
