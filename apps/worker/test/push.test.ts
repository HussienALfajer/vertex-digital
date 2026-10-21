import { createECDH, randomBytes, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  NOTIFICATION_PARAMS,
  type NotificationParams,
  PUSH_NOTIFICATION_EVENTS,
  type PushNotificationEvent,
  QUEUES,
  vapidKeyId,
} from '@vertex-digital/contracts';
import {
  createDatabase,
  customerNotifications,
  customerSessions,
  customers,
  newId,
  notificationPreferences,
  pushSubscriptions,
} from '@vertex-digital/db';
import { eq } from 'drizzle-orm';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import webPush from 'web-push';
import type { PgBossService } from '../src/core/jobs/pg-boss.service.js';
import {
  PUSH_FAILURES_MAX,
  PUSH_MAX_AGE_SECONDS,
  pushOutcome,
  pushTopic,
  pushTtlSeconds,
  pushUrgency,
} from '../src/jobs/push/push-rules.js';
import { PUSH_TITLE, renderPush } from '../src/jobs/push/push-texts.js';
import { SendPushJob } from '../src/jobs/push/send.job.js';
import { PushSender } from '../src/push/push-sender.js';

const sentry = vi.hoisted(() => ({ captureMessage: vi.fn() }));
vi.mock('@sentry/nestjs', () => ({ captureMessage: sentry.captureMessage }));

/*
 * Web push (S15 PT1–PT3, PD1–PD7): the lock-screen texts, the outcome rules, and `push.send`
 * against the test database with the `log` transport and with a scripted push service (`fetch`
 * stubbed: nothing leaves the machine). Rows are committed on customers of their own.
 */

const connection = createDatabase(process.env.DATABASE_URL as string);
const { db } = connection;
afterAll(() => connection.close());

const vapid = { ...webPush.generateVAPIDKeys(), subject: 'mailto:test@vertex-digital.local' };
const LOG_DIR = join(tmpdir(), `vertex-digital-push-${randomUUID()}`);

const sentJobs: { queue: string; data: object; options: object }[] = [];
const pgBoss = {
  boss: {
    send: async (queue: string, data: object, options: object) => {
      sentJobs.push({ queue, data, options });
      return null;
    },
  },
} as unknown as PgBossService;

beforeEach(() => {
  sentJobs.length = 0;
  sentry.captureMessage.mockClear();
});

const SAMPLE: { [Event in PushNotificationEvent]: NotificationParams<Event> } = {
  deposit_credited: { depositId: newId(), referenceCode: 'VD-K7Q2M', creditedUsdUnits: 25_370_000 },
  deposit_rejected: { depositId: newId(), referenceCode: 'VD-K7Q2M', reason: 'not_received' },
  deposit_receipt_requested: { depositId: newId(), referenceCode: 'VD-K7Q2M' },
  wallet_adjusted: {
    direction: 'credit',
    amountUnits: 13_450_000,
    category: 'compensation',
    reversal: false,
  },
  order_delivered: {
    orderId: newId(),
    orderNumber: 'VD-1000042',
    productNameAr: '660 شدة',
    quantity: 3,
  },
  order_partially_refunded: {
    orderId: newId(),
    orderNumber: 'VD-1000042',
    productNameAr: '660 شدة',
    deliveredQuantity: 2,
    refundedQuantity: 1,
    refundedUsdUnits: 9_870_000,
  },
  order_refunded: {
    orderId: newId(),
    orderNumber: 'VD-1000042',
    productNameAr: '660 شدة',
    refundedUsdUnits: 29_610_000,
    reason: 'routes_exhausted',
  },
  order_cancelled: {
    orderId: newId(),
    orderNumber: 'VD-1000042',
    productNameAr: '660 شدة',
    reason: 'expired',
  },
  checkout_finished: {
    checkoutId: newId(),
    orderCount: 4,
    delivered: 3,
    partiallyRefunded: 0,
    refunded: 1,
    refundedUsdUnits: 4_560_000,
  },
  ticket_replied: { ticketId: newId(), number: 'T-1007' },
  order_placed_for_you: {
    orderId: newId(),
    orderNumber: 'VD-1000042',
    productNameAr: '660 شدة',
    purpose: 'gift',
    message: 'عيد سعيد',
  },
  merchant_info_requested: { applicationId: newId(), message: 'أرسل صورة المحل' },
  merchant_approved: { priceKind: 'wholesale' },
  merchant_rejected: {
    applicationId: newId(),
    reason: 'لم نتحقق من المحل',
    availableAt: '2026-10-28T10:00:00.000Z',
  },
  merchant_revoked: {},
  merchant_level_changed: { levelNameAr: 'فضي', priceKind: 'special', direction: 'up' },
  merchant_low_balance: { balanceUsdUnits: 4_500_000, thresholdUsdUnits: 10_000_000 },
  merchant_watch_digest: {
    priceDown: 2,
    priceUp: 0,
    backInStock: 1,
    outOfStock: 0,
    lines: [],
  },
};

