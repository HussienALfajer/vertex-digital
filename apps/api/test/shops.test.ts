import { randomBytes } from 'node:crypto';
import {
  customerSessions,
  customers,
  ensureCustomerWallet,
  ensureSystemAccount,
  merchantProfiles,
  merchantShops,
  newId,
  postJournal,
  shopCustomers,
  shopTransfers,
} from '@vertex-digital/db';
import { eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  api,
  auditOf,
  cookieHeader,
  emailsTo,
  lastCode,
  PASSWORD,
  removeAccounts,
  seedCustomer,
  totp,
  uniqueEmail,
} from './helpers.js';
import { startApp, type TestApp } from './start-app.js';

/*
 * Merchant shops (S26 PR 1) over HTTP: the request and its review (SH1–SH8), settings (ST1–ST6),
 * the shop customer realm (CA1–CA9, ADR 0040: one email in two shops and in Vertex, sessions kept
 * to their shop), transfers (WL1–WL4) with their check, caps, replays and races, returns (WL5,
 * WL6) and the settlement of a closed shop (WL9).
 */

let test: TestApp;
let client: ReturnType<typeof api>;
let admin: Awaited<ReturnType<ReturnType<typeof api>['adminWithTotp']>>;
const seeded: string[] = [];
const usd = (dollars: number) => Math.round(dollars * 1_000_000);
const slugOf = () => `t${randomBytes(5).toString('hex')}`;
const key = () => ({ 'idempotency-key': newId() });

async function json<T = Record<string, unknown>>(response: Response, status: number): Promise<T> {
  const text = await response.text();
  expect(response.status, text).toBe(status);
  return (text ? JSON.parse(text) : {}) as T;
}

async function fund(customerId: string, amountUnits: number) {
  await test.db.transaction(async (tx) => {
    await postJournal(tx, {
      idempotencyKey: `test:${newId()}`,
      kind: 'adjustment',
      postings: [
        { accountId: await ensureCustomerWallet(tx, customerId), amountUnits },
        {
          accountId: await ensureSystemAccount(tx, {
            code: 'adjustments:test_funds',
            kind: 'adjustments',
            currency: 'USD',
          }),
          amountUnits: -amountUnits,
        },
      ],
    });
  });
}

/** A merchant who accepted the terms, with a wallet (a funded customer is never deleted). */
async function merchant(funds = usd(100)) {
  const person = await seedCustomer(test.db);
  seeded.push(person.id);
  await test.db
    .update(customers)
    .set({ accountType: 'merchant' })
    .where(eq(customers.id, person.id));
  const termsVersionId = newId();
  await test.db.execute(sql`insert into content_page_versions
    (id, page, version, title, body, draft_revision, admin_id)
    values (${termsVersionId}, 'merchant_terms', 1000 + floor(random() * 1e9)::int, 'شروط التاجر',
      'النص', 1, ${newId()})`);
  await test.db.insert(merchantProfiles).values({
    customerId: person.id,
    tradeName: 'محل النور',
    governorate: 'aleppo',
    city: 'اعزاز',
    grantedAt: new Date(Date.now() - 60_000),
    termsVersionId,
  });
  await fund(person.id, Math.max(funds, 1));
  return { ...person, cookie: await client.signInCustomer(person.email) };
}

const send = (method: string, path: string, cookie: string, payload?: unknown, headers = {}) =>
  client.request(method, path, { cookie, body: payload, headers });

/** A merchant with an approved shop (limits as given). */
async function shopFor(limits = {}) {
  const owner = await merchant();
  const slug = slugOf();
  const shop = await json<{ id: string }>(
    await send(
      'POST',
      '/api/merchant/shop',
      owner.cookie,
      {
        slug,
        brandColor: '#1f7a6c',
        rateMode: 'store',
      },
      key(),
    ),
    201,
  );
  await json(
    await send('POST', `/api/admin/shops/${shop.id}/approve`, admin.cookie, {
      limits: {
        customerBalanceCapUsdUnits: usd(200),
        dailyTransferCapUsdUnits: usd(1_000),
        customerLimit: 2_000,
        ...limits,
      },
    }),
    200,
  );
  return { owner, slug, shopId: shop.id };
}

