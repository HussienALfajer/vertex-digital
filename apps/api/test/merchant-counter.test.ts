import { randomBytes, randomUUID } from 'node:crypto';
import {
  applyOutcome,
  catalogCategories,
  customerRateLimits,
  customers,
  ensureCustomerWallet,
  ensureSystemAccount,
  fulfilmentAttempts,
  lockOrder,
  merchantProfiles,
  newId,
  orderCodesKey,
  postJournal,
  supplierBalanceReads,
  supplierOffers,
  supplierSyncRuns,
  suppliers,
  transitionOrder,
} from '@vertex-digital/db';
import { FakeSupplierAdapter } from '@vertex-digital/suppliers';
import { and, eq, sql } from 'drizzle-orm';
import ExcelJS from 'exceljs';
import sharp from 'sharp';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { parseEnv } from '../src/core/config/env.js';
import { SupplierAdaptersService } from '../src/modules/suppliers/supplier-adapters.service.js';
import {
  api,
  auditOf,
  PASSWORD,
  removeAccounts,
  seedCustomer,
  setSwitches,
  totp,
} from './helpers.js';
import { startApp, type TestApp } from './start-app.js';

/*
 * The counter tools (S21 PR 2) over HTTP against the test database with the `fake` supplier:
 * recent ids (PS2), the bulk check and its quota (BK1–BK4), 50-line checkouts (BK3), an order's
 * selling price (SP5), the printed receipt and the verification page (PR2, VF1–VF3, BR1), the
 * branded receipt link (BR2), receipt settings and the logo with the admin's removal (BR3), and
 * code releases' refusals (CR1). Supplier calls are spied on, never recorded on the fake.
 */

let test: TestApp;
let client: ReturnType<typeof api>;
let admin: Awaited<ReturnType<ReturnType<typeof api>['adminWithTotp']>>;
let plainAdmin: string;
const seeded: string[] = [];
const run = randomBytes(4).toString('hex');
const usd = (dollars: number) => Math.round(dollars * 1_000_000);
const ids = { fake: '', categoryId: '', gameId: '', slug: `mc-pubg-${run}` };
let item: { id: string; nameAr: string };

async function json<T = Record<string, unknown>>(response: Response, status: number): Promise<T> {
  const payload = await response.json();
  expect(response.status, JSON.stringify(payload)).toBe(status);
  return payload as T;
}

const adminSend = (method: string, path: string, payload?: unknown, cookie = admin.cookie) =>
  client.request(method, path, { cookie, body: payload });
const send = (method: string, path: string, cookie: string, payload?: unknown) =>
  client.request(method, path, { cookie, body: payload });

/** A direct pack of the test game routed to a fake offer at `costUsd`. */
async function product(costUsd: number) {
  await test.db.execute(sql`update catalog_games set status = 'paused' where id = ${ids.gameId}`);
  const nameAr = `باقة ${randomBytes(3).toString('hex')}`;
  const created = await json<{ id: string }>(
    await adminSend('POST', `/api/admin/catalog/games/${ids.gameId}/products`, {
      kind: 'direct',
      nameAr,
    }),
    201,
  );
  const now = new Date();
  const [offer] = await test.db
    .insert(supplierOffers)
    .values({
      supplierId: ids.fake,
      offerId: `o-${randomBytes(4).toString('hex')}`,
      name: 'Fake offer',
      kind: 'direct',
      requiredFields: ['playerId'],
      costUsdUnits: usd(costUsd),
      inStock: true,
      costConfirmedAt: now,
      lastSeenAt: now,
    })
    .returning({ id: supplierOffers.id });
  await json(
    await adminSend('POST', `/api/admin/catalog/products/${created.id}/routes`, {
      offerId: offer?.id,
      fieldMap: { playerId: 'player_id' },
    }),
    201,
  );
  await test.db.execute(sql`update catalog_games set status = 'active' where id = ${ids.gameId}`);
  return { id: created.id, nameAr };
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

/** A merchant who accepted the terms, with `funds` in the wallet. */
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
  if (funds > 0) await fund(person.id, funds);
  return { ...person, cookie: await client.signInCustomer(person.email) };
}

