import { randomBytes, randomUUID } from 'node:crypto';
import { DEPOSIT_SETTINGS_DEFAULTS } from '@vertex-digital/contracts';
import {
  customers,
  merchantProfiles,
  merchantTierSettings,
  newId,
  supportMessages,
  supportTickets,
  telegramMessages,
} from '@vertex-digital/db';
import { and, desc, eq, sql } from 'drizzle-orm';
import sharp from 'sharp';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { FilesService } from '../src/modules/files/index.js';
import {
  api,
  auditOf,
  emailsTo,
  notificationsOf,
  PASSWORD,
  removeAccounts,
  seedCustomer,
  setSwitches,
  totp,
  uniquePhone,
} from './helpers.js';
import { startApp, type TestApp } from './start-app.js';

/*
 * Support tickets and channels (S12 F23) over HTTP against the test database: the customer's and
 * the admin's routes, the limits, links, idempotency, attachments, Telegram notices and the
 * customer's notification. Tickets are never deleted, so their customers stay (by design).
 */

let test: TestApp;
let client: ReturnType<typeof api>;
let admin: Awaited<ReturnType<ReturnType<typeof api>['adminWithTotp']>>;
let plainAdmin: string;
const seeded: string[] = [];
const USD = 1_000_000;

async function json<T = Record<string, unknown>>(response: Response, status: number): Promise<T> {
  const payload = await response.json();
  expect(response.status, JSON.stringify(payload)).toBe(status);
  return payload as T;
}

const image = () =>
  sharp(randomBytes(32 * 32 * 3), { raw: { width: 32, height: 32, channels: 3 } })
    .png()
    .toBuffer();

async function customer() {
  const seededCustomer = await seedCustomer(test.db, { phone: uniquePhone() });
  seeded.push(seededCustomer.id);
  return { ...seededCustomer, cookie: await client.signInCustomer(seededCustomer.email) };
}

type Customer = Awaited<ReturnType<typeof customer>>;

interface TicketView {
  id: string;
  number: string;
  status: string;
  canReply: boolean;
  lastAuthor: string;
  messages: { id: string; author: string; body: string; attachments: string[] }[];
}

async function multipart(fields: Record<string, string>, images = 0) {
  const data = new FormData();
  for (const [key, value] of Object.entries(fields)) data.set(key, value);
  for (let index = 0; index < images; index += 1) {
    data.append('files', new Blob([new Uint8Array(await image())]), `image-${index}.png`);
  }
  return data;
}

const openTicket = async (
  who: Customer,
  fields: Record<string, string> = {},
  options: { images?: number; key?: string } = {},
) =>
  client.post('/api/support/tickets', {
    cookie: who.cookie,
    form: await multipart(
      { category: 'account', subject: 'سؤال عن حسابي', body: 'مرحباً', ...fields },
      options.images ?? 0,
    ),
    headers: { 'idempotency-key': options.key ?? randomUUID(), ...(await client.altcha()) },
  });

const reply = async (who: Customer, id: string, body = 'شكراً', key = randomUUID()) =>
  client.post(`/api/support/tickets/${id}/messages`, {
    cookie: who.cookie,
    form: await multipart({ body }),
    headers: { 'idempotency-key': key },
  });

const adminReply = async (id: string, body = 'تم التحقق', images = 0, key = randomUUID()) =>
  client.post(`/api/admin/support/tickets/${id}/messages`, {
    cookie: admin.cookie,
    form: await multipart({ body }, images),
    headers: { 'idempotency-key': key },
  });

const shamCash = async (who: Customer) =>
  json<{ id: string }>(
    await client.post('/api/deposits/sham-cash', {
      cookie: who.cookie,
      body: { currency: 'USD', amountUnits: 5 * USD },
      headers: { 'idempotency-key': randomUUID(), ...(await client.altcha()) },
    }),
    201,
  );