/** A customer the merchant created, who set a password from the invitation; signed in. */
async function invited(
  context: { owner: { cookie: string }; slug: string },
  email = uniqueEmail('shop'),
) {
  const row = await json<{ id: string }>(
    await send(
      'POST',
      '/api/merchant/shop/customers',
      context.owner.cookie,
      {
        name: 'سامي علي',
        email,
        phone: '0944123456',
      },
      key(),
    ),
    201,
  );
  const [invitation] = (await emailsTo(test.db, email)).filter(
    (mail) => mail.template === 'shop_customer_invitation',
  );
  const token = (invitation?.params as { token?: string } | undefined)?.token ?? '';
  const accepted = await client.post(`/api/shops/${context.slug}/auth/invitation`, {
    body: { token, password: PASSWORD },
  });
  expect(accepted.status, await accepted.clone().text()).toBe(200);
  return { id: row.id, email, cookie: cookieHeader(accepted) };
}

beforeAll(async () => {
  test = await startApp();
  client = api(test.url);
  admin = await client.adminWithTotp(test.db);
  seeded.push(admin.id);
  const reauthenticated = await client.post('/api/admin/me/reauthenticate', {
    cookie: admin.cookie,
    body: { password: PASSWORD, totpCode: totp(admin.secret) },
  });
  expect(reauthenticated.status).toBe(200);
});

afterAll(async () => {
  await removeAccounts(test.db, seeded);
  await test.app.close();
});

