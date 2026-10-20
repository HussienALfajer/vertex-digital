import { randomBytes, randomUUID } from 'node:crypto';
import { MERCHANT_SETTINGS_DEFAULTS, ROOT_PRICE_LIST_IDS } from '@vertex-digital/contracts';
import { merchantApplications } from '@vertex-digital/db';
import { eq, sql } from 'drizzle-orm';
import sharp from 'sharp';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  api,
  auditOf,
  notificationsOf,
  PASSWORD,
  removeAccounts,
  seedCustomer,
  setSwitches,
  totp,
} from './helpers.js';
import { startApp, type TestApp } from './start-app.js';

/*
 * Merchant accounts (S20 PR 3) over HTTP against the test database: the application and its
 * decisions (MA1–MA8), the shop photo (MA3), the terms (MT1, MT2), the direct grant and the
 * revocation (MA6, MA7), the merchant tier (MD1, MD2), the order rate (PO5), the settings, the
 * merchants list, the reports breakdown and the dashboard item.
 */

let test: TestApp;
let client: ReturnType<typeof api>;
let admin: Awaited<ReturnType<ReturnType<typeof api>['adminWithTotp']>>;
let plainAdmin: string;
let termsVersionId: string;
const seeded: string[] = [];
const usd = (dollars: number) => Math.round(dollars * 1_000_000);

async function reauthenticate() {
  const response = await client.post('/api/admin/me/reauthenticate', {
    cookie: admin.cookie,
    body: { password: PASSWORD, totpCode: totp(admin.secret) },
  });
  expect(response.status).toBe(200);
}

async function json<T = Record<string, unknown>>(response: Response, status: number): Promise<T> {
  const payload = await response.json();
  expect(response.status, JSON.stringify(payload)).toBe(status);
  return payload as T;
}

const adminGet = (path: string, cookie = admin.cookie) => client.get(path, { cookie });
const adminSend = (method: string, path: string, payload?: unknown, cookie = admin.cookie) =>
  client.request(method, path, { cookie, body: payload });

async function customer() {
  const phone = `+96393${randomBytes(4).readUInt32BE(0).toString().padStart(7, '0').slice(0, 7)}`;
  const seededCustomer = await seedCustomer(test.db, { phone });
  seeded.push(seededCustomer.id);
  return { ...seededCustomer, cookie: await client.signInCustomer(seededCustomer.email) };
}

type Customer = Awaited<ReturnType<typeof customer>>;

const form = (values: Record<string, unknown> = {}) => ({
  tradeName: 'محل النور',
  activity: 'phone_shop',
  activityOther: null,
  yearsInBusiness: '1_3',
  governorate: 'aleppo',
  city: 'اعزاز',
  streetAddress: 'شارع السوق، قرب الجامع',
  whatsapp: '0933123456',
  telegramUsername: null,
  monthlyVolume: '500_2000',
  productInterests: ['game_topups'],
  salesChannels: ['shop_counter'],
  shopPhotoFileId: null,
  shopLink: null,
  termsVersionId,
  heardFrom: null,
  ...values,
});

const submit = (who: Customer, values: Record<string, unknown> = {}, key = randomUUID()) =>
  client.post('/api/merchant/application', {
    cookie: who.cookie,
    headers: { 'idempotency-key': key },
    body: form(values),
  });

const stateOf = async (who: Customer) =>
  json<{
    application: {
      id: string;
      status: string;
      adminMessage: string | null;
      events: unknown[];
    } | null;
    canApply: boolean;
    availableAt: string | null;
    termsVersionId: string | null;
  }>(await client.get('/api/merchant/application', { cookie: who.cookie }), 200);

async function uploadPhoto(who: Customer) {
  const data = new FormData();
  const png = await sharp(randomBytes(32 * 32 * 3), { raw: { width: 32, height: 32, channels: 3 } })
    .png()
    .toBuffer();
  data.set('file', new Blob([new Uint8Array(png)]), 'shop.png');
  return json<{ fileId: string }>(
    await client.post('/api/merchant/application/photo', { cookie: who.cookie, form: data }),
    201,
  );
}

