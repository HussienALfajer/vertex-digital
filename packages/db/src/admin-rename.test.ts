import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { createDatabase } from './client.js';
import { newId } from './id.js';
import { migrationsFolder } from './migrate.js';

/*
 * The staff → admin rename (S01, ADR 0016) renames the Phase 0 tables in place, so the admin row
 * created in production during Phase 0 survives with its password and TOTP. Proven by replaying
 * the staff part of migration 0002 in a scratch schema, inserting a staff row, then applying the
 * rename migration there, all in a transaction that is rolled back.
 */

const owner = createDatabase(process.env.DATABASE_OWNER_URL as string);

afterAll(() => owner.close());

const migration = (prefix: string) => {
  const file = readdirSync(migrationsFolder).find((name) => name.startsWith(prefix));
  if (!file) throw new Error(`No migration ${prefix}`);
  return readFileSync(join(migrationsFolder, file), 'utf8')
    .split('--> statement-breakpoint')
    .map((statement) => statement.trim())
    .filter(Boolean);
};

describe('the staff → admin rename migration', () => {
  const rename = migration('0003_');

  it('renames the tables instead of dropping and creating them', () => {
    const tables = ['users', 'sessions', 'accounts', 'verifications', 'two_factors'];
    for (const table of tables) {
      expect(rename).toContain(`ALTER TABLE "staff_${table}" RENAME TO "admin_${table}";`);
    }
    expect(rename.filter((statement) => /DROP TABLE|CREATE TABLE/i.test(statement))).toEqual([]);
  });

  it('keeps a Phase 0 staff row, with its password and TOTP, as the admin', async () => {
    const schema = `rename_test_${newId().replaceAll('-', '')}`;
    const staffStatements = migration('0002_').filter((statement) => /staff_/.test(statement));
    const client = await owner.pool.connect();
    try {
      await client.query('begin');
      await client.query(`create schema ${schema}`);
      await client.query(`set local search_path = ${schema}, public`);
      // Foreign keys name their target with "public": point them at the scratch schema instead.
      const local = (statement: string) =>
        statement.replace(/"public"."(staff|admin)_/g, `"${schema}"."$1_`);
      for (const statement of staffStatements) await client.query(local(statement));

      const id = newId();
      await client.query(
        `insert into staff_users (id, name, email, two_factor_enabled, role)
         values ($1, 'Owner', 'owner@example.com', true, 'owner')`,
        [id],
      );
      await client.query(
        `insert into staff_accounts (id, user_id, account_id, provider_id, password)
         values ($1, $2, $3, 'credential', 'hash')`,
        [newId(), id, id],
      );
      await client.query(
        `insert into staff_two_factors (id, user_id, secret, backup_codes)
         values ($1, $2, 'secret', 'codes')`,
        [newId(), id],
      );

      for (const statement of rename) await client.query(local(statement));

      const { rows } = await client.query(
        `select u.email, u.two_factor_enabled, a.password, t.secret
         from ${schema}.admin_users u
         join ${schema}.admin_accounts a on a.user_id = u.id
         join ${schema}.admin_two_factors t on t.user_id = u.id
         where u.id = $1`,
        [id],
      );
      expect(rows).toEqual([
        {
          email: 'owner@example.com',
          two_factor_enabled: true,
          password: 'hash',
          secret: 'secret',
        },
      ]);
    } finally {
      await client.query('rollback');
      client.release();
    }
  });
});
