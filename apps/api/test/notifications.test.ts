import {
  NOTIFICATION_EVENTS,
  type NotificationEvent,
  type NotificationParams,
} from '@vertex-digital/contracts';
import { auditEntries, customerNotifications, emailOutbox, newId } from '@vertex-digital/db';
import { and, eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { NotificationStreamService } from '../src/modules/notifications/notification-stream.service.js';
import { NotificationsService } from '../src/modules/notifications/notifications.service.js';
import { api, body, openCustomerStream, removeAccounts, seedCustomer } from './helpers.js';
import { startApp, type TestApp } from './start-app.js';

/*
 * The customer notification center (S05 F27, rules NT1, NT5, NT6, NT8) over HTTP against the test
 * database. Notifications are written through `NotificationsService.notifyCustomer`, as the
 * deposit and wallet services do; their call sites are covered by their own tests (rule NT2).
 */

let test: TestApp;
let client: ReturnType<typeof api>;
const seeded: string[] = [];

beforeAll(async () => {
  test = await startApp();
  client = api(test.url);
});

afterAll(async () => {
  await removeAccounts(test.db, seeded);
  await test.app.close();
});

async function signedIn() {
  const customer = await seedCustomer(test.db);
  seeded.push(customer.id);
  return { ...customer, cookie: await client.signInCustomer(customer.email) };
}

const credited = (): NotificationParams<'deposit_credited'> => ({
  depositId: newId(),
  referenceCode: 'VD-ABC23',
  creditedUsdUnits: 20_000_000,
});

const notify = <Event extends NotificationEvent>(
  customerId: string,
  event: Event,
  params: NotificationParams<Event>,
) =>
  test.db.transaction((tx) =>
    test.app.get(NotificationsService).notifyCustomer(tx, { customerId, event, params }),
  );

async function newest(customerId: string): Promise<string> {
  const [row] = await test.db
    .select({ id: customerNotifications.id })
    .from(customerNotifications)
    .where(eq(customerNotifications.customerId, customerId))
    .orderBy(sql`${customerNotifications.createdAt} desc, ${customerNotifications.id} desc`)
    .limit(1);
  return row?.id as string;
}

const openStream = (cookie: string) => openCustomerStream(client, cookie);

describe('access', () => {
  it('answers 401 without a customer session, and to the admin', async () => {
    const admin = await client.adminWithTotp(test.db);
    seeded.push(admin.id);
    for (const options of [{}, { cookie: admin.cookie }]) {
      expect((await client.get('/api/notifications', options)).status).toBe(401);
      expect(
        (await client.post('/api/notifications/read', { ...options, body: { upToId: newId() } }))
          .status,
      ).toBe(401);
      expect((await client.get('/api/notifications/stream', options)).status).toBe(401);
      expect((await client.get('/api/account/notification-preferences', options)).status).toBe(401);
      expect(
        (
          await client.request('PUT', '/api/account/notification-preferences', {
            ...options,
            body: { event: 'deposit_rejected', email: false },
          })
        ).status,
      ).toBe(401);
    }
  });
});

describe('the list (rule NT5)', () => {
  it('is empty at first, never cached', async () => {
    const customer = await signedIn();
    const response = await client.get('/api/notifications', { cookie: customer.cookie });
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(await body(response)).toEqual({
      status: 200,
      items: [],
      nextCursor: null,
      unreadCount: 0,
    });
  });

  it('pages newest first, with the unread count', async () => {
    const customer = await signedIn();
    const first = credited();
    await notify(customer.id, 'deposit_credited', first);
    await notify(customer.id, 'deposit_receipt_requested', {
      depositId: first.depositId,
      referenceCode: 'VD-ABC23',
    });
    await notify(customer.id, 'wallet_adjusted', {
      direction: 'debit',
      amountUnits: 1_000_000,
      category: 'correction',
      reversal: true,
    });
    const page = (await (
      await client.get('/api/notifications?limit=2', { cookie: customer.cookie })
    ).json()) as {
      items: { event: string; readAt: null }[];
      nextCursor: string;
      unreadCount: number;
    };
    expect(page.items.map((item) => item.event)).toEqual([
      'wallet_adjusted',
      'deposit_receipt_requested',
    ]);
    expect(page.unreadCount).toBe(3);
    const next = (await (
      await client.get(`/api/notifications?limit=2&cursor=${page.nextCursor}`, {
        cookie: customer.cookie,
      })
    ).json()) as { items: { event: string; params: unknown }[]; nextCursor: null };
    expect(next.items).toEqual([
      expect.objectContaining({ event: 'deposit_credited', params: first, readAt: null }),
    ]);
    expect(next.nextCursor).toBeNull();
  });

  it('refuses a broken cursor', async () => {
    const customer = await signedIn();
    expect(
      await body(await client.get('/api/notifications?cursor=nope', { cookie: customer.cookie })),
    ).toMatchObject({ status: 400, code: 'VALIDATION_FAILED' });
  });

  it("never shows or marks another customer's notifications", async () => {
    const owner = await signedIn();
    const other = await signedIn();
    await notify(owner.id, 'deposit_credited', credited());
    const page = await body(await client.get('/api/notifications', { cookie: other.cookie }));
    expect(page).toMatchObject({ items: [], unreadCount: 0 });
    expect(
      await body(
        await client.post('/api/notifications/read', {
          cookie: other.cookie,
          body: { upToId: await newest(owner.id) },
        }),
      ),
    ).toMatchObject({ status: 404, code: 'NOT_FOUND' });
    const ownPage = await body(await client.get('/api/notifications', { cookie: owner.cookie }));
    expect(ownPage.unreadCount).toBe(1);
  });

  it('marks read up to the newest shown, leaving later ones unread', async () => {
    const customer = await signedIn();
    await notify(customer.id, 'deposit_credited', credited());
    await notify(customer.id, 'deposit_credited', credited());
    const shown = await newest(customer.id);
    await notify(customer.id, 'deposit_credited', credited());
    const read = await client.post('/api/notifications/read', {
      cookie: customer.cookie,
      body: { upToId: shown },
    });
    expect(read.headers.get('cache-control')).toBe('no-store');
    expect(await body(read)).toEqual({ status: 200, unreadCount: 1 });
    const rows = await test.db
      .select({ readAt: customerNotifications.readAt })
      .from(customerNotifications)
      .where(eq(customerNotifications.customerId, customer.id))
      .orderBy(customerNotifications.id);
    expect(rows.map((row) => row.readAt !== null)).toEqual([true, true, false]);
    // Again: nothing more to mark.
    expect(
      await body(
        await client.post('/api/notifications/read', {
          cookie: customer.cookie,
          body: { upToId: shown },
        }),
      ),
    ).toEqual({ status: 200, unreadCount: 1 });
  });
});

describe('email preferences (rule NT8)', () => {
  const preferencesOf = async (cookie: string) =>
    body(await client.get('/api/account/notification-preferences', { cookie }));
  const set = (cookie: string, input: Record<string, unknown>) =>
    client.request('PUT', '/api/account/notification-preferences', { cookie, body: input });

  it('are all on by default', async () => {
    const customer = await signedIn();
    expect(await preferencesOf(customer.cookie)).toEqual({
      status: 200,
      email: Object.fromEntries(NOTIFICATION_EVENTS.map((event) => [event, true])),
    });
  });

  it('turn one email off, audited once, and the event is still recorded', async () => {
    const customer = await signedIn();
    const response = await set(customer.cookie, { event: 'deposit_rejected', email: false });
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(await body(response)).toMatchObject({
      status: 200,
      email: { deposit_rejected: false, deposit_credited: true },
    });
    // The same value again: no new audit entry.
    expect((await set(customer.cookie, { event: 'deposit_rejected', email: false })).status).toBe(
      200,
    );
    const audits = await test.db
      .select()
      .from(auditEntries)
      .where(
        and(
          eq(auditEntries.entityId, customer.id),
          eq(auditEntries.action, 'customer.notification_preference_changed'),
        ),
      );
    expect(audits).toEqual([
      expect.objectContaining({
        actorKind: 'customer',
        actorId: customer.id,
        channel: 'store',
        entityType: 'customer',
        details: { event: 'deposit_rejected', email: false },
      }),
    ]);

    await notify(customer.id, 'deposit_rejected', {
      depositId: newId(),
      referenceCode: 'VD-ABC23',
      reason: 'not_received',
    });
    await notify(customer.id, 'deposit_credited', credited());
    const emails = await test.db
      .select({ template: emailOutbox.template })
      .from(emailOutbox)
      .where(eq(emailOutbox.customerId, customer.id));
    expect(emails.map((email) => email.template)).not.toContain('customer_deposit_rejected');
    expect(emails.map((email) => email.template)).toContain('customer_deposit_credited');
    expect(
      (await body(await client.get('/api/notifications', { cookie: customer.cookie }))).unreadCount,
    ).toBe(2);

    // And back on.
    expect(
      await body(await set(customer.cookie, { event: 'deposit_rejected', email: true })),
    ).toMatchObject({ email: { deposit_rejected: true } });
  });

  it('serialize two first changes of one choice: one audit entry', async () => {
    const customer = await signedIn();
    const answers = await Promise.all([
      set(customer.cookie, { event: 'wallet_adjusted', email: false }),
      set(customer.cookie, { event: 'wallet_adjusted', email: false }),
    ]);
    expect(answers.map((answer) => answer.status)).toEqual([200, 200]);
    const audits = await test.db
      .select()
      .from(auditEntries)
      .where(
        and(
          eq(auditEntries.entityId, customer.id),
          eq(auditEntries.action, 'customer.notification_preference_changed'),
        ),
      );
    expect(audits).toHaveLength(1);
  });

  it('refuse an event that is not a notification', async () => {
    const customer = await signedIn();
    expect(
      await body(await set(customer.cookie, { event: 'customer_new_sign_in', email: false })),
    ).toMatchObject({ status: 400, code: 'VALIDATION_FAILED' });
  });
});

describe('the live stream (rule NT6)', () => {
  it('sends the count on connect, then each new notification of this customer only', async () => {
    const customer = await signedIn();
    const other = await signedIn();
    await notify(customer.id, 'deposit_credited', credited());
    const stream = await openStream(customer.cookie);
    expect(stream.response.status).toBe(200);
    expect(stream.response.headers.get('content-type')).toContain('text/event-stream');
    expect(stream.response.headers.get('cache-control')).toBe('no-store');
    expect(await stream.event(1)).toEqual({ event: 'unread', data: { unreadCount: 1 } });

    await notify(other.id, 'deposit_credited', credited());
    const params = credited();
    await notify(customer.id, 'deposit_credited', params);
    const delivered = await stream.event(2);
    expect(delivered).toEqual({
      event: 'notification',
      data: {
        notification: expect.objectContaining({ event: 'deposit_credited', params, readAt: null }),
        unreadCount: 2,
      },
    });
    // The other customer's notification never reached this stream.
    expect(stream.events).toHaveLength(2);
    await stream.close();
  });

  it('closes the oldest stream when a 4th opens', async () => {
    const customer = await signedIn();
    const streams = [];
    for (let index = 0; index < 4; index += 1) {
      const stream = await openStream(customer.cookie);
      await stream.event(1);
      streams.push(stream);
    }
    await streams[0]?.waitEnded();
    expect(streams.slice(1).map((stream) => stream.ended())).toEqual([false, false, false]);
    await Promise.all(streams.map((stream) => stream.close()));
  });

  it('refuses a 31st connection in a minute', async () => {
    const customer = await signedIn();
    for (let index = 0; index < 30; index += 1) {
      const stream = await openStream(customer.cookie);
      await stream.event(1);
      await stream.close();
    }
    expect(
      await body(await client.get('/api/notifications/stream', { cookie: customer.cookie })),
    ).toMatchObject({ status: 429, code: 'RATE_LIMITED' });
  });

  it('closes a stream whose session was signed out', async () => {
    const customer = await signedIn();
    const stream = await openStream(customer.cookie);
    await stream.event(1);
    const elsewhere = await client.signInCustomer(customer.email);
    expect((await client.post('/api/auth/revoke-sessions', { cookie: elsewhere })).status).toBe(
      200,
    );
    await test.app.get(NotificationStreamService).checkSessions();
    await stream.waitEnded();
  });

  it('sends resync when the listening connection comes back (edge case 13)', async () => {
    const customer = await signedIn();
    const stream = await openStream(customer.cookie);
    await stream.event(1);
    await test.db.execute(
      sql`select pg_terminate_backend(pid) from pg_stat_activity
          where usename = current_user and query like 'LISTEN customer_%'`,
    );
    expect(await stream.event(2)).toEqual({ event: 'resync', data: {} });
    // Listening again: a new notification arrives.
    await notify(customer.id, 'deposit_credited', credited());
    expect((await stream.event(3)).event).toBe('notification');
    await stream.close();
  });
});
