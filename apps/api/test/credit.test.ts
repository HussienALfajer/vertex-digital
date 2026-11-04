import { randomBytes, randomInt, randomUUID } from 'node:crypto';
import { rm } from 'node:fs/promises';
import { CREDIT_POLICY_DEFAULTS, priceFromCost } from '@vertex-digital/contracts';
import {
  catalogCategories,
  ensureCustomerWallet,
  ensureSystemAccount,
  newId,
  postJournal,
  supplierBalanceReads,
  supplierOffers,
  supplierSyncRuns,
  suppliers,
  telegramLinks,
} from '@vertex-digital/db';
import { and, eq, inArray, isNull, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { parseEnv } from '../src/core/config/env.js';
import { SupplierAdaptersService } from '../src/modules/suppliers/supplier-adapters.service.js';
import {
  api,
  auditOf,
  body,
  PASSWORD,
  removeAccounts,
  seedCustomer,
  setSwitches,
  totp,
} from './helpers.js';
import { startApp, type TestApp } from './start-app.js';

/*
 * S25 PR 1 over HTTP (the credit section with the fake supplier): the customer's limits, the
 * credit policy, a game's service class, `amount` products, a purchase by free amount to a
 * recipient line, and the admin's decision on a held cash order, each with its access cases. The
 * limits' counting and races are proven in `packages/db` (`orders/credit.test.ts`).
 */

let test: TestApp;
let client: ReturnType<typeof api>;
let admin: Awaited<ReturnType<ReturnType<typeof api>['adminWithTotp']>>;
const seeded: string[] = [];
const categories: string[] = [];
const run = randomBytes(4).toString('hex');
const usd = (dollars: number) => Math.round(dollars * 1_000_000);
/** 10%, $0.01 margin: one unit of 100 SYP costs $0.88 and sells at $0.97. */
const RULE = { percentBp: 1000, fixedUsdUnits: 0, minMarginUsdUnits: usd(0.01) };
const UNIT_COST = usd(0.88);
const UNIT_PRICE = priceFromCost(UNIT_COST, RULE);
const ids = { fake: '', credit: '', cash: '' };

async function json<T = Record<string, unknown>>(response: Response, status: number): Promise<T> {
  const payload = await response.json();
  expect(response.status, JSON.stringify(payload)).toBe(status);
  return payload as T;
}

async function reauthenticate() {
  await json(
    await client.post('/api/admin/me/reauthenticate', {
      cookie: admin.cookie,
      body: { password: PASSWORD, totpCode: totp(admin.secret) },
    }),
    200,
  );
}

const staleReauthentication = () =>
  test.db.execute(
    sql`update admin_sessions set reauthenticated_at = now() - interval '6 minutes' where user_id = ${admin.id}`,
  );

const adminPost = (path: string, payload?: unknown) =>
  client.post(path, { cookie: admin.cookie, body: payload });
const adminPut = (path: string, payload?: unknown) =>
  client.put(path, { cookie: admin.cookie, body: payload });

/** A section game with its one `mtn_number` field, paused until its product is routed. */
async function sectionGame(slug: string) {
  const game = await json<{ id: string }>(
    await adminPost('/api/admin/catalog/games', {
      categoryId: categories[0],
      slug,
      nameAr: `رصيد ${slug}`,
      nameEn: 'Credit',
    }),
    201,
  );
  await json(
    await adminPost(`/api/admin/catalog/games/${game.id}/fields`, {
      key: 'recipient',
      labelAr: 'الرقم',
      type: 'mtn_number',
      required: true,
    }),
    201,
  );
  return game.id;
}

/** An `amount` product of 10–1000 units routed to a fake `@100` offer of the same bounds. */
async function amountProduct(gameId: string): Promise<{ id: string; price: number }> {
  await test.db.execute(sql`update catalog_games set status = 'paused' where id = ${gameId}`);
  const created = await json<{ id: string; minQuantity: number; amountStep: number }>(
    await adminPost(`/api/admin/catalog/games/${gameId}/products`, {
      kind: 'amount',
      nameAr: `مبلغ ${randomBytes(3).toString('hex')}`,
      minQuantity: 10,
    }),
    201,
  );
  expect(created).toMatchObject({
    kind: 'amount',
    minQuantity: 10,
    maxQuantity: 1_000,
    amountStep: 100,
    amountUnitAr: 'ل.س',
  });
  const now = new Date();
  const [offer] = await test.db
    .insert(supplierOffers)
    .values({
      supplierId: ids.fake,
      offerId: `o-${randomBytes(4).toString('hex')}@100`,
      name: 'Fake amount',
      kind: 'amount',
      requiredFields: ['playerId'],
      costUsdUnits: UNIT_COST,
      minQuantity: 10,
      maxQuantity: 1_000,
      inStock: true,
      costConfirmedAt: now,
      lastSeenAt: now,
    })
    .returning({ id: supplierOffers.id });
  await json(
    await adminPost(`/api/admin/catalog/products/${created.id}/routes`, {
      offerId: offer?.id,
      fieldMap: { playerId: 'recipient' },
    }),
    201,
  );
  await test.db.execute(sql`update catalog_games set status = 'active' where id = ${gameId}`);
  return { id: created.id, price: UNIT_PRICE };
}

/** A customer whose funds are an old-enough credit (a refund: CS1 counts deposits only). */
async function customer(funds = 0) {
  const seededCustomer = await seedCustomer(test.db);
  seeded.push(seededCustomer.id);
  if (funds > 0) {
    await test.db.transaction(async (tx) => {
      await postJournal(tx, {
        idempotencyKey: `test:${newId()}`,
        kind: 'refund',
        postings: [
          { accountId: await ensureCustomerWallet(tx, seededCustomer.id), amountUnits: funds },
          {
            accountId: await ensureSystemAccount(tx, {
              code: 'adjustments:test_funds',
              kind: 'adjustments',
              currency: 'USD',
            }),
            amountUnits: -funds,
          },
        ],
      });
    });
  }
  return { ...seededCustomer, cookie: await client.signInCustomer(seededCustomer.email) };
}

const number = () => `095${String(Math.floor(Math.random() * 10_000_000)).padStart(7, '0')}`;

const purchase = (
  cookie: string,
  item: { id: string; price: number },
  quantity: number,
  recipient: string,
) =>
  client.post('/api/orders', {
    cookie,
    headers: { 'idempotency-key': randomUUID() },
    body: {
      productId: item.id,
      quantity,
      fields: { recipient },
      expectedUnitPriceUsdUnits: item.price,
    },
  });

beforeAll(async () => {
  await rm(parseEnv().FAKE_SUPPLIER_STATE_FILE, { force: true });
  test = await startApp();
  client = api(test.url);
  admin = await client.adminWithTotp(test.db);
  seeded.push(admin.id);
  await reauthenticate();
  await setSwitches(test.db);
  vi.spyOn(SupplierAdaptersService.prototype, 'recordCall').mockImplementation(async () => {});
  const [fake] = await test.db.select().from(suppliers).where(eq(suppliers.code, 'fake'));
  ids.fake = fake?.id as string;
  await test.db
    .insert(supplierBalanceReads)
    .values({ supplierId: ids.fake, currency: 'USD', amountUnits: usd(1_000_000) });
  await json(
    await adminPut('/api/admin/suppliers/fake/credentials', {
      values: { webhookSecret: `whsec-${run}-credit` },
    }),
    200,
  );
  await test.db
    .update(supplierSyncRuns)
    .set({ status: 'failed', finishedAt: new Date(), errorCode: 'TEST' })
    .where(and(eq(supplierSyncRuns.supplierId, ids.fake), eq(supplierSyncRuns.status, 'running')));
  const category = await json<{ id: string }>(
    await adminPost('/api/admin/catalog/categories', {
      slug: `credit-${run}`,
      nameAr: `الرصيد ${run}`,
    }),
    201,
  );
  categories.push(category.id);
  await json(
    await adminPut('/api/admin/pricing/rules', {
      scope: 'category',
      targetId: category.id,
      ...RULE,
    }),
    200,
  );
  ids.credit = await sectionGame(`credit-${run}`);
  ids.cash = await sectionGame(`cash-${run}`);
});

afterAll(async () => {
  vi.restoreAllMocks();
  await test.db
    .update(catalogCategories)
    .set({ archivedAt: new Date() })
    .where(inArray(catalogCategories.id, categories));
  await reauthenticate();
  await adminPut('/api/admin/credit-policy', CREDIT_POLICY_DEFAULTS);
  await setSwitches(test.db);
  await removeAccounts(test.db, seeded);
  await test.app.close();
});

describe('PUT /api/admin/catalog/games/:id/service-class (CL1)', () => {
  it('needs one required field and a re-authentication, and is audited', async () => {
    const path = `/api/admin/catalog/games/${ids.credit}/service-class`;
    const set = await json<{ serviceClass: string }>(
      await adminPut(path, { serviceClass: 'credit' }),
      200,
    );
    expect(set.serviceClass).toBe('credit');
    expect((await auditOf(test.db, ids.credit)).map((entry) => entry.action)).toContain(
      'catalog_game.service_class_set',
    );
    await json(
      await adminPut(`/api/admin/catalog/games/${ids.cash}/service-class`, {
        serviceClass: 'cash',
      }),
      200,
    );
    // A second field is refused in a section game.
    expect(
      await body(
        await adminPost(`/api/admin/catalog/games/${ids.credit}/fields`, {
          key: 'zone',
          labelAr: 'المنطقة',
          type: 'digits',
          required: false,
        }),
      ),
    ).toMatchObject({ status: 409, code: 'CATALOG_LIMIT_REACHED' });
    const plain = await json<{ id: string }>(
      await adminPost('/api/admin/catalog/games', {
        categoryId: categories[0],
        slug: `plain-${run}`,
        nameAr: `عادية ${run}`,
        nameEn: 'Plain',
      }),
      201,
    );
    expect(
      await body(
        await adminPut(`/api/admin/catalog/games/${plain.id}/service-class`, {
          serviceClass: 'cash',
        }),
      ),
    ).toMatchObject({ status: 400, code: 'VALIDATION_FAILED' });
    await staleReauthentication();
    expect(await body(await adminPut(path, { serviceClass: 'none' }))).toMatchObject({
      status: 403,
      code: 'REAUTHENTICATION_REQUIRED',
    });
    await reauthenticate();
    const buyer = await customer();
    expect(
      (await client.put(path, { cookie: buyer.cookie, body: { serviceClass: 'none' } })).status,
    ).toBe(401);
  });
});

describe('amount products and purchases (AM1–AM6, RN1, CL2)', () => {
  it('sells a typed amount to a normalised number and refuses past the section cap', async () => {
    // The fewest units and the unit are refused on another kind.
    const direct = await json<{ id: string }>(
      await adminPost(`/api/admin/catalog/games/${ids.credit}/products`, {
        kind: 'direct',
        nameAr: `باقة ${run}`,
      }),
      201,
    );
    expect(
      await body(
        await client.patch(`/api/admin/catalog/products/${direct.id}`, {
          cookie: admin.cookie,
          body: { minQuantity: 2 },
        }),
      ),
    ).toMatchObject({ status: 400, code: 'VALIDATION_FAILED' });
    const item = await amountProduct(ids.credit);

    const buyer = await customer(usd(100));
    const created = await json<Record<string, unknown>>(
      await purchase(buyer.cookie, item, 40, '+963 955 123 456'),
      201,
    );
    expect(created).toMatchObject({
      quantity: 40,
      totalUsdUnits: UNIT_PRICE * 40,
      recipient: '0955123456',
      cashHold: null,
      product: { kind: 'amount', amountStep: 100, amountUnitAr: 'ل.س' },
    });
    expect(await body(await purchase(buyer.cookie, item, 10, '0933123456'))).toMatchObject({
      status: 400,
      code: 'VALIDATION_FAILED',
    });
    const limits = await json<{ sectionRemainingUsdUnits: number }>(
      await client.get('/api/credit-limits', { cookie: buyer.cookie }),
      200,
    );
    expect(limits.sectionRemainingUsdUnits).toBe(usd(50) - UNIT_PRICE * 40);
    expect(await body(await purchase(buyer.cookie, item, 13, number()))).toMatchObject({
      status: 409,
      code: 'CREDIT_DAILY_LIMIT',
      details: { remainingUsdUnits: usd(50) - UNIT_PRICE * 40 },
    });
  });
});

describe('GET /api/credit-limits', () => {
  it('answers the signed-in customer only, never cached', async () => {
    const buyer = await customer();
    const response = await client.get('/api/credit-limits', { cookie: buyer.cookie });
    expect(response.headers.get('cache-control')).toBe('private, no-store');
    expect(await json(response, 200)).toEqual({
      sectionRemainingUsdUnits: usd(50),
      cashRemainingUsdUnits: usd(20),
      cashEligibleUsdUnits: 0,
      cashEligibleMoreAt: null,
    });
    expect((await client.get('/api/credit-limits')).status).toBe(401);
    expect((await client.get('/api/credit-limits', { cookie: admin.cookie })).status).toBe(401);
  });
});

describe('the credit policy', () => {
  it('reads and changes the policy with a re-authentication, audited', async () => {
    expect(
      await json(await client.get('/api/admin/credit-policy', { cookie: admin.cookie }), 200),
    ).toEqual(CREDIT_POLICY_DEFAULTS);
    const changed = { ...CREDIT_POLICY_DEFAULTS, recipientDailyOrdersRetail: 3 };
    expect(await json(await adminPut('/api/admin/credit-policy', changed), 200)).toEqual(changed);
    const [entry] = await test.db
      .execute<{ action: string; details: { before: unknown } }>(
        sql`select action, details from audit_entries where action = 'credit_policy.set'
          order by occurred_at desc limit 1`,
      )
      .then((result) => result.rows);
    expect(entry?.details.before).toEqual(CREDIT_POLICY_DEFAULTS);
    expect(
      await body(
        await adminPut('/api/admin/credit-policy', { ...changed, cashBalanceAgeHours: 721 }),
      ),
    ).toMatchObject({ status: 400, code: 'VALIDATION_FAILED' });
    await staleReauthentication();
    expect(await body(await adminPut('/api/admin/credit-policy', changed))).toMatchObject({
      status: 403,
      code: 'REAUTHENTICATION_REQUIRED',
    });
    await reauthenticate();
    await json(await adminPut('/api/admin/credit-policy', CREDIT_POLICY_DEFAULTS), 200);
    const buyer = await customer();
    expect((await client.get('/api/admin/credit-policy', { cookie: buyer.cookie })).status).toBe(
      401,
    );
  });
});

describe('POST /api/admin/orders/:id/cash-approval (CS3, CS4)', () => {
  it('holds a cash order above $10, approves it once, and rejects another with a refund', async () => {
    const item = await amountProduct(ids.cash);
    const buyer = await customer(usd(40));
    const held = await json<{ id: string; cashHold: string }>(
      await purchase(buyer.cookie, item, 11, number()),
      201,
    );
    expect(held.cashHold).toBe('held');
    const view = await json<{ cashHold: { state: string; telegramDecides: boolean } }>(
      await client.get(`/api/admin/orders/${held.id}`, { cookie: admin.cookie }),
      200,
    );
    expect(view.cashHold).toMatchObject({ state: 'held', telegramDecides: true });
    expect(
      (
        await json<{ cashHeld: number }>(
          await client.get('/api/admin/orders/counts', { cookie: admin.cookie }),
          200,
        )
      ).cashHeld,
    ).toBeGreaterThan(0);

    const path = `/api/admin/orders/${held.id}/cash-approval`;
    expect(
      (await client.post(path, { cookie: buyer.cookie, body: { decision: 'approve' } })).status,
    ).toBe(401);
    await staleReauthentication();
    expect(await body(await adminPost(path, { decision: 'approve' }))).toMatchObject({
      status: 403,
      code: 'REAUTHENTICATION_REQUIRED',
    });
    await reauthenticate();
    const approved = await json<{ status: string; cashHold: { state: string } }>(
      await adminPost(path, { decision: 'approve' }),
      200,
    );
    expect(approved).toMatchObject({ status: 'paid', cashHold: { state: 'approved' } });
    expect((await auditOf(test.db, held.id)).map((entry) => entry.action)).toContain(
      'order.cash_approved',
    );
    expect(await body(await adminPost(path, { decision: 'reject' }))).toMatchObject({
      status: 409,
      code: 'ORDER_NOT_DECIDABLE',
    });

    const other = await customer(usd(20));
    const second = await json<{ id: string }>(
      await purchase(other.cookie, item, 11, number()),
      201,
    );
    const rejected = await json<{ status: string; refundReason: string }>(
      await adminPost(`/api/admin/orders/${second.id}/cash-approval`, {
        decision: 'reject',
        reason: 'حساب جديد',
      }),
      200,
    );
    expect(rejected).toMatchObject({ status: 'refunded', refundReason: 'cash_rejected' });
    expect(
      await body(
        await adminPost(`/api/admin/orders/${randomUUID()}/cash-approval`, {
          decision: 'approve',
        }),
      ),
    ).toMatchObject({ status: 404 });
  });
});

describe("the bot's cash buttons (CS4)", () => {
  const SECRET = 'test-webhook-secret-0123456789abcdef';
  const chat = 7_000_000_000 + randomInt(1_000_000_000);
  let nextUpdate = Date.now() * 1000 + 700_000;
  const webhook = (payload: unknown) =>
    fetch(`${test.url}/api/webhooks/telegram`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-telegram-bot-api-secret-token': SECRET },
      body: JSON.stringify(payload),
    });
  const tap = async (data: string, from = chat): Promise<string | undefined> => {
    nextUpdate += 1;
    const response = await webhook({
      update_id: nextUpdate,
      callback_query: {
        id: `q${nextUpdate}`,
        from: { id: from, username: `owner${from}` },
        message: { message_id: 2, chat: { id: from, type: 'private' } },
        data,
      },
    });
    expect(response.status).toBe(200);
    const text = await response.text();
    return text ? (JSON.parse(text) as { text?: string }).text : undefined;
  };

  it('decides within the ceiling once, sends the panel above it, ignores another chat', async () => {
    await test.db
      .update(telegramLinks)
      .set({ unlinkedAt: new Date() })
      .where(isNull(telegramLinks.unlinkedAt));
    const code = await json<{ deepLink: string }>(
      await adminPost('/api/admin/telegram/link-code'),
      201,
    );
    nextUpdate += 1;
    await webhook({
      update_id: nextUpdate,
      message: {
        message_id: 1,
        from: { id: chat, username: `owner${chat}` },
        chat: { id: chat, type: 'private' },
        text: `/start ${new URL(code.deepLink).searchParams.get('start')}`,
      },
    });
    try {
      const item = await amountProduct(ids.cash);
      const order = async () => {
        const buyer = await customer(usd(20));
        return (await json<{ id: string }>(await purchase(buyer.cookie, item, 11, number()), 201))
          .id;
      };
      const first = await order();
      expect(await tap(`ca:${first}`, chat + 1)).toBeUndefined();
      expect(await tap(`ca:${first}`)).toBe('تمت الموافقة، يُرسل الطلب الآن.');
      expect(await tap(`cr:${first}`)).toBe('تم البت فيه مسبقاً.');
      const decided = await json<{ cashHold: { state: string } }>(
        await client.get(`/api/admin/orders/${first}`, { cookie: admin.cookie }),
        200,
      );
      expect(decided.cashHold.state).toBe('approved');

      const second = await order();
      await reauthenticate();
      await json(
        await adminPut('/api/admin/credit-policy', {
          ...CREDIT_POLICY_DEFAULTS,
          cashTelegramCeilingUsdUnits: usd(10),
        }),
        200,
      );
      expect(await tap(`ca:${second}`)).toBe('فوق حد تيليجرام، قرّر من اللوحة.');
      const held = await json<{ cashHold: { state: string } }>(
        await client.get(`/api/admin/orders/${second}`, { cookie: admin.cookie }),
        200,
      );
      expect(held.cashHold.state).toBe('held');
    } finally {
      await reauthenticate();
      await adminPut('/api/admin/credit-policy', CREDIT_POLICY_DEFAULTS);
      await test.db
        .update(telegramLinks)
        .set({ unlinkedAt: new Date() })
        .where(isNull(telegramLinks.unlinkedAt));
    }
  });
});
