import type { INestApplicationContext } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import {
  auditEntries,
  customerSignIns,
  customers,
  type Database,
  newId,
  supportTickets,
} from '@vertex-digital/db';
import { and, eq, inArray, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DATABASE } from '../src/core/database/database.module.js';
import { SupportAutoCloseJob } from '../src/jobs/support/auto-close.job.js';
import { PurgeSignInsJob } from '../src/jobs/support/purge-sign-ins.job.js';
import { WorkerModule } from '../src/worker.module.js';

/*
 * `support.auto-close` (S12 TK6) and `customers.purge-sign-ins` (S12 data) against the test
 * database. Tickets are never deleted, so the rows written here stay; each test uses new customers.
 */

let app: INestApplicationContext;
let db: Database;

beforeAll(async () => {
  const moduleRef = await Test.createTestingModule({ imports: [WorkerModule] }).compile();
  app = await moduleRef.init();
  db = app.get<Database>(DATABASE);
});

afterAll(() => app.close());

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

const ALPHABET = '23456789ABCDEFGHJKMNPQRSTUVWXYZ';

/** A ticket whose last admin message is `daysAgo` days old. */
async function ticket(
  customerId: string,
  status: 'open' | 'answered',
  daysAgo: number,
): Promise<string> {
  const id = newId();
  const number = Array.from(
    { length: 6 },
    () => ALPHABET[Math.floor(Math.random() * ALPHABET.length)],
  ).join('');
  await db.insert(supportTickets).values({
    id,
    number: `VT-${number}`,
    customerId,
    category: 'account',
    subject: 'سؤال عن حسابي',
    status,
    openedBy: 'customer',
    lastCustomerMessageAt: sql`now() - make_interval(days => ${daysAgo + 1})`,
    lastAdminMessageAt: sql`now() - make_interval(days => ${daysAgo})`,
  });
  return id;
}

describe('support.auto-close (TK6)', () => {
  it('closes answered tickets past 7 days by the system, once', async () => {
    const owner = await customer();
    const [due, recent, waiting] = [
      await ticket(owner, 'answered', 8),
      await ticket(owner, 'answered', 6),
      await ticket(owner, 'open', 8),
    ];
    const job = app.get(SupportAutoCloseJob);
    expect(await job.close(new Date())).toBeGreaterThanOrEqual(1);
    const rows = await db
      .select({ id: supportTickets.id, status: supportTickets.status, by: supportTickets.closedBy })
      .from(supportTickets)
      .where(inArray(supportTickets.id, [due, recent, waiting]));
    const byId = new Map(rows.map((row) => [row.id, row]));
    expect(byId.get(due)).toMatchObject({ status: 'closed', by: 'system' });
    expect(byId.get(recent)?.status).toBe('answered');
    expect(byId.get(waiting)?.status).toBe('open');
    const audit = await db
      .select({ details: auditEntries.details })
      .from(auditEntries)
      .where(and(eq(auditEntries.entityId, due), eq(auditEntries.action, 'ticket.closed')));
    expect(audit).toEqual([
      { details: expect.objectContaining({ cause: 'auto_close', before: 'answered' }) },
    ]);
    // A second run changes nothing of this ticket.
    await job.close(new Date());
    expect(await db.select().from(auditEntries).where(eq(auditEntries.entityId, due))).toHaveLength(
      1,
    );
  });
});

describe('customers.purge-sign-ins', () => {
  it('deletes sign-ins older than 90 days only', async () => {
    const owner = await customer();
    const [old, kept] = [newId(), newId()];
    await db.insert(customerSignIns).values([
      { id: old, customerId: owner, createdAt: sql`now() - interval '91 days'` },
      { id: kept, customerId: owner, createdAt: sql`now() - interval '89 days'` },
    ]);
    expect(await app.get(PurgeSignInsJob).purge()).toBeGreaterThanOrEqual(1);
    const left = await db
      .select({ id: customerSignIns.id })
      .from(customerSignIns)
      .where(eq(customerSignIns.customerId, owner));
    expect(left).toEqual([{ id: kept }]);
  });
});
