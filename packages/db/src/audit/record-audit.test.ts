import { eq } from 'drizzle-orm';
import { afterAll, describe, expect, it } from 'vitest';
import { createDatabase } from '../client.js';
import { newId } from '../id.js';
import { auditEntries } from '../schema/index.js';
import { recordAudit } from './record-audit.js';

/*
 * The audit write path and its guards (S01 rules A1, A3): an entry commits or rolls back with the
 * change it records, and nobody changes or removes it afterwards, the owner role included. Entries
 * written here stay in the test database: it is append-only by design.
 */

const connection = createDatabase(process.env.DATABASE_URL as string);
const owner = createDatabase(process.env.DATABASE_OWNER_URL as string);

afterAll(() => Promise.all([connection.close(), owner.close()]));

const entry = (entityId: string) =>
  ({
    action: 'customer.profile_updated',
    actorKind: 'customer',
    actorId: entityId,
    channel: 'store',
    entityType: 'customer',
    entityId,
    details: { before: { name: 'Old' }, after: { name: 'New' } },
    ipAddress: '10.0.0.1',
    userAgent: 'test',
  }) as const;

const entriesOf = (entityId: string) =>
  connection.db.select().from(auditEntries).where(eq(auditEntries.entityId, entityId));

describe('recordAudit', () => {
  it('writes the entry in the caller’s transaction', async () => {
    const entityId = newId();
    const id = await connection.db.transaction((tx) => recordAudit(tx, entry(entityId)));
    expect(await entriesOf(entityId)).toMatchObject([
      {
        id,
        action: 'customer.profile_updated',
        actorKind: 'customer',
        channel: 'store',
        details: { before: { name: 'Old' }, after: { name: 'New' } },
        reason: null,
      },
    ]);
  });

  it('rolls back with a change that fails', async () => {
    const entityId = newId();
    await expect(
      connection.db.transaction(async (tx) => {
        await recordAudit(tx, entry(entityId));
        throw new Error('the change failed');
      }),
    ).rejects.toThrow('the change failed');
    expect(await entriesOf(entityId)).toEqual([]);
  });

  it('refuses details that are not the action’s shape, before writing anything', async () => {
    const entityId = newId();
    await expect(
      connection.db.transaction((tx) =>
        recordAudit(tx, {
          ...entry(entityId),
          // @ts-expect-error a secret is not part of any action's details
          details: { before: {}, after: {}, password: 'x' },
        }),
      ),
    ).rejects.toThrow();
    expect(await entriesOf(entityId)).toEqual([]);
  });
});

describe('audit guards', () => {
  it('leave the app role reading and adding entries only', async () => {
    const { rows } = await connection.pool.query<{ privileges: Record<string, boolean> }>(
      `select json_object_agg(p, has_table_privilege(current_user, 'audit_entries', p)) as privileges
       from unnest(array['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE']) as p`,
    );
    expect(rows[0]?.privileges).toEqual({
      SELECT: true,
      INSERT: true,
      UPDATE: false,
      DELETE: false,
      TRUNCATE: false,
    });
  });

  it('refuse UPDATE, DELETE and TRUNCATE, even from the owner role', async () => {
    const entityId = newId();
    await connection.db.transaction((tx) => recordAudit(tx, entry(entityId)));
    for (const statement of [
      `update audit_entries set reason = 'x' where entity_id = '${entityId}'`,
      `delete from audit_entries where entity_id = '${entityId}'`,
    ]) {
      await expect(connection.pool.query(statement)).rejects.toThrow(/permission denied/);
      await expect(owner.pool.query(statement)).rejects.toThrow(/append-only/);
    }
    await expect(owner.pool.query('truncate audit_entries')).rejects.toThrow(/append-only/);
    expect(await entriesOf(entityId)).toHaveLength(1);
  });
});

describe('the admin account table', () => {
  it('holds at most one admin, whatever inserts it (ADR 0016)', async () => {
    const client = await owner.pool.connect();
    try {
      await client.query('begin');
      await client.query('delete from admin_users');
      const insert = (email: string) =>
        client.query(`insert into admin_users (id, name, email) values ($1, 'Admin', $2)`, [
          newId(),
          email,
        ]);
      await insert('one@example.com');
      await expect(insert('two@example.com')).rejects.toThrow(/admin_users_single_idx/);
    } finally {
      await client.query('rollback');
      client.release();
    }
  });
});