async function buyer(funds = usd(100)) {
  const person = await seedCustomer(test.db);
  seeded.push(person.id);
  if (funds > 0) await fund(person.id, funds);
  return { ...person, cookie: await client.signInCustomer(person.email) };
}

/** The pack's price for this account (the merchant's list or retail). */
async function priceFor(cookie: string, productId: string): Promise<number> {
  const prices = await json<{ products: { id: string; priceUsdUnits: number | null }[] }>(
    await client.get(`/api/catalog/games/${ids.slug}/prices`, { cookie }),
    200,
  );
  return prices.products.find((row) => row.id === productId)?.priceUsdUnits as number;
}

async function buy(cookie: string, playerId = '5123456789') {
  return json<{ id: string; verificationCode: string; number: string }>(
    await client.post('/api/orders', {
      cookie,
      headers: { 'idempotency-key': randomUUID() },
      body: {
        productId: item.id,
        quantity: 1,
        fields: { player_id: playerId },
        expectedUnitPriceUsdUnits: await priceFor(cookie, item.id),
        confirmPlayer: true,
      },
    }),
    201,
  );
}

beforeAll(async () => {
  test = await startApp();
  client = api(test.url);
  admin = await client.adminWithTotp(test.db);
  seeded.push(admin.id);
  plainAdmin = await client.signInAdmin(admin.email, admin.secret);
  const reauth = await client.post('/api/admin/me/reauthenticate', {
    cookie: admin.cookie,
    body: { password: PASSWORD, totpCode: totp(admin.secret) },
  });
  expect(reauth.status).toBe(200);
  await setSwitches(test.db);
  vi.spyOn(SupplierAdaptersService.prototype, 'recordCall').mockImplementation(async () => {});
  const [fake] = await test.db.select().from(suppliers).where(eq(suppliers.code, 'fake'));
  ids.fake = fake?.id as string;
  await test.db
    .insert(supplierBalanceReads)
    .values({ supplierId: ids.fake, currency: 'USD', amountUnits: usd(1_000_000) });
  await json(
    await adminSend('PUT', '/api/admin/suppliers/fake/credentials', {
      values: { webhookSecret: `whsec-${run}-counter` },
    }),
    200,
  );
  await test.db
    .update(supplierSyncRuns)
    .set({ status: 'failed', finishedAt: new Date(), errorCode: 'TEST' })
    .where(and(eq(supplierSyncRuns.supplierId, ids.fake), eq(supplierSyncRuns.status, 'running')));
  const category = await json<{ id: string }>(
    await adminSend('POST', '/api/admin/catalog/categories', {
      slug: `mc-${run}`,
      nameAr: `الكاونتر ${run}`,
    }),
    201,
  );
  ids.categoryId = category.id;
  const game = await json<{ id: string }>(
    await adminSend('POST', '/api/admin/catalog/games', {
      categoryId: category.id,
      slug: ids.slug,
      nameAr: `ببجي ${run}`,
      nameEn: 'PUBG',
    }),
    201,
  );
  ids.gameId = game.id;
  await json(
    await adminSend('POST', `/api/admin/catalog/games/${game.id}/fields`, {
      key: 'player_id',
      labelAr: 'المعرف',
      type: 'digits',
      required: true,
      minLength: 5,
    }),
    201,
  );
  item = await product(1);
});

afterAll(async () => {
  vi.restoreAllMocks();
  await test.db
    .update(catalogCategories)
    .set({ archivedAt: new Date() })
    .where(eq(catalogCategories.id, ids.categoryId));
  await setSwitches(test.db);
  await removeAccounts(test.db, seeded);
  await test.app.close();
});