describe('the request and its review (SH1–SH8, ST1, ST3)', () => {
  it('lets a merchant request a shop, replays it, and the admin approves it with limits', async () => {
    const owner = await merchant();
    const slug = slugOf();
    const input = { slug, brandColor: '#2266B3', rateMode: 'store' };
    expect(await json(await send('GET', '/api/merchant/shop', owner.cookie), 200)).toEqual({
      shop: null,
    });
    expect(
      await json(
        await send('GET', `/api/merchant/shop/slug-available?slug=${slug}`, owner.cookie),
        200,
      ),
    ).toEqual({ available: true });
    const shop = await json<{
      id: string;
      status: string;
      brandColor: string;
      displayName: string;
    }>(await send('POST', '/api/merchant/shop', owner.cookie, input, key()), 201);
    expect(shop).toMatchObject({
      status: 'requested',
      brandColor: '#2266b3',
      displayName: 'محل النور',
    });
    expect(
      await json(await send('POST', '/api/merchant/shop', owner.cookie, input, key()), 200),
    ).toMatchObject({
      id: shop.id,
    });
    const other = await merchant();
    expect(
      await json(
        await send('GET', `/api/merchant/shop/slug-available?slug=${slug}`, other.cookie),
        200,
      ),
    ).toEqual({ available: false });
    expect(
      await json(await send('POST', '/api/merchant/shop', other.cookie, { ...input }, key()), 409),
    ).toMatchObject({ code: 'SLUG_TAKEN' });

    expect(
      (await send('POST', `/api/admin/shops/${shop.id}/approve`, owner.cookie, {})).status,
    ).toBe(401);
    const approved = await json<{ status: string; limits: unknown }>(
      await send('POST', `/api/admin/shops/${shop.id}/approve`, admin.cookie, {
        limits: {
          customerBalanceCapUsdUnits: usd(300),
          dailyTransferCapUsdUnits: usd(2_000),
          customerLimit: 50,
        },
      }),
      200,
    );
    expect(approved).toMatchObject({
      status: 'active',
      limits: { customerBalanceCapUsdUnits: usd(300), customerLimit: 50 },
    });
    expect((await auditOf(test.db, shop.id)).map((entry) => entry.action)).toEqual([
      'shop.requested',
      'shop.approved',
    ]);
    expect(
      await json(
        await send('POST', `/api/admin/shops/${shop.id}/approve`, admin.cookie, {
          limits: {
            customerBalanceCapUsdUnits: usd(1),
            dailyTransferCapUsdUnits: usd(10),
            customerLimit: 1,
          },
        }),
        409,
      ),
    ).toMatchObject({ code: 'SHOP_STATE_INVALID' });
    // SH2: the approved slug stays the merchant's, even for another merchant's later request.
    expect(
      await json(await send('POST', '/api/merchant/shop', other.cookie, { ...input }, key()), 409),
    ).toMatchObject({ code: 'SLUG_TAKEN' });
  });

  it('refuses reserved slugs, low-contrast colors, a far rate without its confirmation and customers', async () => {
    const owner = await merchant();
    const base = { slug: slugOf(), brandColor: '#1f7a6c', rateMode: 'store' };
    expect(
      await json(
        await send('POST', '/api/merchant/shop', owner.cookie, { ...base, slug: 'admin' }, key()),
        400,
      ),
    ).toMatchObject({ code: 'VALIDATION_FAILED' });
    expect(
      await json(
        await send(
          'POST',
          '/api/merchant/shop',
          owner.cookie,
          { ...base, brandColor: '#ffd700' },
          key(),
        ),
        400,
      ),
    ).toMatchObject({ code: 'VALIDATION_FAILED' });
    const [rate] = (
      await test.db.execute<{ rate: string }>(
        sql`select syp_per_usd::text as rate from exchange_rates order by created_at desc, id desc limit 1`,
      )
    ).rows;
    if (rate) {
      const far = String(Math.round(Number(rate.rate) * 1.5));
      expect(
        await json(
          await send(
            'POST',
            '/api/merchant/shop',
            owner.cookie,
            { ...base, rateMode: 'own', rate: far },
            key(),
          ),
          409,
        ),
      ).toMatchObject({ code: 'SHOP_RATE_CONFIRMATION_REQUIRED' });
      await json(
        await send(
          'POST',
          '/api/merchant/shop',
          owner.cookie,
          { ...base, rateMode: 'own', rate: far, confirmFar: true },
          key(),
        ),
        201,
      );
    }
    const plain = await seedCustomer(test.db);
    seeded.push(plain.id);
    const cookie = await client.signInCustomer(plain.email);
    expect(await json(await send('GET', '/api/merchant/shop', cookie), 403)).toMatchObject({
      code: 'NOT_MERCHANT',
    });
    expect((await client.get('/api/merchant/shop')).status).toBe(401);
  });

  it('rejects with a reason, holds a new request 7 days, suspends, resumes and closes re-authenticated', async () => {
    const owner = await merchant();
    const shop = await json<{ id: string }>(
      await send(
        'POST',
        '/api/merchant/shop',
        owner.cookie,
        { slug: slugOf(), brandColor: '#7a4cb8', rateMode: 'store' },
        key(),
      ),
      201,
    );
    const rejected = await json<{ status: string; rejectReason: string; requestAgainAt: string }>(
      await send('POST', `/api/admin/shops/${shop.id}/reject`, admin.cookie, {
        reason: 'الاسم غير واضح',
      }),
      200,
    );
    expect(rejected).toMatchObject({ status: 'rejected', rejectReason: 'الاسم غير واضح' });
    expect(
      await json(
        await send(
          'POST',
          '/api/merchant/shop',
          owner.cookie,
          { slug: slugOf(), brandColor: '#7a4cb8', rateMode: 'store' },
          key(),
        ),
        409,
      ),
    ).toMatchObject({
      code: 'SHOP_STATE_INVALID',
      details: { requestAgainAt: rejected.requestAgainAt },
    });

    const { shopId } = await shopFor();
    const suspended = await json<{ status: string; suspendReason: string }>(
      await send('POST', `/api/admin/shops/${shopId}/suspend`, admin.cookie, {
        reason: 'review',
        note: 'مراجعة الشكاوى',
      }),
      200,
    );
    expect(suspended).toMatchObject({ status: 'suspended', suspendReason: 'review' });
    await json(await send('POST', `/api/admin/shops/${shopId}/resume`, admin.cookie), 200);
    const closed = await json<{ status: string; settled: boolean }>(
      await send('POST', `/api/admin/shops/${shopId}/close`, admin.cookie, {
        reason: 'طلب التاجر',
      }),
      200,
    );
    expect(closed).toMatchObject({ status: 'closed', settled: true });
    const list = await json<{ items: { id: string }[] }>(
      await send('GET', '/api/admin/shops?status=closed', admin.cookie),
      200,
    );
    expect(list.items.map((item) => item.id)).toContain(shopId);
  });
});