describe('lock-screen texts (PT1–PT3)', () => {
  it('render every push event, small, in Arabic, with its link and tag', () => {
    expect(Object.keys(SAMPLE).sort()).toEqual([...PUSH_NOTIFICATION_EVENTS].sort());
    for (const event of PUSH_NOTIFICATION_EVENTS) {
      const params = NOTIFICATION_PARAMS[event].parse(SAMPLE[event]);
      const payload = renderPush(event, params);
      expect(Buffer.byteLength(JSON.stringify(payload)), event).toBeLessThan(1024);
      expect(payload.title).toBe(PUSH_TITLE);
      expect(payload.body, event).toMatch(/[؀-ۿ]/);
      expect(payload.body, event).not.toMatch(/[!٠-٩]/);
      expect(payload.url, event).toMatch(/^\/[^/]/);
      expect(pushTopic(payload.tag)).toMatch(/^[\w-]{32}$/);
    }
  });

  it('never carry amounts, reasons or anything but the allowed facts (PT2)', () => {
    for (const event of PUSH_NOTIFICATION_EVENTS) {
      // The body is all the lock screen shows; the url and tag hold only ids.
      const text = renderPush(event, SAMPLE[event]).body;
      // No amount in any form: the units, dollars or cents of every sample's amounts.
      for (const amount of ['25', '13', '9.87', '29', '4.56', '$', 'USD', 'ل.س']) {
        expect(text, `${event} ${amount}`).not.toContain(amount);
      }
      for (const word of ['not_received', 'routes_exhausted', 'expired', 'compensation']) {
        expect(text, event).not.toContain(word);
      }
    }
  });

  it('tells an order the store paid for without an amount, and never its note (S16 AP11)', () => {
    expect(renderPush('order_placed_for_you', SAMPLE.order_placed_for_you).body).toBe(
      'هدية من المتجر VD-1000042: 660 شدة',
    );
    expect(
      renderPush('order_refunded', { ...SAMPLE.order_refunded, refundedUsdUnits: null }).body,
    ).toBe('تعذّر تنفيذ الطلب VD-1000042');
    expect(
      renderPush('order_partially_refunded', {
        ...SAMPLE.order_partially_refunded,
        refundedUsdUnits: null,
      }).body,
    ).toBe('سُلّم جزء من طلبك VD-1000042 وتعذّر تنفيذ الباقي');
  });

  it('link and tag each record (PT3)', () => {
    const order = SAMPLE.order_delivered;
    expect(renderPush('order_delivered', order)).toEqual({
      title: 'VERTEX DIGITAL',
      body: `تم تسليم طلبك VD-1000042: 660 شدة × 3`,
      url: `/orders/${order.orderId}`,
      tag: `order-${order.orderId}`,
    });
    expect(renderPush('order_delivered', { ...order, quantity: 1 }).body).toBe(
      'تم تسليم طلبك VD-1000042: 660 شدة',
    );
    const checkout = SAMPLE.checkout_finished;
    expect(renderPush('checkout_finished', checkout)).toMatchObject({
      body: 'اكتملت طلبات سلتك: 3 من 4 سُلّمت وأُعيد الباقي إلى رصيدك',
      url: `/orders?checkout=${checkout.checkoutId}`,
      tag: `checkout-${checkout.checkoutId}`,
    });
    expect(
      renderPush('checkout_finished', { ...checkout, refunded: 0, refundedUsdUnits: 0 }).body,
    ).toBe('اكتملت طلبات سلتك: 3 من 4 سُلّمت');
    expect(renderPush('deposit_credited', SAMPLE.deposit_credited)).toMatchObject({
      body: 'أُضيف إيداعك VD-K7Q2M إلى رصيدك',
      url: `/wallet/deposits/${SAMPLE.deposit_credited.depositId}`,
      tag: `deposit-${SAMPLE.deposit_credited.depositId}`,
    });
    expect(renderPush('wallet_adjusted', SAMPLE.wallet_adjusted)).toMatchObject({
      url: '/wallet',
      tag: 'wallet',
    });
    expect(renderPush('ticket_replied', SAMPLE.ticket_replied)).toMatchObject({
      body: 'ردّ فريق الدعم على تذكرتك T-1007',
      url: `/support/${SAMPLE.ticket_replied.ticketId}`,
      tag: `ticket-${SAMPLE.ticket_replied.ticketId}`,
    });
  });
});