/** Publishes a merchant terms version through the panel (MT1) and returns its id. */
async function publishTerms() {
  const draft = await json<{ revision: number }>(
    await adminGet('/api/admin/content/pages/merchant_terms'),
    200,
  );
  await json(
    await adminSend('PUT', '/api/admin/content/pages/merchant_terms/draft', {
      title: 'شروط حساب التاجر',
      body: `يلتزم التاجر بالشروط ${randomBytes(3).toString('hex')}.`,
      revision: draft.revision,
    }),
    200,
  );
  await json(
    await adminSend('POST', '/api/admin/content/pages/merchant_terms/publish', {
      revision: draft.revision + 1,
    }),
    201,
  );
}

const accountOf = async (who: Customer) =>
  json<{ accountType: string; priceKind: string; merchant: unknown }>(
    await client.get('/api/account', { cookie: who.cookie }),
    200,
  );

beforeAll(async () => {
  test = await startApp();
  client = api(test.url);
  admin = await client.adminWithTotp(test.db);
  seeded.push(admin.id);
  plainAdmin = await client.signInAdmin(admin.email, admin.secret);
  await reauthenticate();
  await setSwitches(test.db);
  const someone = await customer();
  const before = await stateOf(someone);
  if (before.termsVersionId === null) {
    // MT1: before the first version, nobody may apply.
    expect(before.canApply).toBe(false);
    expect(await json(await submit(someone, { termsVersionId: randomUUID() }), 409)).toMatchObject({
      code: 'MERCHANT_TERMS_UNAVAILABLE',
    });
  }
  await publishTerms();
  termsVersionId = (await stateOf(someone)).termsVersionId as string;
  // A worker's earlier runs may have changed the settings: start from the seeded values.
  await json(
    await adminSend('PUT', '/api/admin/merchant-settings', MERCHANT_SETTINGS_DEFAULTS),
    200,
  );
});

afterAll(async () => {
  await removeAccounts(test.db, seeded);
  await setSwitches(test.db);
  await test.app.close();
});

describe('access', () => {
  it('refuses strangers, customers on admin routes and the admin on customer routes', async () => {
    const someone = await customer();
    expect((await client.get('/api/merchant/application')).status).toBe(401);
    expect((await client.get('/api/admin/merchant-applications')).status).toBe(401);
    expect(
      (await client.get('/api/admin/merchant-applications', { cookie: someone.cookie })).status,
    ).toBe(401);
    expect((await client.get('/api/merchant/application', { cookie: admin.cookie })).status).toBe(
      401,
    );
  });

  it('re-authenticates approvals, grants, revocations and settings', async () => {
    const someone = await customer();
    const path = `/api/admin/customers/${someone.id}/merchant`;
    const body = { tradeName: 'محل', governorate: 'damascus', city: 'دمشق', reason: 'تاجر معروف' };
    for (const [method, route, payload] of [
      ['POST', path, body],
      ['POST', `${path}/revoke`, { reason: 'لم يعد تاجراً' }],
      ['POST', `/api/admin/merchant-applications/${randomUUID()}/approve`, {}],
      ['PUT', '/api/admin/merchant-settings', MERCHANT_SETTINGS_DEFAULTS],
    ] as const) {
      expect(
        await json(await adminSend(method, route, payload, plainAdmin), 403),
        route,
      ).toMatchObject({ code: 'REAUTHENTICATION_REQUIRED' });
    }
  });
});