describe('the shop customer realm (CA1–CA9, ADR 0040)', () => {
  it('signs up from the link with a code, and keeps one email apart in two shops and in Vertex', async () => {
    const first = await shopFor();
    const second = await shopFor();
    const vertex = await seedCustomer(test.db);
    seeded.push(vertex.id);
    const email = vertex.email;
    const signUp = (slug: string, password: string) =>
      client.post(`/api/shops/${slug}/auth/sign-up`, {
        body: { name: 'سامي علي', email, password, phone: '0944123456', acceptTerms: true },
        headers: {},
      });
    expect(await json(await signUp(first.slug, 'first-shop-passphrase'), 400)).toMatchObject({
      code: 'ALTCHA_REQUIRED',
    });
    const headers = await client.altcha();
    const signed = await client.post(`/api/shops/${first.slug}/auth/sign-up`, {
      body: {
        name: 'سامي علي',
        email,
        password: 'first-shop-passphrase',
        phone: '0944123456',
        acceptTerms: true,
      },
      headers,
    });
    expect(signed.status, await signed.clone().text()).toBe(200);
    const code = await lastCode(test.db, email);
    const verified = await client.post(`/api/shops/${first.slug}/auth/email-otp/verify-email`, {
      body: { email, otp: code, password: 'first-shop-passphrase' },
    });
    expect(verified.status, await verified.clone().text()).toBe(200);
    const firstCookie = cookieHeader(verified);
    expect(
      await json(await client.get(`/api/shops/${first.slug}/me`, { cookie: firstCookie }), 200),
    ).toMatchObject({ email, frozen: false });

    // The same email, invited to the second shop with its own password.
    const second2 = await invited(second, email);
    const signIn = (slug: string, password: string) =>
      client.post(`/api/shops/${slug}/auth/sign-in/email`, { body: { email, password } });
    expect((await signIn(second.slug, 'first-shop-passphrase')).status).toBe(401);
    expect((await signIn(second.slug, PASSWORD)).status).toBe(200);
    expect((await signIn(first.slug, PASSWORD)).status).toBe(401);

    // Sessions stay in their shop and realm.
    expect((await client.get(`/api/shops/${second.slug}/me`, { cookie: firstCookie })).status).toBe(
      401,
    );
    expect(
      (await client.get(`/api/shops/${first.slug}/me`, { cookie: second2.cookie })).status,
    ).toBe(401);
    const vertexCookie = await client.signInCustomer(email);
    expect((await client.get(`/api/shops/${first.slug}/me`, { cookie: vertexCookie })).status).toBe(
      401,
    );
    expect((await client.get('/api/account', { cookie: firstCookie })).status).toBe(401);
    expect((await client.get(`/api/shops/${first.slug}/me`, { cookie: admin.cookie })).status).toBe(
      401,
    );
    expect((await client.get('/api/shops/no-such-shop/me', { cookie: firstCookie })).status).toBe(
      404,
    );
  });

  it('refuses the same email twice in a shop to the merchant, a shop at its limit, and invites 3 a day', async () => {
    const context = await shopFor({ customerLimit: 1 });
    const email = uniqueEmail('shop');
    await invited(context, email);
    expect(
      await json(
        await send(
          'POST',
          '/api/merchant/shop/customers',
          context.owner.cookie,
          { name: 'سامي علي', email, phone: '0944123456' },
          key(),
        ),
        409,
      ),
    ).toMatchObject({ code: 'EMAIL_TAKEN' });
    expect(
      await json(
        await send(
          'POST',
          '/api/merchant/shop/customers',
          context.owner.cookie,
          {
            name: 'هبة',
            email: uniqueEmail('shop'),
            phone: '0944123456',
          },
          key(),
        ),
        403,
      ),
    ).toMatchObject({ code: 'SHOP_CUSTOMER_LIMIT_REACHED' });

    const roomy = await shopFor();
    const row = await json<{ id: string; state: string }>(
      await send(
        'POST',
        '/api/merchant/shop/customers',
        roomy.owner.cookie,
        {
          name: 'هبة',
          email: uniqueEmail('shop'),
          phone: '0944123456',
        },
        key(),
      ),
      201,
    );
    expect(row.state).toBe('invited');
    for (let i = 0; i < 3; i += 1) {
      expect(
        (await send('POST', `/api/merchant/shop/customers/${row.id}/invite`, roomy.owner.cookie))
          .status,
      ).toBe(204);
    }
    expect(
      await json(
        await send('POST', `/api/merchant/shop/customers/${row.id}/invite`, roomy.owner.cookie),
        429,
      ),
    ).toMatchObject({ code: 'RATE_LIMITED' });
    const stranger = await merchant();
    expect(
      (
        await send('PATCH', `/api/merchant/shop/customers/${row.id}`, stranger.cookie, {
          name: 'غيره',
        })
      ).status,
    ).toBe(404);
  });
});