describe('merchant pushes (S20)', () => {
  it('never carry the admin’s message or reason (PT2)', () => {
    for (const event of ['merchant_info_requested', 'merchant_rejected'] as const) {
      const payload = renderPush(event, SAMPLE[event]);
      expect(JSON.stringify(payload)).not.toContain('أرسل صورة المحل');
      expect(JSON.stringify(payload)).not.toContain('لم نتحقق من المحل');
      expect(payload).toMatchObject({ url: '/account/merchant', tag: 'merchant' });
    }
  });
});

describe('delivery rules (PD3, PD4)', () => {
  it('map each answer', () => {
    expect(pushOutcome({ status: 201 })).toBe('delivered');
    expect(pushOutcome({ status: 202 })).toBe('delivered');
    expect(pushOutcome({ status: 404 })).toBe('gone');
    expect(pushOutcome({ status: 410 })).toBe('gone');
    for (const status of [400, 403, 413]) expect(pushOutcome({ status })).toBe('refused');
    for (const status of [429, 500, 503, 301]) expect(pushOutcome({ status })).toBe('transient');
    expect(pushOutcome({ error: 'timeout' })).toBe('transient');
    expect(pushOutcome({ error: 'network' })).toBe('transient');
    expect(pushOutcome({ error: 'invalid_subscription' })).toBe('gone');
  });

  it('take the TTL from the age, and urgency by event', () => {
    const created = new Date('2030-01-01T00:00:00Z');
    expect(pushTtlSeconds(created, created)).toBe(PUSH_MAX_AGE_SECONDS);
    expect(pushTtlSeconds(created, new Date('2030-01-01T01:00:00.900Z'))).toBe(
      PUSH_MAX_AGE_SECONDS - 3600,
    );
    expect(pushTtlSeconds(created, new Date('2030-01-03T00:00:00Z'))).toBe(0);
    expect(pushUrgency('order_delivered')).toBe('high');
    expect(pushUrgency('deposit_credited')).toBe('high');
    for (const event of ['wallet_adjusted', 'checkout_finished', 'ticket_replied'] as const) {
      expect(pushUrgency(event)).toBe('normal');
    }
  });
});

/* The job --------------------------------------------------------------------------------- */

async function customer(): Promise<string> {
  const id = newId();
  await db
    .insert(customers)
    .values({ id, name: 'Test', email: `${id}@test.vertex-digital.local`, phone: '+963900000000' });
  return id;
}

/** A browser's real keys, so `web-push` can encrypt for it. */
function browserKeys() {
  const ecdh = createECDH('prime256v1');
  ecdh.generateKeys();
  return {
    p256dh: ecdh.getPublicKey().toString('base64url'),
    auth: randomBytes(16).toString('base64url'),
  };
}

async function device(
  customerId: string,
  options: {
    endpoint?: string;
    expired?: boolean;
    keyId?: string;
    failures?: number;
  } = {},
): Promise<string> {
  const sessionId = newId();
  await db.insert(customerSessions).values({
    id: sessionId,
    userId: customerId,
    token: `test-${sessionId}`,
    expiresAt: new Date(Date.now() + (options.expired ? -60_000 : 3_600_000)),
  });
  const id = newId();
  await db.insert(pushSubscriptions).values({
    id,
    customerId,
    sessionId,
    endpoint: options.endpoint ?? `https://fcm.googleapis.com/fcm/send/${id}`,
    ...browserKeys(),
    vapidKeyId: options.keyId ?? vapidKeyId(vapid.publicKey),
    failures: options.failures ?? 0,
  });
  return id;
}