describe('access (S21 MA1, "Access")', () => {
  it('refuses strangers, the admin and customers on the counter routes', async () => {
    const routes = [
      `/api/merchant/recent-players?gameId=${ids.gameId}`,
      '/api/merchant/receipt-settings',
    ];
    for (const path of routes) {
      expect((await client.get(path)).status, path).toBe(401);
      expect((await client.get(path, { cookie: admin.cookie })).status, path).toBe(401);
    }
    const person = await buyer(0);
    for (const path of routes) {
      expect(await json(await client.get(path, { cookie: person.cookie }), 403)).toMatchObject({
        code: 'NOT_MERCHANT',
      });
    }
    expect(
      await json(
        await send('POST', '/api/merchant/bulk/check', person.cookie, {
          gameId: ids.gameId,
          text: '51234,x',
        }),
        403,
      ),
    ).toMatchObject({ code: 'NOT_MERCHANT' });
    expect(
      await json(
        await send('PUT', `/api/orders/${randomUUID()}/sale`, person.cookie, {
          currency: 'usd',
          amountUnits: usd(2),
        }),
        403,
      ),
    ).toMatchObject({ code: 'NOT_MERCHANT' });
    expect(
      await json(
        await send('POST', `/api/orders/${randomUUID()}/codes/release`, person.cookie, {
          purpose: 'print',
        }),
        403,
      ),
    ).toMatchObject({ code: 'NOT_MERCHANT' });
  });
});

describe('checkouts and recent ids (S21 BK3, PS2)', () => {
  it('pays 12 lines for a merchant, refuses 11 for a customer, and lists recent ids', async () => {
    const shop = await merchant(usd(100));
    const person = await buyer(usd(100));
    const lines = (count: number, unit: number) =>
      Array.from({ length: count }, (_, index) => ({
        productId: item.id,
        quantity: 1,
        fields: { player_id: `51000000${String(index).padStart(2, '0')}` },
        expectedUnitPriceUsdUnits: unit,
        confirmPlayer: true,
      }));
    const pay = (cookie: string, body: unknown) =>
      client.post('/api/checkouts', {
        cookie,
        headers: { 'idempotency-key': randomUUID() },
        body,
      });
    expect(
      await json(
        await pay(person.cookie, { lines: lines(11, await priceFor(person.cookie, item.id)) }),
        400,
      ),
    ).toMatchObject({ code: 'VALIDATION_FAILED' });
    const checkout = await json<{ orders: unknown[] }>(
      await pay(shop.cookie, {
        lines: lines(12, await priceFor(shop.cookie, item.id)),
        source: 'bulk',
      }),
      201,
    );
    expect(checkout.orders).toHaveLength(12);
    const recent = await json<{ items: { fields: Record<string, string> }[] }>(
      await client.get(`/api/merchant/recent-players?gameId=${ids.gameId}`, {
        cookie: shop.cookie,
      }),
      200,
    );
    expect(recent.items).toHaveLength(12);
    expect(recent.items[0]?.fields.player_id).toMatch(/^51000000\d\d$/);
  });
});

