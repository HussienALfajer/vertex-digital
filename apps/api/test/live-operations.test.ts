import { randomBytes, randomUUID } from 'node:crypto';
import { priceFromCost } from '@vertex-digital/contracts';
import {
  applyOutcome,
  catalogCategories,
  ensureCustomerWallet,
  ensureSystemAccount,
  fulfilmentAttempts,
  lockOrder,
  newId,
  orderCodesKey,
  postJournal,
  supplierBalanceReads,
  supplierOffers,
  suppliers,
  transitionOrder,
} from '@vertex-digital/db';
import { eq, inArray, sql } from 'drizzle-orm';
import sharp from 'sharp';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { parseEnv } from '../src/core/config/env.js';
import { NotificationStreamService } from '../src/modules/notifications/notification-stream.service.js';
import {
  api,
  auditOf,
  body,
  openEventStream,
  PASSWORD,
  removeAccounts,
  seedCustomer,
  setSwitches,
  totp,
} from './helpers.js';
import { startApp, type TestApp } from './start-app.js';

/*
 * Live operations (S11) over HTTP against the test database: the live board, route options,
 * reroute, the delivery proof and the manual fulfil, the extended refund, the admin stream and
 * the dashboard. The worker's routing is played by writing attempts as `orders.fulfil` does.
 * Categories are archived in `afterAll`; orders and ledger rows stay (never deleted, by design).
 */

let test: TestApp;
let client: ReturnType<typeof api>;
let admin: Awaited<ReturnType<ReturnType<typeof api>['adminWithTotp']>>;
const seeded: string[] = [];
const categories: string[] = [];
const run = randomBytes(4).toString('hex');
const usd = (dollars: number) => Math.round(dollars * 1_000_000);
const RULE = { percentBp: 1000, fixedUsdUnits: 0, minMarginUsdUnits: usd(0.1) };
const ids = { fake: '', gameId: '', otherGameId: '' };

interface Item {
  id: string;
  price: number;
  routeId: string;
  offerId: string;
  cost: number;
  manualRouteId: string;
}

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

const adminGet = (path: string) => client.get(path, { cookie: admin.cookie });
const adminPost = (path: string, payload?: unknown, key: string = randomUUID()) =>
  client.post(path, {
    cookie: admin.cookie,
    body: payload,
    headers: { 'idempotency-key': key },
  });

async function game(slug: string) {
  const created = await json<{ id: string }>(
    await client.post('/api/admin/catalog/games', {
      cookie: admin.cookie,
      body: { categoryId: categories[0], slug, nameAr: `لعبة ${slug}`, nameEn: 'Game' },
    }),
    201,
  );
  return created.id;
}

/** A top-up of `gameId` routed to a fake offer at $0.88 and to the manual supplier at $0.85. */
async function product(gameId = ids.gameId): Promise<Item> {
  await test.db.execute(sql`update catalog_games set status = 'paused' where id = ${gameId}`);
  const created = await json<{ id: string }>(
    await client.post(`/api/admin/catalog/games/${gameId}/products`, {
      cookie: admin.cookie,
      body: { kind: 'direct', nameAr: `باقة ${randomBytes(3).toString('hex')}` },
    }),
    201,
  );
  const now = new Date();
  const cost = usd(0.88);
  const [offer] = await test.db
    .insert(supplierOffers)
    .values({
      supplierId: ids.fake,
      offerId: `o-${randomBytes(4).toString('hex')}`,
      name: 'Fake offer',
      kind: 'direct',
      requiredFields: ['playerId'],
      costUsdUnits: cost,
      inStock: true,
      costConfirmedAt: now,
      lastSeenAt: now,
    })
    .returning({ id: supplierOffers.id });
  const routed = await json<{ routes: { id: string }[] }>(
    await client.post(`/api/admin/catalog/products/${created.id}/routes`, {
      cookie: admin.cookie,
      body: { offerId: offer?.id, fieldMap: { playerId: 'player_id' } },
    }),
    201,
  );
  const manual = await json<{ routes: { id: string; supplierCode: string }[] }>(
    await client.post(`/api/admin/catalog/products/${created.id}/routes/manual`, {
      cookie: admin.cookie,
      body: { costUsdUnits: usd(0.85) },
    }),
    201,
  );
  await test.db.execute(sql`update catalog_games set status = 'active' where id = ${gameId}`);
  return {
    id: created.id,
    price: priceFromCost(cost, RULE),
    routeId: routed.routes[0]?.id as string,
    offerId: offer?.id as string,
    cost,
    manualRouteId: manual.routes.find((route) => route.supplierCode === 'manual')?.id as string,
  };
}