describe('transfers (WL1–WL4)', () => {
  it('moves money after a recent check, replays its key, and refuses by the caps', async () => {
    const context = await shopFor({ customerBalanceCapUsdUnits: usd(30) });
    const customer = await invited(context);
    const path = `/api/merchant/shop/customers/${customer.id}/transfers`;
    // An old session needs the password check (WL4).
    await test.db
      .update(customerSessions)
      .set({ createdAt: new Date(Date.now() - 3600_000) })
      .where(eq(customerSessions.userId, context.owner.id));
    const payload = { currency: 'usd', amountUnits: usd(20), expectedUsdUnits: usd(20) };
    expect(
      await json(await send('POST', path, context.owner.cookie, payload, key()), 403),
    ).toMatchObject({
      code: 'REAUTHENTICATION_REQUIRED',
    });
    expect(
      (
        await send('POST', '/api/merchant/shop/transfer-check', context.owner.cookie, {
          password: 'wrong',
        })
      ).status,
    ).toBe(400);
    await json(
      await send('POST', '/api/merchant/shop/transfer-check', context.owner.cookie, {
        password: PASSWORD,
      }),
      200,
    );
    const headers = key();
    const first = await json<{ id: string; customerBalanceUsdUnits: number }>(
      await send('POST', path, context.owner.cookie, payload, headers),
      201,
    );
    expect(first.customerBalanceUsdUnits).toBe(usd(20));
    expect(
      await json<{ id: string }>(
        await send('POST', path, context.owner.cookie, payload, headers),
        200,
      ),
    ).toMatchObject({ id: first.id });
    expect(
      await json(
        await send(
          'POST',
          path,
          context.owner.cookie,
          { ...payload, amountUnits: usd(15), expectedUsdUnits: usd(15) },
          key(),
        ),
        409,
      ),
    ).toMatchObject({ code: 'SHOP_BALANCE_CAP_EXCEEDED', details: { largestUsdUnits: usd(10) } });
    expect(
      await json(
        await send(
          'POST',
          path,
          context.owner.cookie,
          { ...payload, expectedUsdUnits: usd(19) },
          key(),
        ),
        409,
      ),
    ).toMatchObject({ code: 'PRICE_CHANGED' });
    expect(
      await json(
        await client.get(`/api/shops/${context.slug}/wallet`, { cookie: customer.cookie }),
        200,
      ),
    ).toMatchObject({ balanceUsdUnits: usd(20), pendingReturn: null });
    const entries = await json<{ items: { kind: string }[] }>(
      await client.get(`/api/shops/${context.slug}/wallet/entries`, { cookie: customer.cookie }),
      200,
    );
    expect(entries.items.map((item) => item.kind)).toEqual(['transfer_in']);
    const mails = (await emailsTo(test.db, context.owner.email)).map((mail) => mail.template);
    expect(mails).toContain('customer_merchant_shop_transfer');

    // Another merchant's customer is no customer of this one.
    const stranger = await merchant();
    expect((await send('POST', path, stranger.cookie, payload, key())).status).toBe(404);
  });

  it('serializes parallel transfers against the day cap', async () => {
    const context = await shopFor({ dailyTransferCapUsdUnits: usd(15) });
    const [one, two] = [await invited(context), await invited(context)];
    const transfer = (customerId: string) =>
      send(
        'POST',
        `/api/merchant/shop/customers/${customerId}/transfers`,
        context.owner.cookie,
        { currency: 'usd', amountUnits: usd(10), expectedUsdUnits: usd(10) },
        key(),
      );
    const statuses = (await Promise.all([transfer(one.id), transfer(two.id)]))
      .map((r) => r.status)
      .sort();
    expect(statuses).toEqual([201, 409]);
    const rows = await test.db
      .select()
      .from(shopTransfers)
      .where(eq(shopTransfers.shopId, context.shopId));
    expect(rows).toHaveLength(1);
  });

  it('refuses a frozen shop customer and a suspended shop', async () => {
    const context = await shopFor();
    const customer = await invited(context);
    const path = `/api/merchant/shop/customers/${customer.id}/transfers`;
    const payload = { currency: 'usd', amountUnits: usd(1), expectedUsdUnits: usd(1) };
    expect(
      (
        await send('POST', `/api/admin/shop-customers/${customer.id}/freeze`, admin.cookie, {
          reason: 'اشتباه',
        })
      ).status,
    ).toBe(204);
    expect(
      await json(await send('POST', path, context.owner.cookie, payload, key()), 403),
    ).toMatchObject({
      code: 'ACCOUNT_FROZEN',
    });
    const [frozen] = await test.db
      .select({ frozenReason: shopCustomers.frozenReason })
      .from(shopCustomers)
      .where(eq(shopCustomers.id, customer.id));
    expect(frozen?.frozenReason).toBe('اشتباه');
    await send('POST', `/api/admin/shop-customers/${customer.id}/unfreeze`, admin.cookie, {
      reason: 'تم التحقق',
    });
    await json(
      await send('POST', `/api/admin/shops/${context.shopId}/suspend`, admin.cookie, {
        reason: 'review',
        note: 'مراجعة',
      }),
      200,
    );
    expect(
      await json(await send('POST', path, context.owner.cookie, payload, key()), 403),
    ).toMatchObject({
      code: 'SHOP_UNAVAILABLE',
    });
  });
});