describe('the bulk check (S21 BK1–BK4)', () => {
  it('checks every line on the merchant’s list, each id once, and needs confirmations', async () => {
    const shop = await merchant(usd(50));
    const spy = vi
      .spyOn(FakeSupplierAdapter.prototype, 'validatePlayer')
      .mockImplementation(async (request) =>
        request.fields.playerId === '7000000001'
          ? { valid: true, playerName: 'Nour' }
          : { valid: false },
      );
    const text = [
      `# player_id, pack, quantity`,
      `7000000001,${item.nameAr}`,
      `7000000001;${item.nameAr};2`,
      `7000000002\t${item.nameAr}`,
      `7000000003,باقة لا توجد`,
      `12,${item.nameAr}`,
      `7000000004,${item.nameAr},99`,
    ].join('\n');
    const result = await json<{
      lines: {
        line: number;
        errors: { code: string; field: string | null }[];
        check: { result: string } | null;
        needsConfirmation: boolean;
        totalUsdUnits: number | null;
      }[];
      totalUsdUnits: number;
      balanceUsdUnits: number;
    }>(
      await send('POST', '/api/merchant/bulk/check', shop.cookie, { gameId: ids.gameId, text }),
      200,
    );
    // The same id is checked once (edge case 9).
    const calls = spy.mock.calls.length;
    spy.mockRestore();
    expect(calls).toBe(2);
    const unit = await priceFor(shop.cookie, item.id);
    expect(result.lines.map((line) => [line.line, line.errors.map((e) => e.code)])).toEqual([
      [2, []],
      // A direct pack allows one unit per order.
      [3, ['quantity_above_max']],
      [4, []],
      [5, ['pack_unknown']],
      [6, ['field_invalid']],
      [7, ['quantity_invalid']],
    ]);
    expect(result.lines.map((line) => line.check?.result ?? null)).toEqual([
      'valid',
      null,
      'invalid',
      null,
      null,
      null,
    ]);
    expect(result.lines.map((line) => line.needsConfirmation)).toEqual([
      false,
      false,
      true,
      false,
      false,
      false,
    ]);
    expect(result.totalUsdUnits).toBe(unit * 2);
    expect(result.balanceUsdUnits).toBe(usd(50));

    expect(
      await json(
        await send('POST', '/api/merchant/bulk/check', shop.cookie, {
          gameId: ids.gameId,
          text: Array.from({ length: 51 }, () => `7000000001,${item.nameAr}`).join('\n'),
        }),
        422,
      ),
    ).toMatchObject({ code: 'BULK_LINES_INVALID', details: { lines: 51, max: 50 } });
  });

  it('marks lines unchecked once the merchant’s quota is used, and refuses the check (BK4)', async () => {
    const shop = await merchant(usd(10));
    await test.db.insert(customerRateLimits).values({
      id: newId(),
      key: `player-check:customer:${shop.id}`,
      count: 100,
      lastRequest: Date.now(),
    });
    const spy = vi.spyOn(FakeSupplierAdapter.prototype, 'validatePlayer');
    const result = await json<{ lines: { check: unknown; needsConfirmation: boolean }[] }>(
      await send('POST', '/api/merchant/bulk/check', shop.cookie, {
        gameId: ids.gameId,
        text: `7100000001,${item.nameAr}`,
      }),
      200,
    );
    expect(result.lines[0]).toMatchObject({
      check: { result: 'unavailable', reason: 'quota' },
      needsConfirmation: true,
    });
    const refused = await json(
      await send('POST', '/api/player-checks', shop.cookie, {
        productId: item.id,
        fields: { player_id: '7100000002' },
      }),
      429,
    );
    expect(refused).toMatchObject({
      code: 'PLAYER_CHECK_QUOTA_EXCEEDED',
      details: { retryAt: expect.any(String) },
    });
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });
});