async function buyer(options: { funds?: number; isTest?: boolean } = {}) {
  const customer = await seedCustomer(test.db, options.isTest ? { isTest: true } : {});
  seeded.push(customer.id);
  const funds = options.funds ?? usd(100);
  await test.db.transaction(async (tx) => {
    await postJournal(tx, {
      idempotencyKey: `test:${newId()}`,
      kind: 'adjustment',
      postings: [
        { accountId: await ensureCustomerWallet(tx, customer.id), amountUnits: funds },
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
  return { ...customer, cookie: await client.signInCustomer(customer.email) };
}

type Buyer = Awaited<ReturnType<typeof buyer>>;

const purchase = async (who: Buyer, item: Item) =>
  (
    await json<{ id: string }>(
      await client.post('/api/orders', {
        cookie: who.cookie,
        headers: { 'idempotency-key': randomUUID() },
        body: {
          productId: item.id,
          quantity: 1,
          fields: { player_id: '5123456789' },
          expectedUnitPriceUsdUnits: item.price,
          confirmPlayer: true,
        },
      }),
      201,
    )
  ).id;

const balance = async (who: Buyer) =>
  (
    await json<{ balanceUnits: number }>(
      await client.get('/api/wallet', { cookie: who.cookie }),
      200,
    )
  ).balanceUnits;

/** Sends the order to its fake route as `orders.fulfil` does: an attempt `sending`. */
async function send(orderId: string, item: Item) {
  return test.db.transaction(async (tx) => {
    const order = await lockOrder(tx, orderId);
    if (!order) throw new Error('No order');
    const id = newId();
    await tx.insert(fulfilmentAttempts).values({
      id,
      orderId,
      routeId: item.routeId,
      supplierId: ids.fake,
      offerId: item.offerId,
      supplierOfferId: 'o-test',
      quantity: 1,
      unitCostUsdUnits: item.cost,
      status: 'sending',
      candidates: [],
      sentAt: new Date(),
    });
    await transitionOrder(tx, order, 'sent_to_supplier', { actor: 'system', attemptId: id });
    return id;
  });
}

/** Held for the admin, as the sweep does past the hard limit (rule F7). */
async function held(who: Buyer, item: Item) {
  const orderId = await purchase(who, item);
  const attemptId = await send(orderId, item);
  await test.db.transaction(async (tx) => {
    const order = await lockOrder(tx, orderId);
    if (!order) throw new Error('No order');
    await transitionOrder(tx, order, 'needs_review', { actor: 'system', reason: 'hard_limit' });
  });
  return { orderId, attemptId };
}

/** The supplier's delivery, applied as the worker does (rule F1). */
const deliver = (attemptId: string) =>
  test.db.transaction((tx) =>
    applyOutcome(
      tx,
      {
        jobs: { send: async () => null },
        codesKey: orderCodesKey(parseEnv().ORDER_CODES_SECRET as string),
        now: new Date(),
      },
      attemptId,
      { status: 'delivered', quantity: 1 },
      { by: 'webhook' },
    ),
  );

const image = () =>
  sharp(randomBytes(32 * 32 * 3), { raw: { width: 32, height: 32, channels: 3 } })
    .png()
    .toBuffer();

const form = (file: Buffer) => {
  const data = new FormData();
  data.set('file', new Blob([new Uint8Array(file)]), 'proof.png');
  return data;
};

const uploadProof = async (orderId: string, file?: Buffer) =>
  client.post(`/api/admin/orders/${orderId}/proof`, {
    cookie: admin.cookie,
    form: form(file ?? (await image())),
  });

interface AdminOrder {
  status: string;
  decisions: Record<string, unknown>;
  attempts: {
    id: string;
    kind: string;
    status: string;
    chosenByAdmin: boolean;
    proofFileId: string | null;
    deliveryReference: string | null;
    unitCostUsdUnits: number;
    supplierCode: string;
  }[];
}

interface Board {
  columns: Record<string, { count: number; cards: { id: string; [key: string]: unknown }[] }>;
  awaitingBalance: number;
}

const board = async (query = '') =>
  json<Board>(await adminGet(`/api/admin/orders/live${query}`), 200);

const columnOf = (live: Board, orderId: string) =>
  Object.entries(live.columns).find(([, column]) =>
    column.cards.some((card) => card.id === orderId),
  )?.[0];

beforeAll(async () => {
  test = await startApp();
  client = api(test.url);
  admin = await client.adminWithTotp(test.db);
  seeded.push(admin.id);
  await reauthenticate();
  await setSwitches(test.db);
  const [fake] = await test.db.select().from(suppliers).where(eq(suppliers.code, 'fake'));
  ids.fake = fake?.id as string;
  await test.db
    .insert(supplierBalanceReads)
    .values({ supplierId: ids.fake, currency: 'USD', amountUnits: usd(1_000_000) });
  await json(
    await client.put('/api/admin/suppliers/fake/credentials', {
      cookie: admin.cookie,
      body: { values: { webhookSecret: `whsec-${run}-live` } },
    }),
    200,
  );
  await test.db.execute(
    sql`update supplier_sync_runs set status = 'failed', finished_at = now(), error_code = 'TEST'
        where supplier_id = ${ids.fake} and status = 'running'`,
  );
  const category = await json<{ id: string }>(
    await client.post('/api/admin/catalog/categories', {
      cookie: admin.cookie,
      body: { slug: `live-${run}`, nameAr: `مباشر ${run}` },
    }),
    201,
  );
  categories.push(category.id);
  await json(
    await client.put('/api/admin/pricing/rules', {
      cookie: admin.cookie,
      body: { scope: 'category', targetId: category.id, ...RULE },
    }),
    200,
  );
  ids.gameId = await game(`live-pubg-${run}`);
  ids.otherGameId = await game(`live-ff-${run}`);
  for (const gameId of [ids.gameId, ids.otherGameId]) {
    await json(
      await client.post(`/api/admin/catalog/games/${gameId}/fields`, {
        cookie: admin.cookie,
        body: {
          key: 'player_id',
          labelAr: 'المعرف',
          type: 'digits',
          required: true,
          minLength: 5,
        },
      }),
      201,
    );
  }
  await test.db.execute(
    sql`update catalog_games set status = 'active' where id in (${ids.gameId}, ${ids.otherGameId})`,
  );
});

afterAll(async () => {
  await test.db
    .update(catalogCategories)
    .set({ archivedAt: new Date() })
    .where(inArray(catalogCategories.id, categories));
  await setSwitches(test.db);
  await removeAccounts(test.db, seeded);
  await test.app.close();
});

describe('access (S11 "Access")', () => {
  it('admits only the admin, and asks a re-authentication for every action', async () => {
    const customer = await buyer();
    const orderId = await purchase(customer, await product());
    for (const path of [
      '/api/admin/orders/live',
      `/api/admin/orders/${orderId}/routes`,
      '/api/admin/dashboard',
      '/api/admin/stream',
    ]) {
      expect((await client.get(path)).status, path).toBe(401);
      expect((await client.get(path, { cookie: customer.cookie })).status, path).toBe(401);
    }
    expect((await client.get(`/api/admin/orders/${orderId}/proofs/${randomUUID()}`)).status).toBe(
      401,
    );
    for (const action of ['reroute', 'fulfil', 'proof', 'refund']) {
      const path = `/api/admin/orders/${orderId}/${action}`;
      const headers = { 'idempotency-key': randomUUID() };
      expect((await client.post(path, { body: {}, headers })).status, path).toBe(401);
      expect(
        (await client.post(path, { cookie: customer.cookie, body: {}, headers })).status,
        path,
      ).toBe(401);
    }
    await test.db.execute(
      sql`update admin_sessions set reauthenticated_at = now() - interval '6 minutes' where user_id = ${admin.id}`,
    );
    for (const [path, payload] of [
      [`/api/admin/orders/${orderId}/reroute`, { routeId: randomUUID(), reason: 'تحويل للتجربة' }],
      [
        `/api/admin/orders/${orderId}/fulfil`,
        { quantity: 1, unitCostUsdUnits: 0, proofFileId: randomUUID(), reason: 'تنفيذ للتجربة' },
      ],
    ] as const) {
      expect(await body(await adminPost(path, payload))).toMatchObject({
        status: 403,
        code: 'REAUTHENTICATION_REQUIRED',
      });
    }
    expect(await body(await uploadProof(orderId))).toMatchObject({
      status: 403,
      code: 'REAUTHENTICATION_REQUIRED',
    });
    await reauthenticate();
    // An unknown order, for each action.
    const unknown = randomUUID();
    for (const [path, payload] of [
      [`/api/admin/orders/${unknown}/reroute`, { routeId: randomUUID(), reason: 'تحويل للتجربة' }],
      [
        `/api/admin/orders/${unknown}/fulfil`,
        { quantity: 1, unitCostUsdUnits: 0, proofFileId: randomUUID(), reason: 'تنفيذ للتجربة' },
      ],
    ] as const) {
      expect(await body(await adminPost(path, payload))).toMatchObject({
        status: 404,
        code: 'NOT_FOUND',
      });
    }
    expect(await body(await uploadProof(unknown))).toMatchObject({
      status: 404,
      code: 'NOT_FOUND',
    });
  });
});

describe('the live board (rules LR1–LR3)', () => {
  it('places orders in their columns with filters, without fields, never cached', async () => {
    const real = await buyer();
    const tester = await buyer({ isTest: true });
    const item = await product();
    const other = await product(ids.otherGameId);
    const paid = await purchase(real, item);
    const { orderId: review } = await held(real, item);
    const testOrder = await purchase(tester, other);
    const delivered = await purchase(real, other);
    await deliver(await send(delivered, other));

    // Each game alone: the shared test database holds other files' unrouted paid orders, and a
    // column shows its oldest 100.
    const response = await adminGet(`/api/admin/orders/live?gameId=${ids.gameId}`);
    expect(response.headers.get('cache-control')).toBe('no-store');
    const live = (await response.json()) as Board;
    expect(columnOf(live, paid)).toBe('at_supplier');
    expect(columnOf(live, review)).toBe('review');
    expect(columnOf(live, delivered)).toBeUndefined();
    const card = live.columns.at_supplier?.cards.find((entry) => entry.id === paid);
    expect(card).toMatchObject({
      status: 'paid',
      isTest: false,
      customerEmail: real.email,
      attempt: null,
      slowAfterSeconds: 600,
    });
    expect(JSON.stringify(live)).not.toContain('5123456789');
    expect(live.columns.review?.cards.find((entry) => entry.id === review)).toMatchObject({
      attempt: { supplierCode: 'fake', status: 'sending' },
      slowAfterSeconds: null,
    });
    for (const column of Object.values(live.columns)) {
      expect(column.count).toBeGreaterThanOrEqual(column.cards.length);
    }

    const otherGame = `?gameId=${ids.otherGameId}`;
    const byGame = await board(otherGame);
    expect(columnOf(byGame, delivered)).toBe('finished');
    expect(columnOf(byGame, testOrder)).toBe('at_supplier');
    expect(columnOf(await board(`${otherGame}&test=hide`), testOrder)).toBeUndefined();
    const only = await board(`${otherGame}&test=only`);
    expect(columnOf(only, testOrder)).toBe('at_supplier');
    expect(columnOf(only, delivered)).toBeUndefined();
    const bySupplier = await board(`?gameId=${ids.gameId}&supplier=fake`);
    expect(columnOf(bySupplier, review)).toBe('review');
    expect(columnOf(bySupplier, paid)).toBeUndefined();
    expect(await body(await adminGet('/api/admin/orders/live?test=some'))).toMatchObject({
      status: 400,
      code: 'VALIDATION_FAILED',
    });
  });
});

describe('reroute (rules RR1–RR5)', () => {
  it('lists the routes, sends the order to the manual one once per key, and audits it', async () => {
    const customer = await buyer();
    const item = await product();
    const { orderId, attemptId } = await held(customer, item);
    const options = await json<{
      remainingUnits: number;
      routes: { routeId: string; eligible: boolean; skipReason: string | null }[];
    }>(await adminGet(`/api/admin/orders/${orderId}/routes`), 200);
    expect(options.remainingUnits).toBe(1);
    expect(options.routes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          routeId: item.routeId,
          eligible: false,
          skipReason: 'already_tried',
        }),
        expect.objectContaining({ routeId: item.manualRouteId, eligible: true, skipReason: null }),
      ]),
    );
    expect(
      await body(
        await adminPost(`/api/admin/orders/${orderId}/reroute`, {
          routeId: item.routeId,
          reason: 'المورد لا يجيب',
        }),
      ),
    ).toMatchObject({
      status: 409,
      code: 'ROUTE_NOT_ELIGIBLE',
      details: { reason: 'already_tried' },
    });

    const key = randomUUID();
    const reroute = () =>
      adminPost(
        `/api/admin/orders/${orderId}/reroute`,
        { routeId: item.manualRouteId, reason: 'المورد لا يجيب' },
        key,
      );
    const [first, second] = await Promise.all([reroute(), reroute()]);
    expect([first.status, second.status]).toEqual([200, 200]);
    const order = (await first.json()) as AdminOrder;
    expect(order.status).toBe('sent_to_supplier');
    expect(order.attempts[0]).toMatchObject({
      status: 'pending',
      chosenByAdmin: true,
      supplierCode: 'manual',
    });
    expect(order.attempts[1]).toMatchObject({ id: attemptId, status: 'failed' });
    expect(order.decisions).toMatchObject({ fulfil: true, reroute: true, refund: true });
    expect(columnOf(await board(), orderId)).toBe('manual');
    expect((await auditOf(test.db, orderId)).map((entry) => entry.action)).toContain(
      'order.rerouted',
    );

    // The key belongs to that reroute: as a fulfil, or on another order, it is refused.
    expect(
      await body(
        await adminPost(
          `/api/admin/orders/${orderId}/fulfil`,
          { quantity: 1, unitCostUsdUnits: 0, proofFileId: randomUUID(), reason: 'سلّمت يدوياً' },
          key,
        ),
      ),
    ).toMatchObject({ status: 409, code: 'IDEMPOTENCY_KEY_REUSED' });
    const other = await held(customer, await product());
    expect(
      await body(
        await adminPost(
          `/api/admin/orders/${other.orderId}/reroute`,
          { routeId: item.manualRouteId, reason: 'المورد لا يجيب' },
          key,
        ),
      ),
    ).toMatchObject({ status: 409, code: 'IDEMPOTENCY_KEY_REUSED' });

    // S08 D2 no longer delivers a manual attempt: the manual fulfil does (rule MF1).
    expect(
      await body(
        await adminPost(`/api/admin/orders/${orderId}/attempts/${order.attempts[0]?.id}/resolve`, {
          outcome: 'delivered',
          quantity: 1,
          reason: 'سلّمت يدوياً',
        }),
      ),
    ).toMatchObject({ status: 409, code: 'ATTEMPT_NOT_RESOLVABLE', details: { use: 'fulfil' } });
  });

  it('refuses the options and a reroute of an order that is not held, or unknown', async () => {
    const customer = await buyer();
    const item = await product();
    const orderId = await purchase(customer, item);
    expect(await body(await adminGet(`/api/admin/orders/${orderId}/routes`))).toMatchObject({
      status: 409,
      code: 'ORDER_NOT_DECIDABLE',
    });
    expect(
      await body(
        await adminPost(`/api/admin/orders/${orderId}/reroute`, {
          routeId: item.manualRouteId,
          reason: 'المورد لا يجيب',
        }),
      ),
    ).toMatchObject({ status: 409, code: 'ORDER_NOT_DECIDABLE' });
    expect((await adminGet(`/api/admin/orders/${randomUUID()}/routes`)).status).toBe(404);
    expect((await adminGet('/api/admin/orders/nope/routes')).status).toBe(404);
  });
});

describe('manual fulfil (rules MF1–MF6)', () => {
  it('takes a proof, refuses a loss until confirmed and wrong codes, then delivers once', async () => {
    const customer = await buyer();
    const item = await product();
    const { orderId } = await held(customer, item);
    expect(await body(await uploadProof(orderId, Buffer.from('not an image')))).toMatchObject({
      status: 400,
      code: 'IMAGE_INVALID',
    });
    const proof = await json<{ fileId: string }>(await uploadProof(orderId), 201);
    expect((await auditOf(test.db, orderId)).map((entry) => entry.action)).toContain(
      'order.proof_uploaded',
    );
    // An unused proof is never served.
    expect((await adminGet(`/api/admin/orders/${orderId}/proofs/${proof.fileId}`)).status).toBe(
      404,
    );
    const path = `/api/admin/orders/${orderId}/fulfil`;
    const base = { quantity: 1, proofFileId: proof.fileId, reason: 'سلّمت من مصدر آخر' };
    const above = item.price + 10_000;
    expect(await body(await adminPost(path, { ...base, unitCostUsdUnits: above }))).toMatchObject({
      status: 409,
      code: 'LOSS_NOT_CONFIRMED',
      details: { unitCostUsdUnits: above, unitPriceUsdUnits: item.price },
    });
    expect(
      await body(await adminPost(path, { ...base, unitCostUsdUnits: 0, codes: ['ABCDEFGH'] })),
    ).toMatchObject({ status: 400, code: 'CODES_COUNT_MISMATCH' });
    expect(
      await body(
        await adminPost(path, { ...base, unitCostUsdUnits: 0, proofFileId: randomUUID() }),
      ),
    ).toMatchObject({ status: 400, code: 'PROOF_INVALID' });
    expect(await body(await adminPost(path, { ...base, unitCostUsdUnits: 1 }))).toMatchObject({
      status: 400,
      code: 'VALIDATION_FAILED',
    });

    const key = randomUUID();
    const payload = {
      ...base,
      unitCostUsdUnits: above,
      acceptLoss: true,
      reference: 'OP-778',
    };
    const done = await json<AdminOrder>(await adminPost(path, payload, key), 200);
    expect(done.status).toBe('delivered');
    expect(done.attempts[0]).toMatchObject({
      kind: 'admin_fulfil',
      proofFileId: proof.fileId,
      deliveryReference: 'OP-778',
      unitCostUsdUnits: above,
    });
    expect((await adminPost(path, payload, key)).status).toBe(200);
    expect(
      await body(await adminPost(path, { ...payload, proofFileId: proof.fileId })),
    ).toMatchObject({ status: 409, code: 'ORDER_NOT_DECIDABLE' });
    const audit = await auditOf(test.db, orderId);
    expect(audit.find((entry) => entry.action === 'order.fulfilled_manually')?.details).toEqual({
      attemptId: done.attempts[0]?.id,
      case: 'review',
      units: 1,
      unitCostUsdUnits: above,
      lossAccepted: true,
      proofFileId: proof.fileId,
      hasReference: true,
      items: 0,
    });

    const served = await adminGet(`/api/admin/orders/${orderId}/proofs/${proof.fileId}`);
    expect(served.status).toBe(200);
    expect(served.headers.get('content-type')).toBe('image/webp');
    expect(served.headers.get('cache-control')).toBe('private, no-store');

    // The same proof on another order is refused.
    const other = await held(customer, item);
    expect(
      await body(
        await adminPost(`/api/admin/orders/${other.orderId}/fulfil`, {
          ...base,
          unitCostUsdUnits: 0,
        }),
      ),
    ).toMatchObject({ status: 400, code: 'PROOF_INVALID' });
    expect(
      (await adminGet(`/api/admin/orders/${other.orderId}/proofs/${proof.fileId}`)).status,
    ).toBe(404);
  });

  it('delivers an open manual attempt at its cost, and refuses a proof on a running order', async () => {
    const customer = await buyer();
    const item = await product();
    const { orderId } = await held(customer, item);
    const rerouted = await json<AdminOrder>(
      await adminPost(`/api/admin/orders/${orderId}/reroute`, {
        routeId: item.manualRouteId,
        reason: 'المورد لا يجيب',
      }),
      200,
    );
    const proof = await json<{ fileId: string }>(await uploadProof(orderId), 201);
    const done = await json<AdminOrder>(
      await adminPost(`/api/admin/orders/${orderId}/fulfil`, {
        quantity: 1,
        unitCostUsdUnits: usd(0.8),
        proofFileId: proof.fileId,
        reason: 'سلّمت من مصدر آخر',
      }),
      200,
    );
    expect(done.status).toBe('delivered');
    expect(done.attempts[0]).toMatchObject({
      id: rerouted.attempts[0]?.id,
      kind: 'routed',
      status: 'delivered',
      unitCostUsdUnits: usd(0.8),
      proofFileId: proof.fileId,
    });

    const running = await purchase(customer, item);
    expect(await body(await uploadProof(running))).toMatchObject({
      status: 409,
      code: 'ORDER_NOT_DECIDABLE',
    });
  });
});

describe('refund of a manual order (rule RF1)', () => {
  it('refunds an order waiting on the manual supplier, once', async () => {
    const customer = await buyer({ funds: usd(10) });
    const item = await product();
    const { orderId } = await held(customer, item);
    await json(
      await adminPost(`/api/admin/orders/${orderId}/reroute`, {
        routeId: item.manualRouteId,
        reason: 'المورد لا يجيب',
      }),
      200,
    );
    const refunded = await json<AdminOrder>(
      await adminPost(`/api/admin/orders/${orderId}/refund`, { reason: 'لا يتوفر الآن' }),
      200,
    );
    expect(refunded.status).toBe('refunded');
    expect(refunded.attempts[0]).toMatchObject({ supplierCode: 'manual', status: 'failed' });
    expect(await balance(customer)).toBe(usd(10));
    expect(
      await body(await adminPost(`/api/admin/orders/${orderId}/refund`, { reason: 'مرة ثانية' })),
    ).toMatchObject({ status: 409, code: 'ORDER_NOT_DECIDABLE' });
  });
});

describe('the admin stream (rule LR4)', () => {
  const openStream = (cookie = admin.cookie) =>
    openEventStream(client, cookie, '/api/admin/stream');

  it("forwards every order's status to the admin, never cached", async () => {
    const stream = await openStream();
    expect(stream.response.status).toBe(200);
    expect(stream.response.headers.get('content-type')).toContain('text/event-stream');
    expect(stream.response.headers.get('cache-control')).toBe('no-store');
    const customer = await buyer();
    const orderId = await purchase(customer, await product());
    await expect
      .poll(() => stream.events.find((event) => event.data.orderId === orderId))
      .toEqual({ event: 'order', data: { orderId, status: 'paid' } });
    await stream.close();
  });

  it('closes the oldest of 4 streams and a stream whose session ended', async () => {
    const other = await client.signInAdmin(admin.email, admin.secret);
    const streams = [];
    for (let index = 0; index < 4; index += 1)
      streams.push(await openStream(index ? admin.cookie : other));
    await streams[0]?.waitEnded();
    expect(streams.slice(1).map((stream) => stream.ended())).toEqual([false, false, false]);
    await Promise.all(streams.map((stream) => stream.close()));

    const ending = await openStream(other);
    const sessions = (await (
      await client.get('/api/admin/me/sessions', { cookie: admin.cookie })
    ).json()) as { id: string; current: boolean }[];
    for (const session of sessions.filter((entry) => !entry.current)) {
      await client.delete(`/api/admin/me/sessions/${session.id}`, { cookie: admin.cookie });
    }
    await test.app.get(NotificationStreamService).checkSessions();
    await ending.waitEnded();
  });

  it('refuses a 31st connect in a minute', async () => {
    let status = 0;
    for (let index = 0; index < 31 && status !== 429; index += 1) {
      const response = await client.get('/api/admin/stream', { cookie: admin.cookie });
      status = response.status;
      await response.body?.cancel();
    }
    expect(status).toBe(429);
  });
});

describe('the dashboard (rules DB1–DB8)', () => {
  interface Read {
    sales: { today: number; yesterday: number; deltaPercent: number | null };
    profit: { today: number };
    delivered: { today: number };
    refunds: { today: number };
    refundedUsd: { today: number };
    salesLine: { date: string; salesUsdUnits: number }[];
    now: { review: number };
    suppliers: { code: string }[];
    attention: { kind: string; count: number; target: string; params: Record<string, string> }[];
  }

  it('counts real customers’ money, and test orders in the live counts and attention', async () => {
    const before = await json<Read>(await adminGet('/api/admin/dashboard'), 200);
    expect(before.salesLine).toHaveLength(7);
    const real = await buyer();
    const tester = await buyer({ isTest: true });
    const item = await product();
    const sold = await purchase(real, item);
    await deliver(await send(sold, item));
    await deliver(await send(await purchase(tester, item), item));
    await held(tester, item);
    const refunded = await held(real, item);
    await json(
      await adminPost(`/api/admin/orders/${refunded.orderId}/refund`, { reason: 'لا جواب' }),
      200,
    );

    const response = await adminGet('/api/admin/dashboard');
    expect(response.headers.get('cache-control')).toBe('no-store');
    const after = (await response.json()) as Read;
    expect(after.sales.today - before.sales.today).toBe(item.price);
    expect(after.profit.today - before.profit.today).toBe(item.price - item.cost);
    expect(after.delivered.today - before.delivered.today).toBe(1);
    expect(after.refunds.today - before.refunds.today).toBe(1);
    expect(after.refundedUsd.today - before.refundedUsd.today).toBe(item.price);
    expect(
      (after.salesLine.at(-1)?.salesUsdUnits ?? 0) - (before.salesLine.at(-1)?.salesUsdUnits ?? 0),
    ).toBe(item.price);
    // The test customer's held order counts in the live counts and the attention list.
    expect(after.now.review - before.now.review).toBe(1);
    expect(after.attention.find((entry) => entry.kind === 'orders_review')).toMatchObject({
      target: '/orders/live',
    });
    expect(after.suppliers.map((supplier) => supplier.code)).toContain('fake');
  });

  it('lists an active stop with its link', async () => {
    await setSwitches(test.db, { purchases_stopped: true });
    const read = await json<Read>(await adminGet('/api/admin/dashboard'), 200);
    expect(read.attention).toContainEqual(
      expect.objectContaining({
        kind: 'switches_active',
        target: '/settings/switches',
        params: { switch: 'purchases_stopped' },
      }),
    );
    await setSwitches(test.db);
  });
});