describe('the application (MA1–MA5, MA8)', () => {
  it('submits once per key, refuses a second open one, and is reviewed to approval', async () => {
    const shop = await customer();
    const { fileId } = await uploadPhoto(shop);
    const key = randomUUID();
    const created = await json<{ id: string; status: string; whatsapp: string }>(
      await submit(shop, { shopPhotoFileId: fileId }, key),
      201,
    );
    expect(created).toMatchObject({ status: 'under_review', whatsapp: '+963933123456' });
    // The key replays the same application (200).
    expect(await json(await submit(shop, { shopPhotoFileId: fileId }, key), 200)).toMatchObject({
      id: created.id,
    });
    expect(await json(await submit(shop), 409)).toMatchObject({
      code: 'MERCHANT_APPLICATION_OPEN',
      details: { applicationId: created.id },
    });
    // Another customer reaches neither the photo nor the key.
    const other = await customer();
    expect(
      (await client.get(`/api/merchant/application/photo/${fileId}`, { cookie: other.cookie }))
        .status,
    ).toBe(404);
    expect(await json(await submit(other, {}, key), 409)).toMatchObject({
      code: 'IDEMPOTENCY_KEY_REUSED',
    });
    expect(await json(await submit(other, { shopPhotoFileId: fileId }), 400)).toMatchObject({
      code: 'VALIDATION_FAILED',
    });
    expect(
      (await client.get(`/api/merchant/application/photo/${fileId}`, { cookie: shop.cookie }))
        .status,
    ).toBe(200);
    expect((await adminGet(`/api/admin/merchant-applications/${created.id}/photo`)).status).toBe(
      200,
    );

    // The queue lists it under review; the Telegram notice carries no personal data.
    const queue = await json<{ items: { id: string; customer: { id: string } }[] }>(
      await adminGet('/api/admin/merchant-applications?status=under_review&limit=100'),
      200,
    );
    expect(queue.items.some((row) => row.id === created.id)).toBe(true);
    const [notice] = (
      await test.db.execute<{ params: Record<string, unknown> }>(
        sql`select params from telegram_messages where kind = 'merchant_application'
          and params->>'applicationId' = ${created.id}`,
      )
    ).rows;
    expect(Object.keys(notice?.params ?? {}).sort()).toEqual([
      'applicationId',
      'resubmitted',
      'waiting',
    ]);

    // Request information; the customer edits and resubmits.
    const requested = await json<{ status: string; adminMessage: string }>(
      await adminSend('POST', `/api/admin/merchant-applications/${created.id}/request-info`, {
        message: 'أرسل صورة واجهة المحل',
      }),
      200,
    );
    expect(requested).toMatchObject({ status: 'info_requested' });
    expect(
      await json(
        await adminSend('POST', `/api/admin/merchant-applications/${created.id}/approve`, {}),
        409,
      ),
    ).toMatchObject({ code: 'APPLICATION_STATE_INVALID', details: { status: 'info_requested' } });
    const resubmitted = await json<{ status: string; tradeName: string }>(
      await client.put('/api/merchant/application', {
        cookie: shop.cookie,
        body: form({ tradeName: 'محل النور للاتصالات', shopPhotoFileId: fileId }),
      }),
      200,
    );
    expect(resubmitted).toMatchObject({ status: 'under_review', tradeName: 'محل النور للاتصالات' });

    // Approval on wholesale (MA5).
    const approved = await json<{ status: string; approvedPriceList: { id: string } }>(
      await adminSend('POST', `/api/admin/merchant-applications/${created.id}/approve`, {}),
      200,
    );
    expect(approved).toMatchObject({
      status: 'approved',
      approvedPriceList: { id: ROOT_PRICE_LIST_IDS.wholesale },
    });
    expect(await accountOf(shop)).toMatchObject({
      accountType: 'merchant',
      priceKind: 'wholesale',
      merchant: { tradeName: 'محل النور للاتصالات', termsAccepted: true },
    });
    expect((await notificationsOf(test.db, shop.id)).map((row) => row.event)).toEqual([
      'merchant_info_requested',
      'merchant_approved',
    ]);
    expect((await auditOf(test.db, created.id)).map((row) => row.action)).toEqual([
      'merchant_application.submitted',
      'merchant_application.info_requested',
      'merchant_application.resubmitted',
      'merchant_application.approved',
    ]);
    const state = await stateOf(shop);
    expect(state).toMatchObject({ canApply: false });
    expect(state.application?.events).toHaveLength(4);
    expect(await json(await submit(shop), 409)).toMatchObject({ code: 'ALREADY_MERCHANT' });

    // MD2: the profile reads the merchant tier.
    const profile = await json<{ limits: { effective: { perDeposit: unknown } } }>(
      await adminGet(`/api/admin/customers/${shop.id}`),
      200,
    );
    expect(profile.limits.effective.perDeposit).toEqual({
      units: MERCHANT_SETTINGS_DEFAULTS.perDepositUsdUnits,
      source: 'default_merchant',
    });
    const merchants = await json<{ items: { customerId: string; priceKind: string }[] }>(
      await adminGet(`/api/admin/merchants?listId=${ROOT_PRICE_LIST_IDS.wholesale}&limit=100`),
      200,
    );
    expect(merchants.items.find((row) => row.customerId === shop.id)).toMatchObject({
      priceKind: 'wholesale',
    });
  });

  it('waits after a rejection, until the settings allow it (MA1)', async () => {
    const shop = await customer();
    const { id } = await json<{ id: string }>(await submit(shop), 201);
    await json(
      await adminSend('POST', `/api/admin/merchant-applications/${id}/reject`, {
        reason: 'لم نتحقق من المحل',
      }),
      200,
    );
    const rejected = await stateOf(shop);
    expect(rejected).toMatchObject({ canApply: false, application: { status: 'rejected' } });
    expect(rejected.availableAt).not.toBeNull();
    expect(await json(await submit(shop), 409)).toMatchObject({
      code: 'MERCHANT_REAPPLY_TOO_SOON',
      details: { availableAt: rejected.availableAt },
    });
    const [notice] = await notificationsOf(test.db, shop.id);
    expect(notice).toMatchObject({
      event: 'merchant_rejected',
      params: { reason: 'لم نتحقق من المحل', availableAt: rejected.availableAt },
    });
    await json(
      await adminSend('PUT', '/api/admin/merchant-settings', {
        ...MERCHANT_SETTINGS_DEFAULTS,
        reapplyWaitDays: 0,
      }),
      200,
    );
    expect((await stateOf(shop)).canApply).toBe(true);
    await json(await submit(shop), 201);
    await json(
      await adminSend('PUT', '/api/admin/merchant-settings', MERCHANT_SETTINGS_DEFAULTS),
      200,
    );
  });

  it('lets the customer withdraw, then apply again at once (MA4)', async () => {
    const shop = await customer();
    await json(await submit(shop), 201);
    expect(
      await json(
        await client.post('/api/merchant/application/withdraw', { cookie: shop.cookie }),
        200,
      ),
    ).toMatchObject({ status: 'withdrawn' });
    expect(
      await json(
        await client.post('/api/merchant/application/withdraw', { cookie: shop.cookie }),
        409,
      ),
    ).toMatchObject({ code: 'APPLICATION_STATE_INVALID', details: { status: 'withdrawn' } });
    await json(await submit(shop), 201);
  });

  it('refuses a frozen customer, other terms and an approval of a frozen applicant', async () => {
    const shop = await customer();
    expect(await json(await submit(shop, { termsVersionId: randomUUID() }), 400)).toMatchObject({
      code: 'VALIDATION_FAILED',
    });
    const { id } = await json<{ id: string }>(await submit(shop), 201);
    await test.db.execute(sql`update customers set frozen_at = now() where id = ${shop.id}`);
    expect(
      await json(
        await adminSend('POST', `/api/admin/merchant-applications/${id}/approve`, {}),
        409,
      ),
    ).toMatchObject({ code: 'CUSTOMER_STATE_INVALID' });
    const [row] = await test.db
      .select({ status: merchantApplications.status })
      .from(merchantApplications)
      .where(eq(merchantApplications.id, id));
    expect(row?.status).toBe('under_review');
    const frozen = await customer();
    await test.db.execute(sql`update customers set frozen_at = now() where id = ${frozen.id}`);
    expect(await json(await submit(frozen), 403)).toMatchObject({ code: 'ACCOUNT_FROZEN' });
  });
});

