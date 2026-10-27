import { eq } from 'drizzle-orm';
import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDatabase } from '../client.js';
import { newId } from '../id.js';
import {
  customerNotifications,
  customerSessions,
  customers,
  emailOutbox,
  notificationPreferences,
  pushSubscriptions,
} from '../schema/index.js';
import { type JobSender, notifyCustomer } from './index.js';
import { CUSTOMER_NOTIFICATIONS_CHANNEL } from './notify-customer.js';

/*
 * The notification write path (S05 rules NT1, NT8) and the guard of `customer_notifications`.
 * Rows written here stay in the test database; every test uses a new customer.
 */

const connection = createDatabase(process.env.DATABASE_URL as string);
const owner = createDatabase(process.env.DATABASE_OWNER_URL as string);
const { db } = connection;

let listener: pg.PoolClient;
const heard: string[] = [];

beforeAll(async () => {
  listener = await connection.pool.connect();
  listener.on('notification', (message) => {
    if (message.channel === CUSTOMER_NOTIFICATIONS_CHANNEL)
      heard.push(message.payload?.split(':')[1] ?? '');
  });
  await listener.query(`listen ${CUSTOMER_NOTIFICATIONS_CHANNEL}`);
});

afterAll(async () => {
  listener.release();
  await Promise.all([connection.close(), owner.close()]);
});

/** Records the jobs instead of sending them. */
function recordingJobs(): JobSender & { sent: { queue: string; data: object }[] } {
  const sent: { queue: string; data: object }[] = [];
  return { sent, send: async (_tx, queue, data) => sent.push({ queue, data }) };
}

async function customer(): Promise<{ id: string; email: string }> {
  const id = newId();
  const email = `${id}@test.vertex-digital.local`;
  await db.insert(customers).values({ id, name: 'Test', email, phone: '+963900000000' });
  return { id, email };
}

const credited = (depositId = newId()) => ({
  depositId,
  referenceCode: 'VD-ABC23',
  creditedUsdUnits: 20_000_000,
});