const telegramOf = (ticketId: string) =>
  test.db
    .select({ kind: telegramMessages.kind, params: telegramMessages.params })
    .from(telegramMessages)
    .where(sql`${telegramMessages.params}->>'ticketId' = ${ticketId}`);

beforeAll(async () => {
  test = await startApp();
  client = api(test.url);
  await setSwitches(test.db);
  admin = await client.adminWithTotp(test.db);
  seeded.push(admin.id);
  plainAdmin = await client.signInAdmin(admin.email, admin.secret);
  const reauthenticated = await client.post('/api/admin/me/reauthenticate', {
    cookie: admin.cookie,
    body: { password: PASSWORD, totpCode: totp(admin.secret) },
  });
  expect(reauthenticated.status).toBe(200);
  const qr = new FormData();
  qr.set('file', new Blob([new Uint8Array(await image())]), 'qr.png');
  const { fileId } = await json<{ fileId: string }>(
    await client.post('/api/admin/deposit-settings/qr', { cookie: admin.cookie, form: qr }),
    200,
  );
  await json(
    await client.put('/api/admin/deposit-settings', {
      cookie: admin.cookie,
      body: {
        ...DEPOSIT_SETTINGS_DEFAULTS,
        shamCashAccountName: 'Vertex Digital',
        shamCashAccountNumber: '0933000000',
        usdEnabled: true,
        usdQrFileId: fileId,
      },
    }),
    200,
  );
});

afterAll(async () => {
  await setSwitches(test.db);
  await removeAccounts(test.db, seeded);
  await test.app.close();
});

describe('access (S12 "Access")', () => {
  it('keeps customer routes to customers and admin routes to the admin', async () => {
    const someone = await customer();
    const id = randomUUID();
    const customerRoutes: [string, string][] = [
      ['GET', '/api/support/tickets'],
      ['POST', '/api/support/tickets'],
      ['GET', `/api/support/tickets/${id}`],
      ['POST', `/api/support/tickets/${id}/messages`],
      ['POST', `/api/support/tickets/${id}/close`],
      ['GET', `/api/support/tickets/${id}/attachments/${id}`],
    ];
    const adminRoutes: [string, string][] = [
      ['GET', '/api/admin/support/tickets'],
      ['POST', '/api/admin/support/tickets'],
      ['GET', `/api/admin/support/tickets/${id}`],
      ['POST', `/api/admin/support/tickets/${id}/messages`],
      ['POST', `/api/admin/support/tickets/${id}/close`],
      ['GET', `/api/admin/support/tickets/${id}/attachments/${id}`],
      ['GET', '/api/admin/support/settings'],
      ['PUT', '/api/admin/support/settings'],
    ];
    for (const [method, path] of customerRoutes) {
      expect((await client.request(method, path)).status, path).toBe(401);
      expect((await client.request(method, path, { cookie: admin.cookie })).status, path).toBe(401);
    }
    for (const [method, path] of adminRoutes) {
      expect((await client.request(method, path)).status, path).toBe(401);
      expect((await client.request(method, path, { cookie: someone.cookie })).status, path).toBe(
        401,
      );
    }
    const channels = await client.get('/api/support/channels');
    expect(channels.status).toBe(200);
    expect(channels.headers.get('cache-control')).toBe('public, max-age=60');
  });
});