describe('access of the other application routes', () => {
  it('refuses a frozen account the resubmission, the withdrawal and the photo', async () => {
    const shop = await customer();
    await json(await submit(shop), 201);
    await test.db.execute(sql`update customers set frozen_at = now() where id = ${shop.id}`);
    expect(
      await json(
        await client.put('/api/merchant/application', { cookie: shop.cookie, body: form() }),
        403,
      ),
    ).toMatchObject({ code: 'ACCOUNT_FROZEN' });
    expect(
      await json(
        await client.post('/api/merchant/application/withdraw', { cookie: shop.cookie }),
        403,
      ),
    ).toMatchObject({ code: 'ACCOUNT_FROZEN' });
    const data = new FormData();
    data.set('file', new Blob([new Uint8Array([1, 2, 3])]), 'shop.png');
    expect(
      await json(
        await client.post('/api/merchant/application/photo', { cookie: shop.cookie, form: data }),
        403,
      ),
    ).toMatchObject({ code: 'ACCOUNT_FROZEN' });
  });

  it('refuses a merchant a photo', async () => {
    const shop = await customer();
    await json(
      await adminSend('POST', `/api/admin/customers/${shop.id}/merchant`, {
        tradeName: 'محل',
        governorate: 'damascus',
        city: 'دمشق',
        reason: 'تاجر معروف لدينا',
      }),
      200,
    );
    const data = new FormData();
    data.set('file', new Blob([new Uint8Array([1, 2, 3])]), 'shop.png');
    expect(
      await json(
        await client.post('/api/merchant/application/photo', { cookie: shop.cookie, form: data }),
        409,
      ),
    ).toMatchObject({ code: 'ALREADY_MERCHANT' });
  });
});