async function notification(
  customerId: string,
  event: PushNotificationEvent = 'order_delivered',
  createdAt = new Date(),
): Promise<string> {
  const id = newId();
  await db
    .insert(customerNotifications)
    .values({ id, customerId, event, params: SAMPLE[event], createdAt });
  return id;
}

const rowsOf = (customerId: string) =>
  db.select().from(pushSubscriptions).where(eq(pushSubscriptions.customerId, customerId));

const logJob = (configured = true) =>
  new SendPushJob(
    pgBoss,
    new PushSender({ transport: 'log', vapid: configured ? vapid : undefined, logDir: LOG_DIR }),
    db,
  );

describe('push.send with the log transport (PD2, PD7)', () => {
  it('sends to the live devices of the current key and records the delivery', async () => {
    const customerId = await customer();
    const live = await device(customerId);
    const expired = await device(customerId, { expired: true });
    const oldKey = await device(customerId, { keyId: 'an-older-key-id0' });
    const notificationId = await notification(customerId);

    const result = await logJob().send({ notificationId });
    expect(result).toEqual({ outcomes: { [live]: 'delivered' }, retried: [] });

    const rows = await rowsOf(customerId);
    expect(rows.map((row) => row.id).sort()).toEqual([live, expired].sort());
    expect(rows.find((row) => row.id === live)?.lastSentAt).toBeInstanceOf(Date);
    expect(rows.find((row) => row.id === expired)?.lastSentAt).toBeNull();
    expect(rows.map((row) => row.id)).not.toContain(oldKey);

    const lines = (await readFile(join(LOG_DIR, `${notificationId}.jsonl`), 'utf8'))
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line));
    expect(lines).toEqual([
      expect.objectContaining({
        host: 'fcm.googleapis.com',
        headers: {
          TTL: expect.stringMatching(/^\d+$/),
          Urgency: 'high',
          Topic: pushTopic(`order-${SAMPLE.order_delivered.orderId}`),
        },
        payload: renderPush('order_delivered', SAMPLE.order_delivered),
      }),
    ]);
    // Never the keys.
    expect(JSON.stringify(lines)).not.toContain(rows[0]?.auth);
  });

  it('sends nothing when the push is turned off, too old, or not configured', async () => {
    const customerId = await customer();
    await device(customerId);
    const off = await notification(customerId, 'deposit_credited');
    await db
      .insert(notificationPreferences)
      .values({ customerId, event: 'deposit_credited', email: true, push: false });
    expect(await logJob().send({ notificationId: off })).toMatchObject({ skipped: 'turned_off' });

    const old = await notification(
      customerId,
      'order_delivered',
      new Date(Date.now() - 86_400_000),
    );
    expect(await logJob().send({ notificationId: old })).toMatchObject({ skipped: 'too_old' });

    const fresh = await notification(customerId);
    expect(await logJob(false).send({ notificationId: fresh })).toMatchObject({
      skipped: 'not_configured',
    });
    expect(await logJob().send({ notificationId: newId() })).toMatchObject({ skipped: 'missing' });
  });
});