describe('customer tickets (TK1, TK3, TK4, TK7, TK8, TK11)', () => {
  it('opens a ticket with images, tells the admin without the body, replays the key', async () => {
    const owner = await customer();
    const key = randomUUID();
    const response = await openTicket(owner, { body: 'نص سري' }, { images: 2, key });
    expect(response.headers.get('cache-control')).toBe('no-store');
    const ticket = await json<TicketView>(response, 201);
    expect(ticket).toMatchObject({ status: 'open', canReply: true, lastAuthor: 'customer' });
    expect(ticket.number).toMatch(/^VT-[2-9A-HJKMNP-Z]{6}$/);
    const [first] = ticket.messages;
    expect(first?.attachments).toHaveLength(2);

    const replay = await json<TicketView>(
      await openTicket(owner, { body: 'نص سري' }, { key }),
      200,
    );
    expect(replay.id).toBe(ticket.id);
    expect(
      (await json<{ code: string }>(await openTicket(owner, { body: 'آخر' }, { key }), 409)).code,
    ).toBe('IDEMPOTENCY_KEY_REUSED');

    const notices = await telegramOf(ticket.id);
    expect(notices).toEqual([
      {
        kind: 'ticket_opened',
        params: expect.objectContaining({ number: ticket.number, hasImages: true }),
      },
    ]);
    expect(JSON.stringify(notices)).not.toContain('نص سري');
    expect((await auditOf(test.db, ticket.id)).map((entry) => entry.action)).toEqual([
      'ticket.opened',
    ]);

    const fileId = first?.attachments[0] as string;
    const served = await client.get(`/api/support/tickets/${ticket.id}/attachments/${fileId}`, {
      cookie: owner.cookie,
    });
    expect(served.status).toBe(200);
    expect(served.headers.get('cache-control')).toBe('no-store');
    expect(served.headers.get('x-content-type-options')).toBe('nosniff');
    const adminServed = await client.get(
      `/api/admin/support/tickets/${ticket.id}/attachments/${fileId}`,
      { cookie: admin.cookie },
    );
    expect(adminServed.status).toBe(200);

    const stranger = await customer();
    for (const path of [
      `/api/support/tickets/${ticket.id}`,
      `/api/support/tickets/${ticket.id}/attachments/${fileId}`,
    ]) {
      expect((await client.get(path, { cookie: stranger.cookie })).status, path).toBe(404);
    }
    expect((await reply(stranger, ticket.id)).status).toBe(404);
    expect(
      (await client.post(`/api/support/tickets/${ticket.id}/close`, { cookie: stranger.cookie }))
        .status,
    ).toBe(404);
  });

  it('checks the link: its type, its owner, one open ticket per deposit (TK1)', async () => {
    const owner = await customer();
    const deposit = await shamCash(owner);
    const other = await customer();
    const otherDeposit = await shamCash(other);
    for (const fields of [
      { category: 'account', depositId: deposit.id } as Record<string, string>,
      { category: 'deposit' },
      { category: 'deposit', depositId: otherDeposit.id },
    ]) {
      expect((await json<{ code: string }>(await openTicket(owner, fields), 400)).code).toBe(
        'TICKET_LINK_INVALID',
      );
    }
    const first = await json<TicketView>(
      await openTicket(owner, { category: 'deposit', depositId: deposit.id }),
      201,
    );
    const again = await json<{ code: string; details: { ticketId: string } }>(
      await openTicket(owner, { category: 'deposit', depositId: deposit.id }),
      409,
    );
    expect(again).toMatchObject({ code: 'TICKET_ALREADY_OPEN', details: { ticketId: first.id } });
  });

  it('allows 3 open tickets and 20 messages an hour (TK1, TK7)', async () => {
    const owner = await customer();
    const opened = [];
    for (let index = 0; index < 3; index += 1) {
      opened.push(await json<TicketView>(await openTicket(owner), 201));
    }
    const refused = await json<{ code: string; details: { limit: string } }>(
      await openTicket(owner),
      409,
    );
    expect(refused).toMatchObject({ code: 'TICKETS_LIMIT_REACHED', details: { limit: 'open' } });
    const target = opened[0] as TicketView;
    await test.db.insert(supportMessages).values(
      Array.from({ length: 17 }, () => ({
        ticketId: target.id,
        author: 'customer' as const,
        body: 'رسالة',
        idempotencyKey: randomUUID(),
      })),
    );
    expect((await json<{ code: string }>(await reply(owner, target.id), 429)).code).toBe(
      'RATE_LIMITED',
    );
  });

  it('closes, reopens within 7 days, and refuses past 7 days (TK3, TK4)', async () => {
    const owner = await customer();
    const ticket = await json<TicketView>(await openTicket(owner), 201);
    const close = () =>
      client.post(`/api/support/tickets/${ticket.id}/close`, { cookie: owner.cookie });
    expect((await json<TicketView>(await close(), 200)).status).toBe('closed');
    expect((await json<TicketView>(await close(), 200)).status).toBe('closed');
    expect((await json<TicketView>(await reply(owner, ticket.id), 201)).status).toBe('open');
    expect((await auditOf(test.db, ticket.id)).map((entry) => entry.action)).toEqual(
      expect.arrayContaining(['ticket.closed', 'ticket.customer_replied', 'ticket.reopened']),
    );
    await json(await close(), 200);
    await test.db
      .update(supportTickets)
      .set({ closedAt: sql`now() - interval '8 days'` })
      .where(eq(supportTickets.id, ticket.id));
    const old = await json<TicketView>(
      await client.get(`/api/support/tickets/${ticket.id}`, { cookie: owner.cookie }),
      200,
    );
    expect(old.canReply).toBe(false);
    expect((await json<{ code: string }>(await reply(owner, ticket.id), 409)).code).toBe(
      'TICKET_CLOSED',
    );
  });

  it('groups the customer replies on Telegram per 10 minutes (TK8)', async () => {
    const owner = await customer();
    const ticket = await json<TicketView>(await openTicket(owner), 201);
    await json(await reply(owner, ticket.id, 'أولى'), 201);
    await json(await reply(owner, ticket.id, 'ثانية'), 201);
    const kinds = (await telegramOf(ticket.id)).map((notice) => notice.kind).sort();
    expect(kinds).toEqual(['ticket_opened', 'ticket_reply']);
  });
});