describe('the direct grant, the terms and the revocation (MA6, MA7, MT2)', () => {
  it('grants with a list, asks for the terms before buying, then revokes', async () => {
    const shop = await customer();
    const { id: openId } = await json<{ id: string }>(await submit(shop), 201);
    const granted = await json<{
      pricing: { priceKind: string };
      merchant: { termsVersion: null };
    }>(
      await adminSend('POST', `/api/admin/customers/${shop.id}/merchant`, {
        tradeName: 'متجر الشام',
        governorate: 'damascus',
        city: 'دمشق',
        priceListId: ROOT_PRICE_LIST_IDS.cost,
        reason: 'تاجر معروف لدينا',
      }),
      200,
    );
    expect(granted).toMatchObject({
      pricing: { priceKind: 'special' },
      merchant: { termsVersion: null },
    });
    // The open application is closed as approved by the grant.
    expect((await stateOf(shop)).application).toMatchObject({ id: openId, status: 'approved' });
    expect(
      await json(
        await adminSend('POST', `/api/admin/customers/${shop.id}/merchant`, {
          tradeName: 'متجر',
          governorate: 'damascus',
          city: 'دمشق',
          reason: 'مرة أخرى',
        }),
        409,
      ),
    ).toMatchObject({ code: 'ALREADY_MERCHANT' });
    expect(await accountOf(shop)).toMatchObject({ merchant: { termsAccepted: false } });
    const purchase = await client.post('/api/orders', {
      cookie: shop.cookie,
      headers: { 'idempotency-key': randomUUID() },
      body: {
        productId: randomUUID(),
        quantity: 1,
        fields: {},
        expectedUnitPriceUsdUnits: usd(1),
      },
    });
    expect(await json(purchase, 409)).toMatchObject({ code: 'MERCHANT_TERMS_REQUIRED' });
    const accept = (versionId: string, who = shop) =>
      client.post('/api/merchant/terms', { cookie: who.cookie, body: { versionId } });
    expect(await json(await accept(randomUUID()), 400)).toMatchObject({
      code: 'VALIDATION_FAILED',
    });
    expect((await accept(termsVersionId)).status).toBe(204);
    expect(await accountOf(shop)).toMatchObject({ merchant: { termsAccepted: true } });
    const someone = await customer();
    expect(await json(await accept(termsVersionId, someone), 409)).toMatchObject({
      code: 'NOT_MERCHANT',
    });

    const revoked = await json<{ pricing: { accountType: string; priceKind: string } }>(
      await adminSend('POST', `/api/admin/customers/${shop.id}/merchant/revoke`, {
        reason: 'لم يعد تاجراً',
      }),
      200,
    );
    expect(revoked.pricing).toMatchObject({ accountType: 'customer', priceKind: 'retail' });
    expect(
      await json(
        await adminSend('POST', `/api/admin/customers/${shop.id}/merchant/revoke`, {
          reason: 'لم يعد تاجراً',
        }),
        409,
      ),
    ).toMatchObject({ code: 'NOT_MERCHANT' });
    expect((await auditOf(test.db, shop.id)).map((row) => row.action)).toEqual(
      expect.arrayContaining([
        'customer.merchant_granted',
        'merchant.terms_accepted',
        'customer.merchant_revoked',
      ]),
    );
    // A revocation is not a rejection: the customer may apply again at once.
    expect((await stateOf(shop)).canApply).toBe(true);
  });

  it('gives a merchant the merchant order rate (PO5)', async () => {
    const attempt = (who: Customer, ip: string) =>
      client.post('/api/orders', {
        cookie: who.cookie,
        ip,
        headers: { 'idempotency-key': randomUUID() },
        body: {
          productId: randomUUID(),
          quantity: 1,
          fields: {},
          expectedUnitPriceUsdUnits: usd(1),
        },
      });
    const plain = await customer();
    const plainIp = `10.${randomBytes(3).join('.')}`;
    const statuses = [];
    for (let index = 0; index < 11; index += 1)
      statuses.push((await attempt(plain, plainIp)).status);
    expect(statuses.at(-1)).toBe(429);
    const shop = await customer();
    await json(
      await adminSend('POST', `/api/admin/customers/${shop.id}/merchant`, {
        tradeName: 'محل',
        governorate: 'damascus',
        city: 'دمشق',
        reason: 'تاجر معروف لدينا',
      }),
      200,
    );
    const shopIp = `10.${randomBytes(3).join('.')}`;
    for (let index = 0; index < 11; index += 1) {
      expect((await attempt(shop, shopIp)).status).not.toBe(429);
    }
  });
});