describe('push.send against a push service (PD3–PD5)', () => {
  /** Answers each endpoint with its scripted status; records the requests. */
  function service(answers: Record<string, number | 'timeout'>) {
    const requests: { url: string; init: RequestInit }[] = [];
    const fetchFn = (async (url: string, init: RequestInit) => {
      requests.push({ url, init });
      const answer = answers[url];
      if (answer === 'timeout')
        throw Object.assign(new Error('timed out'), { name: 'TimeoutError' });
      return new Response(null, { status: answer ?? 201 });
    }) as unknown as typeof fetch;
    const job = new SendPushJob(
      pgBoss,
      new PushSender({ transport: 'web-push', vapid, logDir: LOG_DIR }, fetchFn),
      db,
    );
    return { job, requests };
  }

  const endpointOf = async (id: string) =>
    (await db.select().from(pushSubscriptions).where(eq(pushSubscriptions.id, id)))[0]?.endpoint ??
    '';

  it('settles each answer and retries only the transient ones', async () => {
    const customerId = await customer();
    const ok = await device(customerId);
    const gone = await device(customerId);
    const busy = await device(customerId);
    const refused = await device(customerId);
    const slow = await device(customerId);
    const urls = {
      ok: await endpointOf(ok),
      gone: await endpointOf(gone),
      busy: await endpointOf(busy),
      refused: await endpointOf(refused),
      slow: await endpointOf(slow),
    };
    const { job, requests } = service({
      [urls.gone]: 410,
      [urls.busy]: 429,
      [urls.refused]: 403,
      [urls.slow]: 'timeout',
    });
    const notificationId = await notification(customerId, 'ticket_replied');
    const result = await job.send({ notificationId });

    expect(result.outcomes).toEqual({
      [ok]: 'delivered',
      [gone]: 'gone',
      [busy]: 'transient',
      [refused]: 'refused',
      [slow]: 'transient',
    });
    expect(result.retried.sort()).toEqual([busy, slow].sort());
    const rows = new Map((await rowsOf(customerId)).map((row) => [row.id, row]));
    expect(rows.has(gone)).toBe(false);
    expect(rows.get(busy)?.failures).toBe(1);
    expect(rows.get(refused)?.failures).toBe(0);
    expect(rows.get(ok)?.lastSentAt).toBeInstanceOf(Date);

    // One Sentry event for the job, without the payload or keys.
    expect(sentry.captureMessage).toHaveBeenCalledTimes(1);
    expect(String(sentry.captureMessage.mock.calls[0]?.[0])).not.toContain('VD-');

    expect(sentJobs).toEqual([
      {
        queue: QUEUES.pushSend,
        data: { notificationId, subscriptionIds: expect.any(Array), retry: 1 },
        options: { retryLimit: 0, startAfter: 60 },
      },
    ]);
    const retried = sentJobs[0]?.data as { subscriptionIds: string[] };
    expect(retried.subscriptionIds.sort()).toEqual([busy, slow].sort());

    // The request: encrypted, signed for the endpoint's origin, no redirects followed.
    const request = requests.find((entry) => entry.url === urls.ok);
    const headers = request?.init.headers as Record<string, string>;
    expect(request?.init.redirect).toBe('manual');
    expect(headers['Content-Encoding']).toBe('aes128gcm');
    expect(headers.Urgency).toBe('normal');
    expect(headers.Topic).toBe(pushTopic(`ticket-${SAMPLE.ticket_replied.ticketId}`));
    expect(Number(headers.TTL)).toBeGreaterThan(PUSH_MAX_AGE_SECONDS - 60);
    expect(headers.Authorization).toMatch(/^vapid t=.+, k=/);
    expect(Buffer.from(request?.init.body as Uint8Array).toString()).not.toContain('T-1007');

    // The retry sends to the named devices only; the second retry is the last.
    const retry = await job.send({ notificationId, subscriptionIds: [busy], retry: 2 });
    expect(Object.keys(retry.outcomes)).toEqual([busy]);
    expect(retry.retried).toEqual([]);
    expect(sentJobs).toHaveLength(1);
  });

  it(`deletes a device after ${PUSH_FAILURES_MAX} transient failures in a row`, async () => {
    const customerId = await customer();
    const failing = await device(customerId, { failures: PUSH_FAILURES_MAX - 1 });
    const { job } = service({ [await endpointOf(failing)]: 503 });
    const result = await job.send({ notificationId: await notification(customerId) });
    expect(result.outcomes).toEqual({ [failing]: 'transient' });
    expect(result.retried).toEqual([]);
    expect(await rowsOf(customerId)).toEqual([]);
  });

  it('deletes a device whose keys cannot be encrypted for, and still serves the others', async () => {
    const customerId = await customer();
    const good = await device(customerId);
    const broken = await device(customerId);
    await db
      .update(pushSubscriptions)
      .set({ p256dh: `B${'p'.repeat(86)}` })
      .where(eq(pushSubscriptions.id, broken));
    const { job } = service({});
    const result = await job.send({ notificationId: await notification(customerId) });
    expect(result.outcomes).toEqual({ [good]: 'delivered', [broken]: 'gone' });
    expect((await rowsOf(customerId)).map((row) => row.id)).toEqual([good]);
  });

  it('checks the host again before sending (PS2)', async () => {
    const customerId = await customer();
    const planted = await device(customerId, { endpoint: 'https://127.0.0.1:8080/steal' });
    const { job, requests } = service({});
    const result = await job.send({ notificationId: await notification(customerId) });
    expect(result.outcomes).toEqual({ [planted]: 'host_refused' });
    expect(requests).toEqual([]);
    expect(await rowsOf(customerId)).toEqual([]);
  });
});