describe('selling price, print and verification (S21 SP5, PR2, VF1–VF3, BR1, BR2)', () => {
  it('shows the selling price on the receipt and none on the verification page', async () => {
    const shop = await merchant();
    const other = await merchant();
    const order = await buy(shop.cookie);
    expect(order.verificationCode).toMatch(/^[A-Za-z0-9_-]{22}$/);

    const sale = { currency: 'syp', amountUnits: 15_000_00 };
    expect(
      await json(await send('PUT', `/api/orders/${order.id}/sale`, shop.cookie, sale), 200),
    ).toMatchObject({ currency: 'syp', unitAmountUnits: 15_000_00, source: 'manual' });
    expect(
      await json(await send('PUT', `/api/orders/${order.id}/sale`, other.cookie, sale), 404),
    ).toMatchObject({ code: 'NOT_FOUND' });
    const view = await json<{ sale: unknown; verificationCode: string }>(
      await client.get(`/api/orders/${order.id}`, { cookie: shop.cookie }),
      200,
    );
    expect(view.sale).toMatchObject({ currency: 'syp', source: 'manual' });

    const print = await json<Record<string, unknown>>(
      await client.get(`/api/orders/${order.id}/print`, { cookie: shop.cookie }),
      200,
    );
    expect(print).toMatchObject({
      issuer: { kind: 'merchant', tradeName: 'محل النور' },
      price: { kind: 'selling', currency: 'syp', unitAmountUnits: 15_000_00 },
      fields: [{ labelAr: 'المعرف', value: '••••6789' }],
      verificationCode: order.verificationCode,
    });
    expect(
      (await client.get(`/api/orders/${order.id}/print`, { cookie: other.cookie })).status,
    ).toBe(404);

    const page = await json<Record<string, unknown>>(
      await client.get(`/api/verify/${order.verificationCode}`),
      200,
    );
    expect(page).toMatchObject({
      issuer: { kind: 'merchant', tradeName: 'محل النور' },
      orderNumber: order.number,
      stage: expect.any(String),
    });
    expect(JSON.stringify(page)).not.toMatch(/Units|5123456789|@/);
    expect(await json(await client.get(`/api/verify/${'A'.repeat(22)}`), 404)).toMatchObject({
      code: 'NOT_FOUND',
    });
    expect((await client.get('/api/verify/short')).status).toBe(404);

    // BR1, BR2: a branded receipt link shows the shop and its selling price, never the paid one.
    const link = await json<{ url: string; branded: boolean }>(
      await send('PUT', `/api/orders/${order.id}/receipt-link`, shop.cookie, {
        showPrice: true,
        playerDisplay: 'masked',
        branded: true,
      }),
      200,
    );
    expect(link.branded).toBe(true);
    const token = link.url.split('/').at(-1) as string;
    const share = await json<Record<string, unknown>>(
      await client.get(`/api/shares/${token}`),
      200,
    );
    expect(share).toMatchObject({
      branding: { tradeName: 'محل النور', whatsapp: null, hasLogo: false },
      sellingPrice: { currency: 'syp', unitAmountUnits: 15_000_00 },
      price: null,
      verificationCode: order.verificationCode,
    });
    const plain = await json<{ branded: boolean }>(
      await send('PUT', `/api/orders/${order.id}/receipt-link`, shop.cookie, {
        showPrice: true,
        playerDisplay: 'masked',
        branded: false,
      }),
      200,
    );
    expect(plain.branded).toBe(false);
    expect(await json(await client.get(`/api/shares/${token}`), 200)).toMatchObject({
      branding: null,
      sellingPrice: null,
      price: null,
    });

    // A customer's receipt is never branded.
    const person = await buyer();
    const retail = await buy(person.cookie);
    const customerLink = await json<{ branded: boolean }>(
      await send('PUT', `/api/orders/${retail.id}/receipt-link`, person.cookie, {
        showPrice: true,
        playerDisplay: 'masked',
        branded: true,
      }),
      200,
    );
    expect(customerLink.branded).toBe(false);
  });

  it('refuses releasing codes of an undelivered or another merchant’s order (CR1)', async () => {
    const shop = await merchant();
    const other = await merchant();
    const order = await buy(shop.cookie);
    expect(
      await json(
        await send('POST', `/api/orders/${order.id}/codes/release`, shop.cookie, {
          purpose: 'print',
        }),
        409,
      ),
    ).toMatchObject({ code: 'CODES_NOT_DELIVERED' });
    expect(
      await json(
        await send('POST', `/api/orders/${order.id}/codes/release`, other.cookie, {
          purpose: 'export',
        }),
        404,
      ),
    ).toMatchObject({ code: 'NOT_FOUND' });
  });
});