describe('settings, reports and the dashboard', () => {
  it('refuses limits below the deposit minimums or above the day', async () => {
    expect(
      await json(
        await adminSend('PUT', '/api/admin/merchant-settings', {
          ...MERCHANT_SETTINGS_DEFAULTS,
          perDepositUsdUnits: usd(1),
        }),
        400,
      ),
    ).toMatchObject({ code: 'VALIDATION_FAILED' });
    expect(
      await json(
        await adminSend('PUT', '/api/admin/merchant-settings', {
          ...MERCHANT_SETTINGS_DEFAULTS,
          perDepositUsdUnits: usd(6000),
        }),
        400,
      ),
    ).toMatchObject({ code: 'VALIDATION_FAILED' });
    expect(await json(await adminGet('/api/admin/merchant-settings'), 200)).toMatchObject({
      ...MERCHANT_SETTINGS_DEFAULTS,
    });
  });

  it('breaks sales down by price list and by merchant', async () => {
    for (const by of ['price_list', 'merchant']) {
      expect(
        await json(
          await adminGet(`/api/admin/reports/breakdown?from=2026-10-01&to=2026-10-21&by=${by}`),
          200,
        ),
      ).toMatchObject({ by });
    }
  });

  it('lists waiting applications on the dashboard (MA8)', async () => {
    const shop = await customer();
    await json(await submit(shop), 201);
    const dashboard = await json<{ attention: { kind: string; target: string }[] }>(
      await adminGet('/api/admin/dashboard'),
      200,
    );
    expect(dashboard.attention).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: 'merchant_applications_waiting',
          target: '/merchants/applications',
        }),
      ]),
    );
  });
});