describe('returns and settlement (WL5, WL6, WL9)', () => {
  it('moves a return back on the customer confirm, once, and lets the merchant cancel another', async () => {
    const context = await shopFor();
    const customer = await invited(context);
    await json(
      await send(
        'POST',
        `/api/merchant/shop/customers/${customer.id}/transfers`,
        context.owner.cookie,
        {
          currency: 'usd',
          amountUnits: usd(20),
          expectedUsdUnits: usd(20),
        },
        key(),
      ),
      201,
    );
    const requests = `/api/merchant/shop/customers/${customer.id}/return-requests`;
    const request = await json<{ id: string; status: string }>(
      await send('POST', requests, context.owner.cookie, { amountUsdUnits: usd(5) }, key()),
      201,
    );
    expect(
      await json(
        await send('POST', requests, context.owner.cookie, { amountUsdUnits: usd(1) }, key()),
        409,
      ),
    ).toMatchObject({ code: 'RETURN_REQUEST_PENDING' });
    const wallet = await json<{ pendingReturn: { id: string } }>(
      await client.get(`/api/shops/${context.slug}/wallet`, { cookie: customer.cookie }),
      200,
    );
    expect(wallet.pendingReturn.id).toBe(request.id);
    const confirm = `/api/shops/${context.slug}/return-requests/${request.id}/confirm`;
    const headers = key();
    expect(
      await json(await client.post(confirm, { cookie: customer.cookie, headers }), 201),
    ).toMatchObject({ status: 'confirmed' });
    expect((await client.post(confirm, { cookie: customer.cookie, headers })).status).toBe(200);
    expect(
      await json(
        await client.get(`/api/shops/${context.slug}/wallet`, { cookie: customer.cookie }),
        200,
      ),
    ).toMatchObject({ balanceUsdUnits: usd(15) });

    const again = await json<{ id: string }>(
      await send('POST', requests, context.owner.cookie, { amountUsdUnits: usd(2) }, key()),
      201,
    );
    expect(
      await json(await send('DELETE', `${requests}/${again.id}`, context.owner.cookie), 200),
    ).toMatchObject({ status: 'cancelled' });
    const other = await invited(context);
    expect(
      (
        await client.post(`/api/shops/${context.slug}/return-requests/${again.id}/decline`, {
          cookie: other.cookie,
        })
      ).status,
    ).toBe(404);
  });

  it('settles a closed shop, re-authenticated, to the merchant', async () => {
    const context = await shopFor();
    const customer = await invited(context);
    await json(
      await send(
        'POST',
        `/api/merchant/shop/customers/${customer.id}/transfers`,
        context.owner.cookie,
        {
          currency: 'usd',
          amountUnits: usd(9),
          expectedUsdUnits: usd(9),
        },
        key(),
      ),
      201,
    );
    const settle = `/api/admin/shops/${context.shopId}/customers/${customer.id}/settle`;
    expect(
      await json(
        await send('POST', settle, admin.cookie, { to: 'merchant', reason: 'تسوية' }, key()),
        409,
      ),
    ).toMatchObject({ code: 'SHOP_STATE_INVALID' });
    await json(
      await send('POST', `/api/admin/shops/${context.shopId}/close`, admin.cookie, {
        reason: 'إغلاق',
      }),
      200,
    );
    const headers = key();
    expect(
      await json(
        await send('POST', settle, admin.cookie, { to: 'merchant', reason: 'تسوية' }, headers),
        201,
      ),
    ).toMatchObject({ amountUsdUnits: usd(9), to: 'merchant' });
    expect(
      (await send('POST', settle, admin.cookie, { to: 'merchant', reason: 'تسوية' }, headers))
        .status,
    ).toBe(200);
    const shop = await json<{ settled: boolean; totalBalanceUsdUnits: number }>(
      await send('GET', `/api/admin/shops/${context.shopId}`, admin.cookie),
      200,
    );
    expect(shop).toMatchObject({ settled: true, totalBalanceUsdUnits: 0 });
    const [row] = await test.db
      .select()
      .from(merchantShops)
      .where(eq(merchantShops.id, context.shopId));
    expect(row?.status).toBe('closed');
  });
});