/** Waits for notifications PostgreSQL may still be delivering. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 100));

describe('notifyCustomer', () => {
  it('writes the row, queues the email and announces it at commit (rule NT1)', async () => {
    const { id: customerId, email } = await customer();
    const jobs = recordingJobs();
    const params = credited();
    let written = { notificationId: '', emailId: null as string | null };
    await db.transaction(async (tx) => {
      written = await notifyCustomer(tx, jobs, { customerId, event: 'deposit_credited', params });
      await settle();
      expect(heard).not.toContain(written.notificationId);
    });
    await settle();
    expect(heard).toContain(written.notificationId);

    const [row] = await db
      .select()
      .from(customerNotifications)
      .where(eq(customerNotifications.id, written.notificationId));
    expect(row).toMatchObject({ customerId, event: 'deposit_credited', params, readAt: null });
    const [outbox] = await db
      .select()
      .from(emailOutbox)
      .where(eq(emailOutbox.id, written.emailId as string));
    expect(outbox).toMatchObject({
      toAddress: email,
      template: 'customer_deposit_credited',
      customerId,
      params: { ...params, at: row?.createdAt.toISOString() },
    });
    expect(jobs.sent).toEqual([{ queue: 'email.send', data: { outboxId: written.emailId } }]);
  });

  it('leaves no row, email or event when the change rolls back', async () => {
    const { id: customerId } = await customer();
    let notificationId = '';
    await expect(
      db.transaction(async (tx) => {
        ({ notificationId } = await notifyCustomer(tx, recordingJobs(), {
          customerId,
          event: 'deposit_receipt_requested',
          params: { depositId: newId(), referenceCode: 'VD-ABC23' },
        }));
        throw new Error('rolled back');
      }),
    ).rejects.toThrow('rolled back');
    await settle();
    expect(heard).not.toContain(notificationId);
    expect(
      await db
        .select()
        .from(customerNotifications)
        .where(eq(customerNotifications.customerId, customerId)),
    ).toEqual([]);
    expect(
      await db.select().from(emailOutbox).where(eq(emailOutbox.customerId, customerId)),
    ).toEqual([]);
  });

  it('records the event but skips the email the customer turned off (rule NT8)', async () => {
    const { id: customerId } = await customer();
    await db
      .insert(notificationPreferences)
      .values({ customerId, event: 'deposit_rejected', email: false });
    const jobs = recordingJobs();
    const rejected = await db.transaction((tx) =>
      notifyCustomer(tx, jobs, {
        customerId,
        event: 'deposit_rejected',
        params: { depositId: newId(), referenceCode: 'VD-ABC23', reason: 'not_received' },
      }),
    );
    expect(rejected.emailId).toBeNull();
    // Another event keeps its default: on.
    const adjusted = await db.transaction((tx) =>
      notifyCustomer(tx, jobs, {
        customerId,
        event: 'wallet_adjusted',
        params: {
          direction: 'credit',
          amountUnits: 1_000_000,
          category: 'compensation',
          reversal: false,
        },
      }),
    );
    expect(adjusted.emailId).not.toBeNull();
    expect(jobs.sent).toHaveLength(1);
    expect(
      await db
        .select()
        .from(customerNotifications)
        .where(eq(customerNotifications.customerId, customerId)),
    ).toHaveLength(2);
  });

  it('refuses params that carry more than the event allows (rule NT3)', async () => {
    const { id: customerId } = await customer();
    await expect(
      db.transaction((tx) =>
        notifyCustomer(tx, recordingJobs(), {
          customerId,
          event: 'deposit_credited',
          params: { ...credited(), creditedUsdUnits: -1 },
        }),
      ),
    ).rejects.toThrow();
  });
});

describe('push (S15)', () => {
  async function device(customerId: string): Promise<{ sessionId: string; deviceId: string }> {
    const sessionId = newId();
    await db.insert(customerSessions).values({
      id: sessionId,
      userId: customerId,
      token: `test-${sessionId}`,
      expiresAt: new Date(Date.now() + 3_600_000),
    });
    const deviceId = newId();
    await db.insert(pushSubscriptions).values({
      id: deviceId,
      customerId,
      sessionId,
      endpoint: `https://fcm.googleapis.com/fcm/send/${deviceId}`,
      p256dh: 'p256dh',
      auth: 'auth',
      vapidKeyId: 'key',
    });
    return { sessionId, deviceId };
  }

  const delivered = () => ({
    orderId: newId(),
    orderNumber: 'VD-1000001',
    productNameAr: 'شدات',
    quantity: 1,
  });

  it('queues one push.send only when the customer has a device (rule PD1)', async () => {
    const { id: customerId } = await customer();
    const before = recordingJobs();
    await db.transaction((tx) =>
      notifyCustomer(tx, before, { customerId, event: 'deposit_credited', params: credited() }),
    );
    expect(before.sent.map((job) => job.queue)).toEqual(['email.send']);

    await device(customerId);
    // The email turned off decides nothing about push, and the reverse.
    await db
      .insert(notificationPreferences)
      .values({ customerId, event: 'deposit_credited', email: false });
    const after = recordingJobs();
    const { notificationId } = await db.transaction((tx) =>
      notifyCustomer(tx, after, { customerId, event: 'deposit_credited', params: credited() }),
    );
    expect(after.sent).toEqual([{ queue: 'push.send', data: { notificationId } }]);
  });

  it('queues no push for center-only events and calls (rule PD1, S10 CT8)', async () => {
    const { id: customerId } = await customer();
    await device(customerId);
    const jobs = recordingJobs();
    await db.transaction(async (tx) => {
      await notifyCustomer(
        tx,
        jobs,
        {
          customerId,
          event: 'order_delivered',
          params: delivered(),
        },
        { email: false },
      );
      await notifyCustomer(tx, jobs, {
        customerId,
        event: 'order_delayed',
        params: { orderId: newId(), orderNumber: 'VD-1000002', productNameAr: 'شدات' },
      });
    });
    expect(jobs.sent).toEqual([]);
  });

  it('removes a device with its session (rule PS4)', async () => {
    const { id: customerId } = await customer();
    const { sessionId, deviceId } = await device(customerId);
    await db.delete(customerSessions).where(eq(customerSessions.id, sessionId));
    expect(
      await db.select().from(pushSubscriptions).where(eq(pushSubscriptions.id, deviceId)),
    ).toEqual([]);
  });

  it('keeps one row per endpoint and checks its bounds', async () => {
    const { id: customerId } = await customer();
    const { deviceId } = await device(customerId);
    const [row] = await db
      .select()
      .from(pushSubscriptions)
      .where(eq(pushSubscriptions.id, deviceId));
    const { sessionId } = await device(customerId);
    await expect(
      db
        .insert(pushSubscriptions)
        .values({ ...(row as typeof pushSubscriptions.$inferSelect), id: newId(), sessionId }),
    ).rejects.toThrow();
    await expect(
      db
        .update(pushSubscriptions)
        .set({ endpoint: `https://fcm.googleapis.com/${'a'.repeat(1_024)}` })
        .where(eq(pushSubscriptions.id, deviceId)),
    ).rejects.toThrow();
    await expect(
      db.update(pushSubscriptions).set({ failures: -1 }).where(eq(pushSubscriptions.id, deviceId)),
    ).rejects.toThrow();
  });

  it('defaults the push choice to on when a row is made for email (rule PP1)', async () => {
    const { id: customerId } = await customer();
    const [row] = await db
      .insert(notificationPreferences)
      .values({ customerId, event: 'order_refunded', email: false })
      .returning();
    expect(row).toMatchObject({ email: false, push: true });
  });
});

describe('customer_notifications', () => {
  async function notification(): Promise<string> {
    const { id: customerId } = await customer();
    const { notificationId } = await db.transaction((tx) =>
      notifyCustomer(tx, recordingJobs(), {
        customerId,
        event: 'deposit_credited',
        params: credited(),
      }),
    );
    return notificationId;
  }

  it('lets the app role change read_at only, and delete nothing', async () => {
    const { rows } = await connection.pool.query<{ privileges: Record<string, boolean> }>(
      `select json_object_agg(p, has_table_privilege(current_user, 'customer_notifications', p))
         as privileges
       from unnest(array['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE']) as p`,
    );
    expect(rows[0]?.privileges).toEqual({
      SELECT: true,
      INSERT: true,
      UPDATE: false,
      DELETE: false,
      TRUNCATE: false,
    });
    const id = await notification();
    await connection.pool.query('update customer_notifications set read_at = now() where id = $1', [
      id,
    ]);
    for (const statement of [
      `update customer_notifications set params = '{}' where id = $1`,
      'delete from customer_notifications where id = $1',
    ])
      await expect(connection.pool.query(statement, [id])).rejects.toThrow(/permission denied/);
  });

  it('refuses the owner any change but the first read time', async () => {
    const id = await notification();
    for (const statement of [
      `update customer_notifications set params = '{}' where id = $1`,
      `update customer_notifications set event = 'wallet_adjusted' where id = $1`,
      'delete from customer_notifications where id = $1',
    ])
      await expect(owner.pool.query(statement, [id])).rejects.toThrow(
        /only its read time|never deleted/,
      );
    await owner.pool.query('update customer_notifications set read_at = now() where id = $1', [id]);
    await expect(
      owner.pool.query('update customer_notifications set read_at = null where id = $1', [id]),
    ).rejects.toThrow(/already read/);
    await expect(owner.pool.query('truncate customer_notifications')).rejects.toThrow(
      /append-only/,
    );
  });
});