describe('receipt settings and the logo (S21 BR3)', () => {
  it('saves the WhatsApp, stores a logo, and lets the admin remove it with a reason', async () => {
    const shop = await merchant(0);
    expect(
      await json(await client.get('/api/merchant/receipt-settings', { cookie: shop.cookie }), 200),
    ).toEqual({ tradeName: 'محل النور', showWhatsapp: false, whatsapp: null, logoFileId: null });
    expect(
      await json(
        await send('PUT', '/api/merchant/receipt-settings', shop.cookie, {
          showWhatsapp: true,
          whatsapp: null,
          logoFileId: null,
        }),
        400,
      ),
    ).toMatchObject({ code: 'VALIDATION_FAILED' });

    const png = await sharp({
      create: { width: 800, height: 600, channels: 3, background: '#000000' },
    })
      .png()
      .toBuffer();
    const form = new FormData();
    form.append('file', new Blob([new Uint8Array(png)], { type: 'image/png' }), 'logo.png');
    const uploaded = await json<{ fileId: string }>(
      await client.post('/api/merchant/logo', { cookie: shop.cookie, form }),
      201,
    );
    const saved = await json<Record<string, unknown>>(
      await send('PUT', '/api/merchant/receipt-settings', shop.cookie, {
        showWhatsapp: true,
        whatsapp: '0933 123 456',
        logoFileId: uploaded.fileId,
      }),
      200,
    );
    expect(saved).toEqual({
      tradeName: 'محل النور',
      showWhatsapp: true,
      whatsapp: '+963933123456',
      logoFileId: uploaded.fileId,
    });
    const logo = await client.get(`/api/merchant/logo/${uploaded.fileId}`, { cookie: shop.cookie });
    expect(logo.status).toBe(200);
    expect(logo.headers.get('content-type')).toBe('image/webp');
    const other = await merchant(0);
    expect(
      (await client.get(`/api/merchant/logo/${uploaded.fileId}`, { cookie: other.cookie })).status,
    ).toBe(404);
    expect(
      await json(
        await send('PUT', '/api/merchant/receipt-settings', other.cookie, {
          showWhatsapp: false,
          whatsapp: null,
          logoFileId: uploaded.fileId,
        }),
        400,
      ),
    ).toMatchObject({ code: 'VALIDATION_FAILED' });

    const profile = await json<{ merchant: { branding: unknown } }>(
      await client.get(`/api/admin/customers/${shop.id}`, { cookie: admin.cookie }),
      200,
    );
    expect(profile.merchant.branding).toEqual({
      showWhatsapp: true,
      whatsapp: '+963933123456',
      logoFileId: uploaded.fileId,
    });
    expect(
      (await client.get(`/api/admin/customers/${shop.id}/merchant/logo`, { cookie: admin.cookie }))
        .status,
    ).toBe(200);
    const reason = { reason: 'شعار مضلل' };
    expect(
      await json(
        await adminSend(
          'DELETE',
          `/api/admin/customers/${shop.id}/merchant/logo`,
          reason,
          plainAdmin,
        ),
        403,
      ),
    ).toMatchObject({ code: 'REAUTHENTICATION_REQUIRED' });
    const removed = await adminSend(
      'DELETE',
      `/api/admin/customers/${shop.id}/merchant/logo`,
      reason,
    );
    expect(removed.status).toBe(204);
    const audit = (await auditOf(test.db, shop.id)).find(
      (entry) => entry.action === 'merchant.logo_removed',
    );
    expect(audit?.details).toEqual({ fileId: uploaded.fileId, reason: 'شعار مضلل' });
    expect(
      (await client.get(`/api/merchant/logo/${uploaded.fileId}`, { cookie: shop.cookie })).status,
    ).toBe(404);
    expect(
      (await adminSend('DELETE', `/api/admin/customers/${shop.id}/merchant/logo`, reason)).status,
    ).toBe(404);
  });
});