describe('review fixes (CA3, CA6, SH7)', () => {
  it('refuses every sign-up alike once the shop is full, a known email or not', async () => {
    const context = await shopFor({ customerLimit: 1 });
    const known = await invited(context);
    const signUp = async (email: string) =>
      client.post(`/api/shops/${context.slug}/auth/sign-up`, {
        body: {
          name: 'سامي علي',
          email,
          password: 'a-long-passphrase',
          phone: '0944123456',
          acceptTerms: true,
        },
        headers: await client.altcha(),
      });
    const answers = [await signUp(known.email), await signUp(uniqueEmail('shop'))];
    for (const answer of answers) {
      expect(await json(answer, 403)).toMatchObject({ code: 'SHOP_CUSTOMER_LIMIT_REACHED' });
    }
  });

  it("keeps a closed shop's slug from the merchant's new shop while its customers hold a balance", async () => {
    const context = await shopFor();
    const customer = await invited(context);
    await json(
      await send(
        'POST',
        `/api/merchant/shop/customers/${customer.id}/transfers`,
        context.owner.cookie,
        {
          currency: 'usd',
          amountUnits: usd(3),
          expectedUsdUnits: usd(3),
        },
        key(),
      ),
      201,
    );
    await json(
      await send('POST', `/api/admin/shops/${context.shopId}/close`, admin.cookie, {
        reason: 'إغلاق',
      }),
      200,
    );
    const again = { slug: context.slug, brandColor: '#1f7a6c', rateMode: 'store' };
    expect(
      await json(await send('POST', '/api/merchant/shop', context.owner.cookie, again, key()), 409),
    ).toMatchObject({ code: 'SLUG_TAKEN' });
    // Once settled, the slug is the merchant's again.
    await json(
      await send(
        'POST',
        `/api/admin/shops/${context.shopId}/customers/${customer.id}/settle`,
        admin.cookie,
        {
          to: 'merchant',
          reason: 'تسوية',
        },
        key(),
      ),
      201,
    );
    await json(await send('POST', '/api/merchant/shop', context.owner.cookie, again, key()), 201);
  });
});