describe('the admin side (TK2, TK5, TK9, TK12, TK13)', () => {
  it('answers with an image: the customer is told, and emailed once per 10 minutes', async () => {
    const owner = await customer();
    const ticket = await json<TicketView>(await openTicket(owner), 201);
    const queue = await json<{ items: { id: string }[]; openCount: number }>(
      await client.get('/api/admin/support/tickets', { cookie: admin.cookie }),
      200,
    );
    expect(queue.openCount).toBeGreaterThanOrEqual(1);
    const byNumber = await json<{ items: { id: string }[] }>(
      await client.get(`/api/admin/support/tickets?status=all&q=${ticket.number.toLowerCase()}`, {
        cookie: admin.cookie,
      }),
      200,
    );
    expect(byNumber.items.map((item) => item.id)).toEqual([ticket.id]);
    const answered = await json<{ status: string; customer: { marks: { status: string } } }>(
      await adminReply(ticket.id, 'تم التحقق', 1),
      201,
    );
    expect(answered).toMatchObject({
      status: 'answered',
      customer: { marks: { status: 'active' } },
    });
    await json(await adminReply(ticket.id, 'متابعة'), 201);
    const notices = (await notificationsOf(test.db, owner.id)).filter(
      (notice) => notice.event === 'ticket_replied',
    );
    expect(notices).toHaveLength(2);
    const emails = (await emailsTo(test.db, owner.email)).filter(
      (email) => email.template === 'customer_ticket_replied',
    );
    expect(emails).toHaveLength(1);
    expect(JSON.stringify(emails[0]?.params)).not.toContain('تم التحقق');
    const dashboard = await json<{ attention: { kind: string }[] }>(
      await client.get('/api/admin/dashboard', { cookie: admin.cookie }),
      200,
    );
    // TK13: the other tests' tickets still wait.
    expect(dashboard.attention.map((item) => item.kind)).toContain('tickets_waiting');
  });

  it('opens a ticket to a customer about a deposit, never to an archived one (TK2, TK10)', async () => {
    const owner = await customer();
    const deposit = await shamCash(owner);
    const open = async (customerId: string, fields: Record<string, string> = {}) =>
      client.post('/api/admin/support/tickets', {
        cookie: admin.cookie,
        form: await multipart({
          customerId,
          category: 'deposit',
          depositId: deposit.id,
          subject: 'بخصوص إيداعك',
          body: 'نحتاج إيصالاً أوضح',
          ...fields,
        }),
        headers: { 'idempotency-key': randomUUID() },
      });
    const ticket = await json<{ id: string; status: string; openedBy: string }>(
      await open(owner.id),
      201,
    );
    expect(ticket).toMatchObject({ status: 'answered', openedBy: 'admin' });
    const mine = await json<{ items: { id: string; lastAuthor: string }[] }>(
      await client.get('/api/support/tickets', { cookie: owner.cookie }),
      200,
    );
    expect(mine.items).toEqual([expect.objectContaining({ id: ticket.id, lastAuthor: 'admin' })]);
    expect(
      (await notificationsOf(test.db, owner.id)).some(
        (notice) => notice.event === 'ticket_replied',
      ),
    ).toBe(true);

    const archived = await seedCustomer(test.db, { archived: true, phone: uniquePhone() });
    seeded.push(archived.id);
    expect(
      (
        await json<{ code: string }>(
          await open(archived.id, { category: 'account', depositId: '' }),
          409,
        )
      ).code,
    ).toBe('CUSTOMER_STATE_INVALID');
  });

  it("puts a priority tier's open tickets first, with the tier, over the cursor (S23 OP2)", async () => {
    const plain = await customer();
    const shop = await customer();
    await test.db
      .update(customers)
      .set({ accountType: 'merchant' })
      .where(eq(customers.id, shop.id));
    const termsVersionId = newId();
    await test.db.execute(sql`insert into content_page_versions
      (id, page, version, title, body, draft_revision, admin_id)
      values (${termsVersionId}, 'merchant_terms', 1000 + floor(random() * 1e9)::int,
        'شروط التاجر', 'النص', 1, ${newId()})`);
    await test.db.insert(merchantProfiles).values({
      customerId: shop.id,
      tradeName: 'محل النور',
      governorate: 'aleppo',
      city: 'اعزاز',
      grantedAt: new Date(),
      termsVersionId,
    });
    // Bronze takes the ticket priority for this test (TS1: a new settings row is in force).
    const [bronze] = await test.db
      .select()
      .from(merchantTierSettings)
      .where(eq(merchantTierSettings.tier, 'bronze'))
      .orderBy(desc(merchantTierSettings.createdAt), desc(merchantTierSettings.id))
      .limit(1);
    if (!bronze) throw new Error('No Bronze settings');
    const { id: _id, createdAt: _at, ...values } = bronze;
    await test.db
      .insert(merchantTierSettings)
      .values({ ...values, id: newId(), supportPriority: true });
    try {
      const older = await json<TicketView>(await openTicket(plain), 201);
      const priority = await json<TicketView>(await openTicket(shop), 201);
      const page = async (cursor: string | null) =>
        json<{
          items: { id: string; customer: { tier: string | null } }[];
          nextCursor: string | null;
        }>(
          await client.get(
            `/api/admin/support/tickets?status=open&limit=1${cursor ? `&cursor=${cursor}` : ''}`,
            { cookie: admin.cookie },
          ),
          200,
        );
      const all: { id: string; customer: { tier: string | null } }[] = [];
      let cursor: string | null = null;
      do {
        const result = await page(cursor);
        all.push(...result.items);
        cursor = result.nextCursor;
      } while (cursor);
      const ids = all.map((item) => item.id);
      expect(new Set(ids).size).toBe(ids.length);
      expect(ids[0]).toBe(priority.id);
      expect(ids).toContain(older.id);
      expect(all[0]?.customer.tier).toBe('bronze');
      expect(all.find((item) => item.id === older.id)?.customer.tier).toBeNull();
      const detail = await json<{ customer: { tier: string | null } }>(
        await client.get(`/api/admin/support/tickets/${priority.id}`, { cookie: admin.cookie }),
        200,
      );
      expect(detail.customer.tier).toBe('bronze');
    } finally {
      await test.db.insert(merchantTierSettings).values({ ...values, id: newId() });
    }
  });

  it('reopens a closed ticket to answered when the admin replies (TK5)', async () => {
    const owner = await customer();
    const ticket = await json<TicketView>(await openTicket(owner), 201);
    await json(
      await client.post(`/api/admin/support/tickets/${ticket.id}/close`, { cookie: admin.cookie }),
      200,
    );
    expect((await json<{ status: string }>(await adminReply(ticket.id), 201)).status).toBe(
      'answered',
    );
    const [row] = await test.db
      .select({ closedAt: supportTickets.closedAt })
      .from(supportTickets)
      .where(and(eq(supportTickets.id, ticket.id)));
    expect(row?.closedAt).toBeNull();
  });

  it('stores no image for a request the limits or the ticket refuse (A07-1)', async () => {
    const owner = await customer();
    const prepare = vi.spyOn(test.app.get(FilesService), 'prepare');
    for (let index = 0; index < 3; index += 1) await json(await openTicket(owner), 201);
    expect(
      (await json<{ code: string }>(await openTicket(owner, {}, { images: 1 }), 409)).code,
    ).toBe('TICKETS_LIMIT_REACHED');
    const [first] = await test.db
      .select({ id: supportTickets.id })
      .from(supportTickets)
      .where(eq(supportTickets.customerId, owner.id));
    await test.db
      .update(supportTickets)
      .set({ status: 'closed', closedAt: sql`now() - interval '8 days'`, closedBy: 'customer' })
      .where(eq(supportTickets.id, first?.id ?? ''));
    const late = await client.post(`/api/support/tickets/${first?.id}/messages`, {
      cookie: owner.cookie,
      form: await multipart({ body: 'صورة' }, 1),
      headers: { 'idempotency-key': randomUUID() },
    });
    expect((await json<{ code: string }>(late, 409)).code).toBe('TICKET_CLOSED');
    expect(prepare).not.toHaveBeenCalled();
  });

  it('answers a malformed ticket id with 404, not a server fault (A07-4)', async () => {
    const owner = await customer();
    for (const path of [
      '/api/support/tickets/not-a-ticket/close',
      '/api/support/tickets/not-a-ticket/messages',
    ]) {
      const response = await client.post(path, {
        cookie: owner.cookie,
        form: await multipart({ body: 'مرحباً' }),
        headers: { 'idempotency-key': randomUUID() },
      });
      expect((await json<{ code: string }>(response, 404)).code).toBe('NOT_FOUND');
    }
  });

  it('refuses a reply on an archived customer’s ticket and tells no one (A07-20, Q28)', async () => {
    const owner = await customer();
    const ticket = await json<TicketView>(await openTicket(owner), 201);
    await json(
      await client.post(`/api/admin/support/tickets/${ticket.id}/close`, { cookie: admin.cookie }),
      200,
    );
    await test.db
      .update(customers)
      .set({ archivedAt: new Date() })
      .where(eq(customers.id, owner.id));
    const refused = await json<{ code: string; details: { status: string } }>(
      await adminReply(ticket.id, 'ردّ متأخر', 1),
      409,
    );
    expect(refused).toMatchObject({
      code: 'CUSTOMER_STATE_INVALID',
      details: { status: 'archived' },
    });
    const [row] = await test.db
      .select({ status: supportTickets.status })
      .from(supportTickets)
      .where(eq(supportTickets.id, ticket.id));
    expect(row?.status).toBe('closed');
    expect(
      (await notificationsOf(test.db, owner.id)).some(
        (notice) => notice.event === 'ticket_replied',
      ),
    ).toBe(false);
  });

  it('replays an opening’s key only for the same type, link, subject and customer (A07-23)', async () => {
    const owner = await customer();
    const key = randomUUID();
    const first = await json<TicketView>(await openTicket(owner, {}, { key }), 201);
    expect((await json<TicketView>(await openTicket(owner, {}, { key }), 200)).id).toBe(first.id);
    for (const fields of [{ subject: 'موضوع آخر' }, { category: 'other' }] as Record<
      string,
      string
    >[]) {
      expect(
        (await json<{ code: string }>(await openTicket(owner, fields, { key }), 409)).code,
      ).toBe('IDEMPOTENCY_KEY_REUSED');
    }
    const other = await customer();
    const adminKey = randomUUID();
    const openFor = async (customerId: string) =>
      client.post('/api/admin/support/tickets', {
        cookie: admin.cookie,
        form: await multipart({
          customerId,
          category: 'account',
          subject: 'بخصوص حسابك',
          body: 'نحتاج تأكيداً',
        }),
        headers: { 'idempotency-key': adminKey },
      });
    await json(await openFor(owner.id), 201);
    expect((await json<{ code: string }>(await openFor(other.id), 409)).code).toBe(
      'IDEMPOTENCY_KEY_REUSED',
    );
  });

  it('refuses the sixth ticket of a day and a reopen past 3 open tickets (TK1, TK4; A07-16)', async () => {
    const owner = await customer();
    const close = (id: string) =>
      client.post(`/api/support/tickets/${id}/close`, { cookie: owner.cookie });
    const closed: string[] = [];
    for (let index = 0; index < 2; index += 1) {
      const ticket = await json<TicketView>(await openTicket(owner), 201);
      await json(await close(ticket.id), 200);
      closed.push(ticket.id);
    }
    for (let index = 0; index < 3; index += 1) await json(await openTicket(owner), 201);
    const reopen = await json<{ code: string; details: { limit: string } }>(
      await reply(owner, closed[0] as string),
      409,
    );
    expect(reopen).toMatchObject({ code: 'TICKETS_LIMIT_REACHED', details: { limit: 'open' } });
    await test.db
      .update(supportTickets)
      .set({ status: 'closed', closedAt: sql`now()`, closedBy: 'customer' })
      .where(and(eq(supportTickets.customerId, owner.id), eq(supportTickets.status, 'open')));
    const daily = await json<{ code: string; details: { limit: string } }>(
      await openTicket(owner),
      409,
    );
    expect(daily).toMatchObject({ code: 'TICKETS_LIMIT_REACHED', details: { limit: 'daily' } });
  });

  it('refuses a file that is not an image (TK11; A07-16)', async () => {
    const owner = await customer();
    const form = await multipart({ category: 'account', subject: 'ملف', body: 'مرفق' });
    form.append('files', new Blob([new TextEncoder().encode('not an image')]), 'note.png');
    const response = await client.post('/api/support/tickets', {
      cookie: owner.cookie,
      form,
      headers: { 'idempotency-key': randomUUID(), ...(await client.altcha()) },
    });
    expect((await json<{ code: string }>(response, 400)).code).toBe('IMAGE_INVALID');
  });
});

describe('support settings (SC1, SC2)', () => {
  it('saves a t.me link with a re-authentication and shows it on the store', async () => {
    const put = (telegramUrl: string | null, cookie = admin.cookie) =>
      client.put('/api/admin/support/settings', { cookie, body: { telegramUrl } });
    expect((await json<{ code: string }>(await put(null, plainAdmin), 403)).code).toBe(
      'REAUTHENTICATION_REQUIRED',
    );
    expect((await json<{ code: string }>(await put('https://evil.me/abcde'), 400)).code).toBe(
      'VALIDATION_FAILED',
    );
    await json(await put('https://t.me/vertex_support'), 200);
    expect(await json(await client.get('/api/support/channels'), 200)).toEqual({
      telegramUrl: 'https://t.me/vertex_support',
    });
    await json(await put(null), 200);
    expect(await json(await client.get('/api/support/channels'), 200)).toEqual({
      telegramUrl: null,
    });
  });
});
