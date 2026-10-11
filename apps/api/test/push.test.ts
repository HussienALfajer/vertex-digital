import { NOTIFICATION_EVENTS, PUSH_SUBSCRIPTIONS_MAX, vapidKeyId } from '@vertex-digital/contracts';
import {
  auditEntries,
  customerSessions,
  newId,
  notificationPreferences,
  pushSubscriptions,
} from '@vertex-digital/db';
import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ENV, type Env } from '../src/core/config/env.js';
import { api, body, removeAccounts, seedCustomer } from './helpers.js';
import { startApp, type TestApp } from './start-app.js';

/*
 * Web push devices and choices (S15 rules PS1–PS8, PP1, PD1's counterpart in the admin profile)
 * over HTTP against the test database. Sending is the worker's (`apps/worker/test/push.test.ts`).
 */

let test: TestApp;
let client: ReturnType<typeof api>;
let publicKey: string;
const seeded: string[] = [];

beforeAll(async () => {
  test = await startApp();
  client = api(test.url);
  publicKey = test.app.get<Env>(ENV).VAPID_PUBLIC_KEY as string;
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

const p256dh = `B${'p'.repeat(86)}`;
const auth = 'a'.repeat(22);

const subscription = (endpoint = `https://fcm.googleapis.com/fcm/send/${newId()}`) => ({
  endpoint,
  expirationTime: null,
  keys: { p256dh, auth },
});

const register = (cookie: string, input: unknown, ip?: string) =>
  client.request('PUT', '/api/push/subscription', { cookie, body: input, ip });

const unregister = (cookie: string, endpoint: string) =>
  client.request('DELETE', '/api/push/subscription', { cookie, body: { endpoint } });

const devicesOf = (customerId: string) =>
  test.db
    .select()
    .from(pushSubscriptions)
    .where(eq(pushSubscriptions.customerId, customerId))
    .orderBy(pushSubscriptions.updatedAt);

describe('access', () => {
  it('serves the public key to anyone, cached 5 minutes', async () => {
    const response = await client.get('/api/push/config');
    expect(response.headers.get('cache-control')).toBe('public, max-age=300');
    expect(await body(response)).toEqual({ status: 200, publicKey });
  });

  it('answers 401 without a customer session, and to the admin', async () => {
    const admin = await client.adminWithTotp(test.db);
    seeded.push(admin.id);
    for (const options of [{}, { cookie: admin.cookie }]) {
      expect(
        (
          await client.request('PUT', '/api/push/subscription', {
            ...options,
            body: subscription(),
          })
        ).status,
      ).toBe(401);
      expect(
        (
          await client.request('DELETE', '/api/push/subscription', {
            ...options,
            body: { endpoint: subscription().endpoint },
          })
        ).status,
      ).toBe(401);
    }
  });

  it('refuses a customer the admin profile', async () => {
    const customer = await signedIn();
    expect(
      (await client.get(`/api/admin/customers/${customer.id}`, { cookie: customer.cookie })).status,
    ).toBe(401);
  });
});

describe('registration (PS1–PS3)', () => {
  it('stores the device for this session with the key id, and refreshes it', async () => {
    const customer = await signedIn();
    const input = subscription();
    const response = await register(customer.cookie, input);
    expect(response.status).toBe(204);
    expect(response.headers.get('cache-control')).toBe('no-store');
    const [row] = await devicesOf(customer.id);
    const [session] = await test.db
      .select({ id: customerSessions.id })
      .from(customerSessions)
      .where(eq(customerSessions.userId, customer.id));
    expect(row).toMatchObject({
      endpoint: input.endpoint,
      sessionId: session?.id,
      p256dh,
      auth,
      vapidKeyId: vapidKeyId(publicKey),
      failures: 0,
    });

    // The same endpoint again (PS6): one row, failures cleared, new keys.
    await test.db
      .update(pushSubscriptions)
      .set({ failures: 3 })
      .where(eq(pushSubscriptions.id, row?.id as string));
    const renewed = { ...input, keys: { p256dh, auth: 'b'.repeat(22) } };
    expect((await register(customer.cookie, renewed)).status).toBe(204);
    expect(await devicesOf(customer.id)).toEqual([
      expect.objectContaining({ id: row?.id, auth: 'b'.repeat(22), failures: 0 }),
    ]);
  });

  it('moves an endpoint to the customer who registered it last (edge case 5)', async () => {
    const first = await signedIn();
    const second = await signedIn();
    const input = subscription();
    await register(first.cookie, input);
    expect((await register(second.cookie, input)).status).toBe(204);
    expect(await devicesOf(first.id)).toEqual([]);
    expect(await devicesOf(second.id)).toEqual([
      expect.objectContaining({ endpoint: input.endpoint }),
    ]);
  });

  it(`keeps at most ${PUSH_SUBSCRIPTIONS_MAX} devices, removing the oldest (PS3)`, async () => {
    const customer = await signedIn();
    const endpoints: string[] = [];
    for (let index = 0; index <= PUSH_SUBSCRIPTIONS_MAX; index += 1) {
      const input = subscription();
      endpoints.push(input.endpoint);
      expect((await register(customer.cookie, input)).status).toBe(204);
    }
    const rows = await devicesOf(customer.id);
    expect(rows).toHaveLength(PUSH_SUBSCRIPTIONS_MAX);
    expect(rows.map((row) => row.endpoint)).not.toContain(endpoints[0]);
    expect(rows.map((row) => row.endpoint)).toContain(endpoints.at(-1));
  });

  it('refuses endpoints off the push services (PS2)', async () => {
    const customer = await signedIn();
    for (const endpoint of [
      'http://fcm.googleapis.com/fcm/send/x',
      'https://127.0.0.1/push',
      'https://internal.example/push',
      'https://fcm.googleapis.com:8443/fcm/send/x',
      'https://user@fcm.googleapis.com/fcm/send/x',
      'not a url',
    ]) {
      expect(await body(await register(customer.cookie, subscription(endpoint)))).toMatchObject({
        status: 400,
        code: 'PUSH_ENDPOINT_REFUSED',
      });
    }
    expect(await devicesOf(customer.id)).toEqual([]);
  });

  it('refuses keys of the wrong length', async () => {
    const customer = await signedIn();
    expect(
      await body(
        await register(customer.cookie, { ...subscription(), keys: { p256dh, auth: 'short' } }),
      ),
    ).toMatchObject({ status: 400, code: 'VALIDATION_FAILED' });
  });

  it('refuses registration when push is not configured', async () => {
    const customer = await signedIn();
    const env = test.app.get<Env>(ENV);
    env.VAPID_PUBLIC_KEY = undefined;
    try {
      expect(await body(await client.get('/api/push/config'))).toEqual({
        status: 200,
        publicKey: null,
      });
      expect(await body(await register(customer.cookie, subscription()))).toMatchObject({
        status: 409,
        code: 'PUSH_NOT_CONFIGURED',
      });
    } finally {
      env.VAPID_PUBLIC_KEY = publicKey;
    }
  });

  it('allows 20 changes an hour per customer', async () => {
    const customer = await signedIn();
    const statuses: number[] = [];
    for (let index = 0; index < 21; index += 1) {
      // A new address each time: the limit is the customer's, not the address's.
      statuses.push((await register(customer.cookie, subscription())).status);
    }
    expect(statuses.slice(0, 20).every((status) => status === 204)).toBe(true);
    expect(statuses[20]).toBe(429);
    expect((await unregister(customer.cookie, subscription().endpoint)).status).toBe(429);
  });
});

describe('removal and sessions (PS4, PS8)', () => {
  it("removes the customer's own device, and answers 204 for anyone else's", async () => {
    const owner = await signedIn();
    const other = await signedIn();
    const input = subscription();
    await register(owner.cookie, input);
    expect((await unregister(other.cookie, input.endpoint)).status).toBe(204);
    expect(await devicesOf(owner.id)).toHaveLength(1);
    expect((await unregister(owner.cookie, input.endpoint)).status).toBe(204);
    expect(await devicesOf(owner.id)).toEqual([]);
    expect((await unregister(owner.cookie, input.endpoint)).status).toBe(204);
  });

  it('removes the device when its session signs out', async () => {
    const customer = await signedIn();
    await register(customer.cookie, subscription());
    expect(
      (await client.request('POST', '/api/auth/sign-out', { cookie: customer.cookie, body: {} }))
        .status,
    ).toBe(200);
    expect(await devicesOf(customer.id)).toEqual([]);
  });
});

describe('push preferences (PP1)', () => {
  const set = (cookie: string, input: Record<string, unknown>) =>
    client.request('PUT', '/api/account/notification-preferences', { cookie, body: input });

  it('turn one push off, audited once, leaving the email on', async () => {
    const customer = await signedIn();
    const answer = await body(
      await set(customer.cookie, { event: 'order_delivered', push: false }),
    );
    expect(answer).toMatchObject({
      status: 200,
      email: { order_delivered: true },
      push: { order_delivered: false, deposit_credited: true },
    });
    expect((await set(customer.cookie, { event: 'order_delivered', push: false })).status).toBe(
      200,
    );
    const audits = await test.db
      .select()
      .from(auditEntries)
      .where(
        and(
          eq(auditEntries.entityId, customer.id),
          eq(auditEntries.action, 'customer.push_preference_changed'),
        ),
      );
    expect(audits).toEqual([
      expect.objectContaining({
        actorKind: 'customer',
        actorId: customer.id,
        details: { event: 'order_delivered', push: false },
      }),
    ]);

    // An email change keeps the push choice of the same row.
    expect(
      await body(await set(customer.cookie, { event: 'order_delivered', email: false })),
    ).toMatchObject({ email: { order_delivered: false }, push: { order_delivered: false } });
    const [row] = await test.db
      .select()
      .from(notificationPreferences)
      .where(
        and(
          eq(notificationPreferences.customerId, customer.id),
          eq(notificationPreferences.event, 'order_delivered'),
        ),
      );
    expect(row).toMatchObject({ email: false, push: false });
  });

  it('refuse push for a center-only event and two channels at once', async () => {
    const customer = await signedIn();
    for (const input of [
      { event: 'order_delayed', push: false },
      { event: 'order_delivered', email: false, push: false },
    ]) {
      expect(await body(await set(customer.cookie, input))).toMatchObject({
        status: 400,
        code: 'VALIDATION_FAILED',
      });
    }
    const preferences = await body(
      await client.get('/api/account/notification-preferences', { cookie: customer.cookie }),
    );
    expect(preferences.push).toEqual(
      Object.fromEntries(NOTIFICATION_EVENTS.map((event) => [event, true])),
    );
  });
});

describe('admin profile (S15)', () => {
  it('counts the devices of live sessions', async () => {
    const admin = await client.adminWithTotp(test.db);
    seeded.push(admin.id);
    const customer = await signedIn();
    const devices = async () =>
      (
        (await body(
          await client.get(`/api/admin/customers/${customer.id}`, { cookie: admin.cookie }),
        )) as { counts: { pushDevices: number } }
      ).counts.pushDevices;
    expect(await devices()).toBe(0);
    await register(customer.cookie, subscription());
    await register(customer.cookie, subscription());
    expect(await devices()).toBe(2);
    await test.db
      .update(customerSessions)
      .set({ expiresAt: new Date(Date.now() - 1_000) })
      .where(eq(customerSessions.userId, customer.id));
    expect(await devices()).toBe(0);
  });
});
