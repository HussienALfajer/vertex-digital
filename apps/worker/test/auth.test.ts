import type { INestApplicationContext } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { QUEUES } from '@vertex-digital/contracts';
import {
  adminSessions,
  adminUsers,
  adminVerifications,
  customerSessions,
  customers,
  customerVerifications,
  type Database,
  newId,
} from '@vertex-digital/db';
import { eq, inArray, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DATABASE } from '../src/core/database/database.module.js';
import { PgBossService } from '../src/core/jobs/pg-boss.service.js';
import { PURGE_EXPIRED_CRON, PurgeExpiredJob } from '../src/jobs/auth/purge-expired.job.js';
import { WorkerModule } from '../src/worker.module.js';

/*
 * `auth.purge-expired` (audit A01-1) against the test database: ended sessions and expired
 * verification rows of both auth instances go, live ones stay.
 */

let app: INestApplicationContext;
let db: Database;
/** The admin this file made, removed at the end; null when the database already had one. */
let createdAdmin: string | null = null;

beforeAll(async () => {
  const moduleRef = await Test.createTestingModule({ imports: [WorkerModule] }).compile();
  app = await moduleRef.init();
  db = app.get<Database>(DATABASE);
});

afterAll(async () => {
  if (createdAdmin) await db.delete(adminUsers).where(eq(adminUsers.id, createdAdmin));
  await app.close();
});

async function customer(): Promise<string> {
  const id = newId();
  await db.insert(customers).values({
    id,
    name: 'Test',
    email: `${id}@test.vertex-digital.local`,
    phone: '+963900000000',
  });
  return id;
}

/** The one admin row (ADR 0016): the existing one, or one made for this file. */
async function admin(): Promise<string> {
  const [existing] = await db.select({ id: adminUsers.id }).from(adminUsers);
  if (existing) return existing.id;
  const id = newId();
  await db
    .insert(adminUsers)
    .values({ id, name: 'Admin', email: `${id}@test.vertex-digital.local` });
  createdAdmin = id;
  return id;
}

const ago = (minutes: number) => sql`now() - make_interval(mins => ${minutes})`;
const ahead = (minutes: number) => sql`now() + make_interval(mins => ${minutes})`;

describe('auth.purge-expired (A01-1)', () => {
  it('is scheduled hourly', async () => {
    expect(await app.get(PgBossService).boss.getSchedules(QUEUES.authPurgeExpired)).toEqual([
      expect.objectContaining({ cron: PURGE_EXPIRED_CRON }),
    ]);
  });

  it('deletes ended sessions and expired values of both instances, and keeps live ones', async () => {
    const owner = await customer();
    const adminId = await admin();
    const [endedCustomer, liveCustomer] = [newId(), newId()];
    await db.insert(customerSessions).values([
      { id: endedCustomer, userId: owner, token: newId(), expiresAt: ago(1) },
      { id: liveCustomer, userId: owner, token: newId(), expiresAt: ahead(60) },
    ]);
    const [expiredCode, liveCode] = [newId(), newId()];
    await db.insert(customerVerifications).values([
      {
        id: expiredCode,
        identifier: `passkey-challenge:${expiredCode}`,
        value: '{}',
        expiresAt: ago(1),
      },
      {
        id: liveCode,
        identifier: `passkey-challenge:${liveCode}`,
        value: '{}',
        expiresAt: ahead(5),
      },
    ]);
    const [endedAdmin, idleAdmin, liveAdmin] = [newId(), newId(), newId()];
    await db.insert(adminSessions).values([
      { id: endedAdmin, userId: adminId, token: newId(), expiresAt: ago(1) },
      // Rule D4: idle for more than 30 minutes, though not past its 12 hours.
      {
        id: idleAdmin,
        userId: adminId,
        token: newId(),
        expiresAt: ahead(60),
        lastActiveAt: ago(31),
      },
      {
        id: liveAdmin,
        userId: adminId,
        token: newId(),
        expiresAt: ahead(60),
        lastActiveAt: ago(5),
      },
    ]);
    const [expiredStep, liveStep] = [newId(), newId()];
    await db.insert(adminVerifications).values([
      { id: expiredStep, identifier: `2fa-${expiredStep}`, value: adminId, expiresAt: ago(1) },
      { id: liveStep, identifier: `2fa-${liveStep}`, value: adminId, expiresAt: ahead(5) },
    ]);

    expect(await app.get(PurgeExpiredJob).purge()).toBeGreaterThanOrEqual(5);

    const ids = async (table: 'customer' | 'admin') =>
      (table === 'customer'
        ? await db
            .select({ id: customerSessions.id })
            .from(customerSessions)
            .where(inArray(customerSessions.id, [endedCustomer, liveCustomer]))
        : await db
            .select({ id: adminSessions.id })
            .from(adminSessions)
            .where(inArray(adminSessions.id, [endedAdmin, idleAdmin, liveAdmin]))
      ).map((row) => row.id);
    expect(await ids('customer')).toEqual([liveCustomer]);
    expect(await ids('admin')).toEqual([liveAdmin]);
    const codes = await db
      .select({ id: customerVerifications.id })
      .from(customerVerifications)
      .where(inArray(customerVerifications.id, [expiredCode, liveCode]));
    expect(codes).toEqual([{ id: liveCode }]);
    const steps = await db
      .select({ id: adminVerifications.id })
      .from(adminVerifications)
      .where(inArray(adminVerifications.id, [expiredStep, liveStep]));
    expect(steps).toEqual([{ id: liveStep }]);

    // A second run finds nothing more of these.
    await app.get(PurgeExpiredJob).purge();
    expect(await ids('customer')).toEqual([liveCustomer]);
    await db.delete(customerSessions).where(eq(customerSessions.id, liveCustomer));
    await db.delete(adminSessions).where(eq(adminSessions.id, liveAdmin));
    await db.delete(customerVerifications).where(eq(customerVerifications.id, liveCode));
    await db.delete(adminVerifications).where(eq(adminVerifications.id, liveStep));
  });
});