describe('code releases and the codes workbook (S21 CR1–CR4)', () => {
  /** A code pack of a game without account fields, routed to a fake code offer. */
  async function codePack() {
    const game = await json<{ id: string; slug: string }>(
      await adminSend('POST', '/api/admin/catalog/games', {
        categoryId: ids.categoryId,
        slug: `mc-codes-${randomBytes(3).toString('hex')}`,
        nameAr: `بطاقات ${randomBytes(3).toString('hex')}`,
        nameEn: 'Cards',
      }),
      201,
    );
    const created = await json<{ id: string }>(
      await adminSend('POST', `/api/admin/catalog/games/${game.id}/products`, {
        kind: 'code',
        nameAr: 'بطاقة $10',
        redemptionAr: 'افتح المتجر والصق الكود.',
      }),
      201,
    );
    const now = new Date();
    const [offer] = await test.db
      .insert(supplierOffers)
      .values({
        supplierId: ids.fake,
        offerId: `o-${randomBytes(4).toString('hex')}`,
        name: 'Fake card',
        kind: 'code',
        requiredFields: [],
        costUsdUnits: usd(9),
        inStock: true,
        costConfirmedAt: now,
        lastSeenAt: now,
      })
      .returning({ id: supplierOffers.id });
    const route = await json<{ routes: { id: string }[] }>(
      await adminSend('POST', `/api/admin/catalog/products/${created.id}/routes`, {
        offerId: offer?.id,
        fieldMap: {},
      }),
      201,
    );
    await test.db.execute(sql`update catalog_games set status = 'active' where id = ${game.id}`);
    return {
      id: created.id,
      slug: game.slug,
      offerId: offer?.id as string,
      routeId: route.routes[0]?.id as string,
    };
  }

  /** Delivers the order's units with these codes, as the worker's jobs will. */
  async function deliver(
    orderId: string,
    pack: { offerId: string; routeId: string },
    codes: string[],
  ) {
    const attemptId = await test.db.transaction(async (tx) => {
      const order = await lockOrder(tx, orderId);
      if (!order) throw new Error('No order');
      const id = newId();
      await tx.insert(fulfilmentAttempts).values({
        id,
        orderId,
        routeId: pack.routeId,
        supplierId: ids.fake,
        offerId: pack.offerId,
        supplierOfferId: 'o-test',
        quantity: order.quantity,
        unitCostUsdUnits: usd(9),
        status: 'sending',
        candidates: [],
        sentAt: new Date(),
      });
      await transitionOrder(tx, order, 'sent_to_supplier', { actor: 'system', attemptId: id });
      return id;
    });
    await test.db.transaction((tx) =>
      applyOutcome(
        tx,
        {
          jobs: { send: async () => null },
          codesKey: orderCodesKey(parseEnv().ORDER_CODES_SECRET as string),
          now: new Date(),
        },
        attemptId,
        { status: 'delivered', quantity: codes.length, codes },
        { by: 'supplier' },
      ),
    );
  }

  it('prints, exports and logs releases, 20 per 10 minutes with single reveals (CR1–CR3)', async () => {
    const pack = await codePack();
    const shop = await merchant(usd(200));
    const prices = await json<{ products: { id: string; priceUsdUnits: number | null }[] }>(
      await client.get(`/api/catalog/games/${pack.slug}/prices`, { cookie: shop.cookie }),
      200,
    );
    const unit = prices.products.find((row) => row.id === pack.id)?.priceUsdUnits as number;
    // QT1: a merchant buys 12 codes of a pack whose own limit is lower.
    const order = await json<{ id: string; number: string }>(
      await client.post('/api/orders', {
        cookie: shop.cookie,
        headers: { 'idempotency-key': randomUUID() },
        body: { productId: pack.id, quantity: 12, fields: {}, expectedUnitPriceUsdUnits: unit },
      }),
      201,
    );
    const codes = ['=HYPERLINK("x")', ...Array.from({ length: 11 }, (_, i) => `CODE-${i + 2}`)];
    await deliver(order.id, pack, codes);

    const printed = await client.post(`/api/orders/${order.id}/codes/release`, {
      cookie: shop.cookie,
      body: { purpose: 'print' },
    });
    expect(printed.headers.get('cache-control')).toBe('no-store');
    const released = await json<{ codes: { position: number; code: string }[] }>(printed, 200);
    expect(released.codes.map((code) => code.code)).toEqual(codes);

    const exported = await client.post(`/api/orders/${order.id}/codes/release`, {
      cookie: shop.cookie,
      body: { purpose: 'export' },
    });
    expect(exported.status).toBe(200);
    expect(exported.headers.get('content-type')).toContain('spreadsheetml');
    expect(exported.headers.get('content-disposition')).toBe(
      `attachment; filename="codes-${order.number}.xlsx"`,
    );
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(
      Buffer.from(await exported.arrayBuffer()) as unknown as Parameters<
        typeof workbook.xlsx.load
      >[0],
    );
    const sheet = workbook.worksheets[0];
    expect(sheet?.views[0]?.rightToLeft).toBe(true);
    // CR2: every cell is a value; a code that looks like a formula stays text.
    const first = sheet?.getRow(2);
    expect(first?.getCell(4).value).toBe('=HYPERLINK("x")');
    expect(first?.getCell(4).formula).toBeUndefined();
    expect(first?.getCell(1).value).toBe(order.number);

    const view = await json<{ codeReleases: { purpose: string; positions: number[] }[] }>(
      await client.get(`/api/orders/${order.id}`, { cookie: shop.cookie }),
      200,
    );
    expect(view.codeReleases.map((entry) => [entry.purpose, entry.positions.length])).toEqual([
      ['export', 12],
      ['print', 12],
    ]);

    // CR3: releases and single reveals share 20 per 10 minutes.
    await test.db.execute(
      sql`update customer_rate_limits set count = 20 where key = ${`reveal:customer:${shop.id}`}`,
    );
    expect(
      await json(
        await client.post(`/api/orders/${order.id}/codes/release`, {
          cookie: shop.cookie,
          body: { purpose: 'copy' },
        }),
        429,
      ),
    ).toMatchObject({ code: 'RATE_LIMITED' });
    const codeId = (
      await json<{ codes: { id: string }[] }>(
        await client.get(`/api/orders/${order.id}`, { cookie: shop.cookie }),
        200,
      )
    ).codes[0]?.id;
    const reveal = await client.post(`/api/orders/${order.id}/codes/${codeId}/reveal`, {
      cookie: shop.cookie,
    });
    expect(reveal.status).toBe(429);
  });
});

describe('the verification page and the logo upload (S21 VF3, BR3)', () => {
  it('refuses the 61st verification of a minute from one address', async () => {
    const ip = `198.51.100.${Math.floor(Math.random() * 200) + 20}`;
    let last = 0;
    for (let index = 0; index < 61; index += 1) {
      last = (await client.get(`/api/verify/${'B'.repeat(22)}`, { ip, origin: null })).status;
    }
    expect(last).toBe(429);
  });

  it('keeps the logo upload to merchants who are not frozen', async () => {
    const form = () => {
      const body = new FormData();
      body.append('file', new Blob([new Uint8Array([1, 2, 3])], { type: 'image/png' }), 'a.png');
      return body;
    };
    expect((await client.post('/api/merchant/logo', { form: form() })).status).toBe(401);
    const person = await buyer(0);
    const customerAnswer = await client.post('/api/merchant/logo', {
      cookie: person.cookie,
      form: form(),
    });
    expect(await json(customerAnswer, 403)).toMatchObject({ code: 'NOT_MERCHANT' });
    const shop = await merchant(0);
    const invalid = await client.post('/api/merchant/logo', { cookie: shop.cookie, form: form() });
    expect(await json(invalid, 400)).toMatchObject({ code: 'IMAGE_INVALID' });
    await test.db.update(customers).set({ frozenAt: new Date() }).where(eq(customers.id, shop.id));
    const frozen = await client.post('/api/merchant/logo', { cookie: shop.cookie, form: form() });
    expect(await json(frozen, 403)).toMatchObject({ code: 'ACCOUNT_FROZEN' });
  });
});
