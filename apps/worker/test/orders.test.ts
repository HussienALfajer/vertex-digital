import { createHash, randomBytes } from 'node:crypto';
import { Logger } from '@nestjs/common';
import {
  CURRENCY_SCALE,
  ORDER_POLICY_DEFAULTS,
  QUEUES,
  STORE_SWITCH_DEFAULTS,
} from '@vertex-digital/contracts';
import {
  accountBalance,
  applyOutcome,
  bossJobSender,
  catalogCategories,
  createDatabase,
  customerNotifications,
  customers,
  emailOutbox,
  encryptCredentials,
  encryptSecret,
  ensureCustomerWallet,
  ensureSystemAccount,
  findCustomerWallet,
  fulfilmentAttempts,
  ledgerJournals,
  newId,
  orderCodes,
  orderCodesKey,
  orderEvents,
  orderPolicy,
  orders,
  postJournal,
  productPrices,
  productRoutes,
  purchaseOrder,
  repriceProducts,
  storeSwitchChanges,
  supplierBalanceReads,
  supplierCalls,
  supplierCredentials,
  supplierHealthChanges,
  supplierKey,
  supplierOffers,
  suppliers,
  supplierWebhookEvents,
  type Transaction,
  telegramMessages,
} from '@vertex-digital/db';
import {
  FakeSupplierAdapter,
  type FakeSupplierState,
  fakeSupplierStateSchema,
} from '@vertex-digital/suppliers';
import { and, desc, eq, inArray, isNull, sql } from 'drizzle-orm';
import pino from 'pino';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { parseEnv } from '../src/core/config/env.js';
import { LOG_REDACT_PATHS } from '../src/core/config/log-redact.js';
import type { PgBossService } from '../src/core/jobs/pg-boss.service.js';
import { OrdersFulfilJob } from '../src/jobs/orders/fulfil.job.js';
import { OrdersPollJob } from '../src/jobs/orders/poll.job.js';
import { OrdersSweepJob } from '../src/jobs/orders/sweep.job.js';
import { SupplierWebhookJob } from '../src/jobs/suppliers/webhook.job.js';
import type { SupplierRegistry } from '../src/suppliers/supplier-registry.js';
import { renderTelegramMessage } from '../src/telegram/messages.js';

/*
 * The order jobs (S08 rules R1–R6, F1–F8, MN1, MN2) against the test database with the in-process
 * fake supplier, its orders kept in memory as the worker keeps them in the state file. Each test
 * runs in a transaction that is rolled back, after moving other tests' routes off the fake offers
 * it uses and putting the fake supplier's credentials, health, balance and switch at known values.
 * The race test commits on purpose, with its own offer and new rows only.
 */

const connection = createDatabase(process.env.DATABASE_URL as string);
const { db } = connection;
const env = parseEnv();
const DOLLAR = CURRENCY_SCALE.USD;
const usd = (dollars: number) => Math.round(dollars * DOLLAR);
const RULE = { percentBp: 1000, fixedUsdUnits: 0, minMarginUsdUnits: usd(0.05) };
const run = randomBytes(4).toString('hex');
const unique = () => newId().replaceAll('-', '').slice(-12);
const WEBHOOK_SECRET = `whs-${run}-0123456789`;
const codesKey = orderCodesKey(env.ORDER_CODES_SECRET);

interface Sent {
  queue: string;
  data: Record<string, unknown>;
  options: Record<string, unknown> | undefined;
}
const sent: Sent[] = [];
const boss = {
  send: async (queue: string, data: Record<string, unknown>, options?: Record<string, unknown>) => {
    sent.push({ queue, data, options });
    return newId();
  },
  schedule: async () => {},
};
const pgBoss = { work: async () => {}, boss } as unknown as PgBossService;
const jobs = bossJobSender(boss as never);

/** The fake supplier's state, kept across calls as the worker keeps it in its file. */
let fakeState: FakeSupplierState = fakeSupplierStateSchema.parse({});
const registry = {
  fakeEnabled: true,
  connect: async () => ({
    adapter: new FakeSupplierAdapter({
      webhookSecret: WEBHOOK_SECRET,
      state: structuredClone(fakeState),
      onOrder: async (key, order) => {
        fakeState = { ...fakeState, orders: { ...fakeState.orders, [key]: order } };
      },
    }),
    secrets: [WEBHOOK_SECRET],
  }),
} as unknown as SupplierRegistry;
const script = (offerId: string, value: string) => {
  fakeState = fakeSupplierStateSchema.parse({
    ...fakeState,
    orderScripts: { ...fakeState.orderScripts, [offerId]: value },
  });
};

const fulfil = new OrdersFulfilJob(pgBoss, registry, db, env);
const poll = new OrdersPollJob(pgBoss, registry, db, env);
const sweep = new OrdersSweepJob(pgBoss, db);
const webhooks = new SupplierWebhookJob(pgBoss, registry, db, env);

const ids = { fake: '', manual: '' };
/** Every category made here; the race tests commit theirs, archived after all. */
const categories: string[] = [];

beforeAll(async () => {
  for (const row of await db.select({ id: suppliers.id, code: suppliers.code }).from(suppliers)) {
    if (row.code === 'fake' || row.code === 'manual') ids[row.code] = row.id;
  }
});

afterAll(async () => {
  // Committed products stay out of the store (the rate tests read the cheapest available one).
  await db
    .update(catalogCategories)
    .set({ archivedAt: new Date() })
    .where(inArray(catalogCategories.id, categories));
  await connection.close();
});

/** Runs `work` in a transaction that is always rolled back, from a known supplier state. */
async function isolated(work: (tx: Transaction) => Promise<void>): Promise<void> {
  const rollback = new Error('rollback');
  await expect(
    db.transaction(async (tx) => {
      await prepare(tx);
      await work(tx);
      throw rollback;
    }),
  ).rejects.toBe(rollback);
}

async function prepare(tx: Transaction): Promise<void> {
  sent.length = 0;
  fakeState = fakeSupplierStateSchema.parse({});
  await tx.insert(supplierCredentials).values({
    id: newId(),
    supplierId: ids.fake,
    ciphertext: encryptCredentials(supplierKey(env.SUPPLIER_KEYS_SECRET), ids.fake, {
      webhookSecret: WEBHOOK_SECRET,
    }),
    hints: {},
    adminId: newId(),
  });
  await tx.insert(supplierHealthChanges).values({
    id: newId(),
    supplierId: ids.fake,
    state: 'healthy',
    reason: 'test start',
  });
  await balance(tx, 1_000_000);
  await tx.insert(storeSwitchChanges).values([
    { id: newId(), switch: 'fake_paused', value: false, channel: 'admin', adminId: newId() },
    {
      id: newId(),
      switch: 'manual_paused',
      value: STORE_SWITCH_DEFAULTS.manual_paused,
      channel: 'admin',
      adminId: newId(),
    },
  ]);
  await tx.insert(orderPolicy).values({ id: newId(), ...ORDER_POLICY_DEFAULTS });
}

/** The fake supplier's newest balance read. */
async function balance(tx: Transaction, dollars: number) {
  await tx.insert(supplierBalanceReads).values({
    id: newId(),
    supplierId: ids.fake,
    currency: 'USD',
    amountUnits: usd(dollars),
  });
}

/** The fake offer row, live, at `cost`; other tests' live routes on it moved out of the way. */
async function fakeOffer(tx: Transaction, offerId: string, cost: number): Promise<string> {
  const [existing] = await tx
    .select({ id: supplierOffers.id })
    .from(supplierOffers)
    .where(and(eq(supplierOffers.supplierId, ids.fake), eq(supplierOffers.offerId, offerId)));
  const id = existing?.id ?? newId();
  const values = {
    inStock: true,
    costUsdUnits: cost,
    costConfirmedAt: new Date(),
    lastSeenAt: new Date(),
    missingSince: null,
    requiredFields:
      offerId.startsWith('fake-gift') || offerId.startsWith('fake-itunes') ? [] : ['playerId'],
  };
  if (existing) {
    await tx.update(supplierOffers).set(values).where(eq(supplierOffers.id, id));
    await tx
      .update(productRoutes)
      .set({ archivedAt: new Date() })
      .where(and(eq(productRoutes.offerId, id), isNull(productRoutes.archivedAt)));
  } else {
    await tx
      .insert(supplierOffers)
      .values({ id, supplierId: ids.fake, offerId, name: offerId, ...values });
  }
  return id;
}

interface Product {
  id: string;
  code: boolean;
  price: number;
  fakeRoute: string | null;
  manualRoute: string | null;
}

/**
 * An active product (a top-up with `player_id`, or a code product) with its own rule, a route to
 * the fake offer and, with `manualCost`, a manual route; priced from its routes.
 */
async function product(
  tx: Transaction,
  options: { code?: boolean; fake?: number | null; manualCost?: number; offerId?: string } = {},
): Promise<Product> {
  const [category, game, id] = [newId(), newId(), newId()];
  categories.push(category);
  const code = options.code ?? false;
  await tx.execute(sql`insert into catalog_categories (id, slug, name_ar, sort_order)
    values (${category}, ${`c-${unique()}`}, ${`فئة ${unique()}`}, 99)`);
  await tx.execute(sql`insert into catalog_games (id, category_id, slug, name_ar, name_en, status,
    sort_order) values (${game}, ${category}, ${`g-${unique()}`}, ${`لعبة ${unique()}`}, 'Game',
    'active', 1)`);
  if (!code) {
    await tx.execute(sql`insert into catalog_input_fields (id, game_id, key, label_ar, type,
      required, sort_order, min_length, max_length) values (${newId()}, ${game}, 'player_id',
      'المعرف', 'digits', true, 1, 5, 12)`);
  }
  await tx.execute(sql`insert into catalog_products (id, game_id, kind, name_ar, max_quantity,
    sort_order) values (${id}, ${game}, ${code ? 'code' : 'direct'}, ${`باقة ${unique()}`},
    ${code ? 10 : 1}, 1)`);
  await tx.execute(sql`insert into margin_rules (id, scope, target_id, percent_bp, fixed_usd_units,
    min_margin_usd_units) values (${newId()}, 'product', ${id}, ${RULE.percentBp},
    ${RULE.fixedUsdUnits}, ${RULE.minMarginUsdUnits})`);
  let fakeRoute: string | null = null;
  if (options.fake !== null) {
    const offerId = options.offerId ?? (code ? 'fake-gift-10' : 'fake-uc-60');
    const offer = await fakeOffer(tx, offerId, options.fake ?? usd(code ? 9.6 : 0.88));
    fakeRoute = newId();
    await tx.insert(productRoutes).values({
      id: fakeRoute,
      productId: id,
      supplierId: ids.fake,
      offerId: offer,
      fieldMap: code ? {} : { playerId: 'player_id' },
    });
  }
  let manualRoute: string | null = null;
  if (options.manualCost !== undefined) {
    const offer = newId();
    await tx.insert(supplierOffers).values({
      id: offer,
      supplierId: ids.manual,
      offerId: `m-${unique()}`,
      name: 'Manual',
      inStock: true,
      costUsdUnits: options.manualCost,
      costConfirmedAt: new Date(),
      lastSeenAt: new Date(),
    });
    manualRoute = newId();
    await tx.insert(productRoutes).values({
      id: manualRoute,
      productId: id,
      supplierId: ids.manual,
      offerId: offer,
      fieldMap: {},
    });
  }
  await repriceProducts(tx, {
    productIds: [id],
    cause: 'route_change',
    context: { now: new Date(), fakeEnabled: true },
  });
  const [price] = await tx
    .select({ units: productPrices.priceUsdUnits })
    .from(productPrices)
    .where(eq(productPrices.productId, id))
    .orderBy(desc(productPrices.createdAt), desc(productPrices.id))
    .limit(1);
  return { id, code, price: price?.units as number, fakeRoute, manualRoute };
}

async function customer(tx: Transaction, options: { isTest?: boolean } = {}) {
  const id = newId();
  await tx.insert(customers).values({
    id,
    name: 'Buyer',
    email: `${id}@test.vertex-digital.local`,
    phone: '+963900000000',
    emailVerified: true,
    isTest: options.isTest ?? false,
  });
  await postJournal(tx, {
    idempotencyKey: `test:${newId()}`,
    kind: 'adjustment',
    postings: [
      { accountId: await ensureCustomerWallet(tx, id), amountUnits: usd(100) },
      {
        accountId: await ensureSystemAccount(tx, {
          code: 'adjustments:test_funds',
          kind: 'adjustments',
          currency: 'USD',
        }),
        amountUnits: -usd(100),
      },
    ],
  });
  return id;
}

/** A paid order, through the pay step (rule O2). */
async function buy(
  tx: Transaction,
  item: Product,
  options: { quantity?: number; player?: string; isTest?: boolean } = {},
) {
  const buyer = await customer(tx, { isTest: options.isTest ?? false });
  const { order } = await purchaseOrder(
    tx,
    { jobs, now: new Date() },
    {
      customerId: buyer,
      productId: item.id,
      quantity: options.quantity ?? 1,
      fields: item.code ? {} : { player_id: options.player ?? '5123456789' },
      expectedUnitPriceUsdUnits: item.price,
      idempotencyKey: newId(),
      requestHash: createHash('sha256').update(newId()).digest('hex'),
      fakeEnabled: true,
      purchasesStopped: false,
      channel: 'store',
      whenBalanceShort: 'refuse',
      confirmPlayer: false,
      playerCheck: async () => null,
    },
  );
  return order;
}

const orderOf = async (tx: Transaction, id: string) =>
  (await tx.select().from(orders).where(eq(orders.id, id)))[0] as typeof orders.$inferSelect;

const attemptsOf = (tx: Transaction, orderId: string) =>
  tx
    .select()
    .from(fulfilmentAttempts)
    .where(eq(fulfilmentAttempts.orderId, orderId))
    .orderBy(fulfilmentAttempts.createdAt, fulfilmentAttempts.id);

const walletOf = async (tx: Transaction, customerId: string) =>
  accountBalance(tx, (await findCustomerWallet(tx, customerId)) as string);

const notificationsOf = (tx: Transaction, customerId: string) =>
  tx
    .select({ event: customerNotifications.event })
    .from(customerNotifications)
    .where(eq(customerNotifications.customerId, customerId));

const messagesOf = (tx: Transaction, keys: string[]) =>
  tx
    .select({
      kind: telegramMessages.kind,
      dedupeKey: telegramMessages.dedupeKey,
      params: telegramMessages.params,
    })
    .from(telegramMessages)
    .where(inArray(telegramMessages.dedupeKey, keys));

const queued = (queue: string, key: string, value: string) =>
  sent.filter((job) => job.queue === queue && job.data[key] === value);

describe('routing and sending (rules R1–R6, F1)', () => {
  it('sends to the first candidate, records the candidates and the call, and delivers', async () => {
    await isolated(async (tx) => {
      const item = await product(tx, { manualCost: usd(0.9) });
      const order = await buy(tx, item);
      const result = await fulfil.fulfil(order.id, tx);
      expect(result.kind).toBe('sent');
      const [attempt] = await attemptsOf(tx, order.id);
      expect(attempt).toMatchObject({
        routeId: item.fakeRoute,
        status: 'delivered',
        deliveredQuantity: 1,
        resolvedBy: 'supplier',
        supplierOfferId: 'fake-uc-60',
        unitCostUsdUnits: usd(0.88),
      });
      expect(attempt?.candidates).toEqual([
        expect.objectContaining({ routeId: item.fakeRoute, rank: 1, tier: 'healthy' }),
        expect.objectContaining({ routeId: item.manualRoute, rank: 2, tier: 'manual' }),
      ]);
      // The attempt id is the supplier's idempotency key (ADR 0004).
      expect(fakeState.orders[attempt?.id as string]?.request).toMatchObject({
        offerId: 'fake-uc-60',
        quantity: 1,
        fields: { playerId: '5123456789' },
      });
      expect(await orderOf(tx, order.id)).toMatchObject({
        status: 'delivered',
        deliveredQuantity: 1,
      });
      const calls = await tx
        .select({ operation: supplierCalls.operation, result: supplierCalls.result })
        .from(supplierCalls)
        .where(
          and(eq(supplierCalls.supplierId, ids.fake), sql`${supplierCalls.createdAt} >= now()`),
        );
      expect(calls).toContainEqual({ operation: 'place_order', result: 'ok' });
      const [cost] = await tx
        .select({ id: ledgerJournals.id })
        .from(ledgerJournals)
        .where(eq(ledgerJournals.idempotencyKey, `order:${order.id}:cost:${attempt?.id}`));
      expect(cost).toBeDefined();
      expect(await notificationsOf(tx, order.customerId)).toContainEqual({
        event: 'order_delivered',
      });
      // A second run finds a delivered order and does nothing (rule R1).
      expect(await fulfil.fulfil(order.id, tx)).toEqual({ kind: 'skipped' });
    });
  });

  it('stores one encrypted code per unit and never logs them (rule C1)', async () => {
    const logged: string[] = [];
    const capture = (...args: unknown[]) => {
      logged.push(JSON.stringify(args));
    };
    const spies = (['log', 'warn', 'error', 'debug', 'verbose'] as const).map((level) =>
      vi.spyOn(Logger.prototype, level).mockImplementation(capture),
    );
    try {
      await isolated(async (tx) => {
        const item = await product(tx, { code: true });
        const order = await buy(tx, item, { quantity: 2 });
        await fulfil.fulfil(order.id, tx);
        const [attempt] = await attemptsOf(tx, order.id);
        const kept = fakeState.orders[attempt?.id as string];
        const codes = (kept?.outcome as { codes?: string[] } | undefined)?.codes ?? [];
        expect(codes).toHaveLength(2);
        const stored = await tx.select().from(orderCodes).where(eq(orderCodes.orderId, order.id));
        expect(stored).toHaveLength(2);
        for (const row of stored) {
          for (const value of codes) expect(row.ciphertext.toString('utf8')).not.toContain(value);
        }
        expect(JSON.stringify(attempt?.result)).not.toContain('FAKE-');
        expect(await orderOf(tx, order.id)).toMatchObject({ status: 'delivered' });
        for (const value of codes) expect(logged.join('\n')).not.toContain(value);
      });
    } finally {
      for (const spy of spies) spy.mockRestore();
    }
  });

  it('redacts codes from the worker logs wherever they appear', () => {
    const lines: string[] = [];
    const logger = pino(
      { redact: LOG_REDACT_PATHS },
      { write: (line: string) => lines.push(line) },
    );
    logger.info({ codes: ['TOP-SECRET-1'], outcome: { codes: ['TOP-SECRET-2'] } }, 'outcome');
    logger.info({ job: { result: { codes: ['TOP-SECRET-3'] } } }, 'nested');
    expect(lines.join('')).not.toMatch(/TOP-SECRET/);
  });

  it('delivers part, then routes the rest to the manual route with its card (rule MN1)', async () => {
    await isolated(async (tx) => {
      const item = await product(tx, { code: true, manualCost: usd(9.7) });
      script('fake-gift-10', 'partial:2');
      const order = await buy(tx, item, { quantity: 3 });
      await fulfil.fulfil(order.id, tx);
      expect(await orderOf(tx, order.id)).toMatchObject({ status: 'failed', deliveredQuantity: 2 });
      expect(queued(QUEUES.ordersFulfil, 'orderId', order.id).length).toBeGreaterThanOrEqual(1);
      expect((await fulfil.fulfil(order.id, tx)).kind).toBe('sent');
      const [first, manual] = await attemptsOf(tx, order.id);
      expect(first).toMatchObject({ status: 'delivered', deliveredQuantity: 2 });
      expect(manual).toMatchObject({ routeId: item.manualRoute, status: 'pending', quantity: 1 });
      expect(manual?.candidates).toContainEqual(
        expect.objectContaining({ routeId: item.fakeRoute, skipReason: 'already_tried' }),
      );
      expect(manual?.nextPollAt).toBeNull();
      expect(await orderOf(tx, order.id)).toMatchObject({ status: 'sent_to_supplier' });
      const [card] = await messagesOf(tx, [`manual:${manual?.id}`]);
      expect(card).toMatchObject({ kind: 'manual_order' });
      expect(card?.params).toMatchObject({ orderNumber: order.number, quantity: 1 });
      expect(JSON.stringify(card?.params)).not.toContain('FAKE-');
      // Manual attempts are never polled (rule MN2).
      expect(await poll.poll(manual?.id as string, tx)).toBeNull();
    });
  });

  it('refunds the undelivered units when no route is left (rules R5, M3)', async () => {
    await isolated(async (tx) => {
      const item = await product(tx, { code: true });
      script('fake-gift-10', 'partial:2');
      const order = await buy(tx, item, { quantity: 3 });
      const before = await walletOf(tx, order.customerId);
      await fulfil.fulfil(order.id, tx);
      const result = await fulfil.fulfil(order.id, tx);
      expect(result.kind).toBe('refunded');
      expect(await orderOf(tx, order.id)).toMatchObject({
        status: 'partially_refunded',
        deliveredQuantity: 2,
        refundedQuantity: 1,
        refundedUsdUnits: item.price,
        refundReason: 'routes_exhausted',
      });
      expect(await walletOf(tx, order.customerId)).toBe(before + item.price);
      expect(await notificationsOf(tx, order.customerId)).toContainEqual({
        event: 'order_partially_refunded',
      });
    });
  });

  it('tries the next route after a definitive failure, then refunds in full', async () => {
    await isolated(async (tx) => {
      const item = await product(tx, { manualCost: usd(0.9) });
      script('fake-uc-60', 'failed');
      const order = await buy(tx, item);
      await fulfil.fulfil(order.id, tx);
      expect(await orderOf(tx, order.id)).toMatchObject({ status: 'failed' });
      // The manual route is archived meanwhile: nothing is left (edge case 9).
      await tx
        .update(productRoutes)
        .set({ archivedAt: new Date() })
        .where(eq(productRoutes.id, item.manualRoute as string));
      expect((await fulfil.fulfil(order.id, tx)).kind).toBe('refunded');
      expect(await orderOf(tx, order.id)).toMatchObject({
        status: 'refunded',
        refundedQuantity: 1,
        refundReason: 'routes_exhausted',
      });
      expect(await notificationsOf(tx, order.customerId)).toContainEqual({
        event: 'order_refunded',
      });
      const [failed] = await attemptsOf(tx, order.id);
      expect(failed).toMatchObject({ status: 'failed', supplierErrorCode: 'FAKE_REFUSED' });
    });
  });

  it('refunds at once with no route (paid → refunded, no_route)', async () => {
    await isolated(async (tx) => {
      const item = await product(tx);
      const order = await buy(tx, item);
      await tx
        .update(productRoutes)
        .set({ archivedAt: new Date() })
        .where(eq(productRoutes.id, item.fakeRoute as string));
      expect((await fulfil.fulfil(order.id, tx)).kind).toBe('refunded');
      expect(await orderOf(tx, order.id)).toMatchObject({
        status: 'refunded',
        refundReason: 'no_route',
      });
      expect(await attemptsOf(tx, order.id)).toHaveLength(0);
    });
  });

  it('refunds at once when the account is refused, without another route (rule F1)', async () => {
    await isolated(async (tx) => {
      const item = await product(tx, { manualCost: usd(0.9) });
      script('fake-uc-60', 'invalid');
      const order = await buy(tx, item);
      await fulfil.fulfil(order.id, tx);
      expect(await orderOf(tx, order.id)).toMatchObject({
        status: 'refunded',
        refundReason: 'input_rejected',
      });
      const attempts = await attemptsOf(tx, order.id);
      expect(attempts).toHaveLength(1);
      expect(attempts[0]).toMatchObject({ status: 'failed', inputRejected: true });
      expect(queued(QUEUES.ordersFulfil, 'orderId', order.id)).toHaveLength(1);
    });
  });

  it('skips a route the price paid no longer covers, and one the balance cannot pay (R2)', async () => {
    await isolated(async (tx) => {
      const item = await product(tx, { manualCost: usd(0.9) });
      const order = await buy(tx, item);
      // The fake's cost rose after payment: below the order's minimum margin.
      await tx
        .update(supplierOffers)
        .set({ costUsdUnits: usd(0.95) })
        .where(
          and(eq(supplierOffers.supplierId, ids.fake), eq(supplierOffers.offerId, 'fake-uc-60')),
        );
      await fulfil.fulfil(order.id, tx);
      const [manual] = await attemptsOf(tx, order.id);
      expect(manual).toMatchObject({ routeId: item.manualRoute, status: 'pending' });
      expect(manual?.candidates).toContainEqual(
        expect.objectContaining({ routeId: item.fakeRoute, skipReason: 'unprofitable' }),
      );

      const codes = await product(tx, { code: true, manualCost: usd(9.7) });
      const three = await buy(tx, codes, { quantity: 3 });
      await balance(tx, 20);
      await fulfil.fulfil(three.id, tx);
      const [held] = await attemptsOf(tx, three.id);
      expect(held).toMatchObject({ routeId: codes.manualRoute, quantity: 3 });
      expect(held?.candidates).toContainEqual(
        expect.objectContaining({ routeId: codes.fakeRoute, skipReason: 'balance_below_order' }),
      );
    });
  });

  it('routes a test customer to the fake and manual suppliers (rule R4)', async () => {
    await isolated(async (tx) => {
      const item = await product(tx);
      const order = await buy(tx, item, { isTest: true });
      expect(order.isTest).toBe(true);
      await fulfil.fulfil(order.id, tx);
      expect(await orderOf(tx, order.id)).toMatchObject({ status: 'delivered' });
    });
  });
});

describe('polling, the hard limit and the sweep (rules F3, F6, F7)', () => {
  it('schedules the first poll of a pending attempt and applies its result', async () => {
    await isolated(async (tx) => {
      const item = await product(tx);
      script('fake-uc-60', 'pending');
      const order = await buy(tx, item);
      await fulfil.fulfil(order.id, tx);
      const [attempt] = await attemptsOf(tx, order.id);
      expect(attempt).toMatchObject({ status: 'pending' });
      const sentAt = attempt?.sentAt as Date;
      expect(attempt?.nextPollAt?.getTime()).toBe(sentAt.getTime() + 60_000);
      const [job] = queued(QUEUES.ordersPoll, 'attemptId', attempt?.id as string);
      expect(job?.options).toMatchObject({ singletonKey: attempt?.id });
      // Still pending at the supplier: polled again later.
      await poll.poll(attempt?.id as string, tx);
      const [again] = await attemptsOf(tx, order.id);
      expect(again).toMatchObject({ status: 'pending', pollCount: 1 });
      // Settled at the supplier: the next poll applies it.
      await new FakeSupplierAdapter({
        webhookSecret: WEBHOOK_SECRET,
        state: structuredClone(fakeState),
        onOrder: async (key, kept) => {
          fakeState = { ...fakeState, orders: { ...fakeState.orders, [key]: kept } };
        },
      }).resolve(attempt?.id as string, 'delivered');
      const applied = await poll.poll(attempt?.id as string, tx);
      expect(applied?.applied).toBe(true);
      expect((await attemptsOf(tx, order.id))[0]).toMatchObject({
        status: 'delivered',
        resolvedBy: 'poll',
        pollCount: 2,
      });
      expect(await orderOf(tx, order.id)).toMatchObject({ status: 'delivered' });
      expect(await poll.poll(attempt?.id as string, tx)).toBeNull();
    });
  });

  it('sends an unknown attempt again with its key, never to another route (ADR 0004)', async () => {
    await isolated(async (tx) => {
      const item = await product(tx, { manualCost: usd(0.9) });
      script('fake-uc-60', 'unknown');
      const order = await buy(tx, item);
      await fulfil.fulfil(order.id, tx);
      const [attempt] = await attemptsOf(tx, order.id);
      expect(attempt).toMatchObject({ status: 'unknown' });
      await poll.poll(attempt?.id as string, tx);
      const after = await attemptsOf(tx, order.id);
      expect(after).toHaveLength(1);
      expect(after[0]).toMatchObject({ status: 'unknown', pollCount: 1 });
      // The call was a second placeOrder with the same key, counted as an error for health.
      const calls = await tx
        .select({ operation: supplierCalls.operation, result: supplierCalls.result })
        .from(supplierCalls)
        .where(
          and(eq(supplierCalls.supplierId, ids.fake), sql`${supplierCalls.createdAt} >= now()`),
        );
      expect(calls.filter((call) => call.operation === 'place_order')).toHaveLength(2);
      expect(calls).toContainEqual({ operation: 'place_order', result: 'error' });
      // No other route while it is unknown.
      expect(await fulfil.fulfil(order.id, tx)).toEqual({ kind: 'skipped' });
    });
  });

  it('holds an automatic attempt past the hard limit, then polls it slower (rule F7)', async () => {
    await isolated(async (tx) => {
      const item = await product(tx);
      script('fake-uc-60', 'unknown');
      const order = await buy(tx, item);
      await fulfil.fulfil(order.id, tx);
      const [attempt] = await attemptsOf(tx, order.id);
      const attemptId = attempt?.id as string;
      const now = new Date();
      const sentAt = new Date(now.getTime() - 31 * 60_000);
      await tx
        .update(fulfilmentAttempts)
        .set({ sentAt })
        .where(eq(fulfilmentAttempts.id, attemptId));

      const swept = await sweep.sweep(now, tx);
      expect(swept.held).toContain(order.id);
      const held = await orderOf(tx, order.id);
      expect(held).toMatchObject({ status: 'needs_review' });
      const [message] = await messagesOf(tx, [
        `review:${order.id}:${held.reviewSince?.toISOString()}`,
      ]);
      expect(message).toMatchObject({ kind: 'order_needs_review' });
      expect(message?.params).toMatchObject({ orderNumber: order.number, waitMinutes: 31 });
      expect(await notificationsOf(tx, order.customerId)).toContainEqual({
        event: 'order_delayed',
      });
      // The delay lives in the center only: no email (S08 "Jobs and integrations").
      const emails = await tx
        .select({ template: emailOutbox.template })
        .from(emailOutbox)
        .where(eq(emailOutbox.customerId, order.customerId));
      expect(emails.map((email) => email.template)).not.toContain('customer_order_delayed');
      expect((await sweep.sweep(now, tx)).held).not.toContain(order.id);

      // Past the hard limit, polls come every `review_poll_minutes`.
      await poll.poll(attemptId, tx);
      const [later] = await attemptsOf(tx, order.id);
      const next = later?.nextPollAt?.getTime() as number;
      expect(next - Date.now()).toBeGreaterThan(29 * 60_000);
      expect(next - Date.now()).toBeLessThanOrEqual(30 * 60_000);
      // `review_poll_hours` after the hard limit, polling is over: the admin decides.
      await tx
        .update(fulfilmentAttempts)
        .set({ sentAt: new Date(Date.now() - (24 * 60 + 31) * 60_000) })
        .where(eq(fulfilmentAttempts.id, attemptId));
      sent.length = 0;
      await poll.poll(attemptId, tx);
      expect((await attemptsOf(tx, order.id))[0]?.nextPollAt).toBeNull();
      expect(queued(QUEUES.ordersPoll, 'attemptId', attemptId)).toHaveLength(0);

      // A result still applies from `needs_review` (rule F2).
      script('fake-uc-60', 'delivered');
      fakeState.orders[attemptId] = {
        ...(fakeState.orders[attemptId] as FakeSupplierState['orders'][string]),
        outcome: { status: 'delivered', supplierOrderId: 'late', quantity: 1 },
        settled: { status: 'delivered', supplierOrderId: 'late', quantity: 1 },
      };
      await poll.poll(attemptId, tx);
      expect(await orderOf(tx, order.id)).toMatchObject({
        status: 'delivered',
        reviewSince: null,
      });
    });
  });

  it('queues what a crash or a lost job left behind (rule F6)', async () => {
    await isolated(async (tx) => {
      const item = await product(tx);
      const now = new Date();
      // A `sending` attempt of a minute ago: the worker died between the commit and the call.
      const crashed = await buy(tx, item);
      const sendingId = newId();
      const [offer] = await tx
        .select({ id: supplierOffers.id })
        .from(supplierOffers)
        .where(
          and(eq(supplierOffers.supplierId, ids.fake), eq(supplierOffers.offerId, 'fake-uc-60')),
        );
      await tx.insert(fulfilmentAttempts).values({
        id: sendingId,
        orderId: crashed.id,
        routeId: item.fakeRoute as string,
        supplierId: ids.fake,
        offerId: offer?.id as string,
        supplierOfferId: 'fake-uc-60',
        quantity: 1,
        unitCostUsdUnits: usd(0.88),
        status: 'sending',
        candidates: [],
        sentAt: new Date(now.getTime() - 2 * 60_000),
      });
      await tx.execute(sql`update orders set status = 'sent_to_supplier' where id = ${crashed.id}`);
      // A paid order whose routing job was lost.
      const lost = await buy(tx, item);
      await tx.execute(
        sql`update orders set updated_at = now() - interval '5 minutes' where id = ${lost.id}`,
      );
      // A pending attempt whose poll is late.
      script('fake-uc-60', 'pending');
      const waiting = await buy(tx, item);
      await fulfil.fulfil(waiting.id, tx);
      const [pending] = await attemptsOf(tx, waiting.id);
      await tx
        .update(fulfilmentAttempts)
        .set({ nextPollAt: new Date(now.getTime() - 2 * 60_000) })
        .where(eq(fulfilmentAttempts.id, pending?.id as string));

      // Other tests' paid orders (the api's, never routed there) wait behind this one, so the
      // sweep's batch of 100 always reaches it.
      await tx.execute(
        sql`update orders set updated_at = now() where status in ('paid', 'failed') and id <> ${lost.id}`,
      );
      sent.length = 0;
      const result = await sweep.sweep(now, tx);
      expect(result.resent).toContain(sendingId);
      expect(result.polled).toContain(pending?.id);
      expect(result.fulfilled).toContain(lost.id);
      expect(result.fulfilled).not.toContain(waiting.id);
      expect(queued(QUEUES.ordersPoll, 'attemptId', sendingId)).toHaveLength(1);
      expect(queued(QUEUES.ordersFulfil, 'orderId', lost.id)).toHaveLength(1);

      // The poll re-sends the crashed attempt with its key.
      script('fake-uc-60', 'delivered');
      await poll.poll(sendingId, tx);
      expect(await orderOf(tx, crashed.id)).toMatchObject({ status: 'delivered' });
      expect(fakeState.orders[sendingId]).toBeDefined();
    });
  });

  it('reminds of an open manual attempt once (rule MN2)', async () => {
    await isolated(async (tx) => {
      const item = await product(tx, { fake: null, manualCost: usd(0.9) });
      const order = await buy(tx, item, { player: '5123456789' });
      await fulfil.fulfil(order.id, tx);
      const [manual] = await attemptsOf(tx, order.id);
      const now = new Date();
      expect((await sweep.sweep(now, tx)).reminded).not.toContain(manual?.id);
      await tx
        .update(fulfilmentAttempts)
        .set({ sentAt: new Date(now.getTime() - 16 * 60_000) })
        .where(eq(fulfilmentAttempts.id, manual?.id as string));
      const first = await sweep.sweep(now, tx);
      expect(first.reminded).toContain(manual?.id);
      // Manual attempts have no hard limit.
      expect(first.held).not.toContain(order.id);
      const [reminder] = await messagesOf(tx, [`manual-reminder:${manual?.id}`]);
      expect(reminder).toMatchObject({ kind: 'manual_order_reminder' });
      expect(reminder?.params).toMatchObject({ orderNumber: order.number, waitMinutes: 16 });
      expect((await sweep.sweep(now, tx)).reminded).not.toContain(manual?.id);
    });
  });
});

describe('re-sends and late answers (rules F3, F5, F6)', () => {
  it('sends again with the fields of the first send, whatever the route map became', async () => {
    await isolated(async (tx) => {
      const item = await product(tx);
      script('fake-uc-60', 'unknown');
      const order = await buy(tx, item);
      await fulfil.fulfil(order.id, tx);
      const [attempt] = await attemptsOf(tx, order.id);
      expect(attempt?.fieldMap).toEqual({ playerId: 'player_id' });
      const first = fakeState.orders[attempt?.id as string]?.request;
      // The admin maps one more supplier field while the attempt is still open.
      await tx
        .update(productRoutes)
        .set({ fieldMap: { playerId: 'player_id', zoneId: 'player_id' } })
        .where(eq(productRoutes.id, item.fakeRoute as string));
      await poll.poll(attempt?.id as string, tx);
      // The same request under the same key: the supplier answers it, never a reused-key refusal.
      expect(fakeState.orders[attempt?.id as string]?.request).toEqual(first);
      expect((await attemptsOf(tx, order.id))[0]).toMatchObject({ status: 'unknown' });
      expect(await orderOf(tx, order.id)).toMatchObject({ status: 'sent_to_supplier' });
    });
  });

  it('reports a delivery found after the admin confirmed the attempt failed', async () => {
    await isolated(async (tx) => {
      const item = await product(tx, { manualCost: usd(0.9) });
      script('fake-uc-60', 'pending');
      const order = await buy(tx, item);
      await fulfil.fulfil(order.id, tx);
      const [attempt] = await attemptsOf(tx, order.id);
      const attemptId = attempt?.id as string;
      // While the poll's call is out, the admin confirms the attempt failed (rule D3); then the
      // supplier answers that it delivered.
      const racing = {
        connect: async () => ({
          adapter: {
            getOrder: async () => {
              await applyOutcome(
                tx,
                { jobs, codesKey, now: new Date() },
                attemptId,
                { status: 'failed', reason: 'admin' },
                {
                  by: 'admin',
                  admin: { id: newId(), reason: 'confirmed', idempotencyKey: newId() },
                },
              );
              return { status: 'delivered', supplierOrderId: 'late', quantity: 1 };
            },
          },
          secrets: [],
        }),
      } as unknown as SupplierRegistry;
      const applied = await new OrdersPollJob(pgBoss, racing, db, env).poll(attemptId, tx);
      expect(applied?.applied).toBe(false);
      expect((await attemptsOf(tx, order.id))[0]).toMatchObject({ status: 'failed' });
      const notes = await tx
        .select({ reason: orderEvents.reason, details: orderEvents.details })
        .from(orderEvents)
        .where(and(eq(orderEvents.orderId, order.id), eq(orderEvents.kind, 'note')));
      expect(notes).toEqual([
        {
          reason: 'late_result_conflict',
          details: { source: 'poll', attemptStatus: 'failed', reported: 'delivered' },
        },
      ]);
      const [alert] = await messagesOf(tx, [`conflict:${attemptId}:poll`]);
      expect(alert).toMatchObject({ kind: 'order_conflict' });
    });
  });
});

describe('supplier webhooks (rule F5)', () => {
  /** Stores a webhook as the API's intake does: once, the body encrypted. */
  async function stored(tx: Transaction, rawBody: string, eventId = `evt-${unique()}`) {
    const id = newId();
    await tx.insert(supplierWebhookEvents).values({
      id,
      supplierId: ids.fake,
      eventId,
      bodyCiphertext: encryptSecret(codesKey, id, rawBody),
    });
    return id;
  }

  const body = (attemptId: string, status: 'delivered' | 'failed') =>
    JSON.stringify({
      eventId: `evt-${unique()}`,
      idempotencyKey: attemptId,
      supplierOrderId: `fake-${unique()}`,
      status,
      quantity: 1,
    });

  const eventRow = async (tx: Transaction, id: string) =>
    (await tx.select().from(supplierWebhookEvents).where(eq(supplierWebhookEvents.id, id)))[0];

  it('applies a result, then answers the same result, an unknown key and a malformed body', async () => {
    await isolated(async (tx) => {
      const item = await product(tx);
      script('fake-uc-60', 'pending');
      const order = await buy(tx, item);
      await fulfil.fulfil(order.id, tx);
      const [attempt] = await attemptsOf(tx, order.id);
      const attemptId = attempt?.id as string;

      const first = await stored(tx, body(attemptId, 'delivered'));
      expect(await webhooks.process(first, tx)).toBe('applied');
      expect(await eventRow(tx, first)).toMatchObject({ result: 'applied', attemptId });
      expect((await attemptsOf(tx, order.id))[0]).toMatchObject({
        status: 'delivered',
        resolvedBy: 'webhook',
      });
      expect(await orderOf(tx, order.id)).toMatchObject({ status: 'delivered' });
      // A second run of the same event does nothing.
      expect(await webhooks.process(first, tx)).toBeNull();

      const again = await stored(tx, body(attemptId, 'delivered'));
      expect(await webhooks.process(again, tx)).toBe('same_result');
      const unknown = await stored(tx, body(newId(), 'delivered'));
      expect(await webhooks.process(unknown, tx)).toBe('unknown_key');
      expect(await eventRow(tx, unknown)).toMatchObject({ attemptId: null });
      const foreign = await stored(tx, body('not-a-uuid', 'delivered'));
      expect(await webhooks.process(foreign, tx)).toBe('unknown_key');
      const broken = await stored(tx, '{"eventId":1}');
      expect(await webhooks.process(broken, tx)).toBe('malformed');
      const digest = await stored(tx, 'not json', `malformed:${unique()}`);
      expect(await webhooks.process(digest, tx)).toBe('malformed');
    });
  });

  it('reports a conflict without moving money or goods (rule F5, edge case 11)', async () => {
    await isolated(async (tx) => {
      const item = await product(tx);
      script('fake-uc-60', 'failed');
      const order = await buy(tx, item);
      await fulfil.fulfil(order.id, tx);
      // No route left: the order is refunded; then the supplier says it delivered.
      await fulfil.fulfil(order.id, tx);
      expect(await orderOf(tx, order.id)).toMatchObject({ status: 'refunded' });
      const [attempt] = await attemptsOf(tx, order.id);
      const event = await stored(tx, body(attempt?.id as string, 'delivered'));
      expect(await webhooks.process(event, tx)).toBe('conflict');
      expect(await orderOf(tx, order.id)).toMatchObject({ status: 'refunded' });
      expect(
        await tx.select().from(orderCodes).where(eq(orderCodes.orderId, order.id)),
      ).toHaveLength(0);
      const notes = await tx
        .select({ kind: orderEvents.kind, reason: orderEvents.reason })
        .from(orderEvents)
        .where(and(eq(orderEvents.orderId, order.id), eq(orderEvents.kind, 'note')));
      expect(notes).toEqual([{ kind: 'note', reason: 'webhook_conflict' }]);
      const [alert] = await messagesOf(tx, [`conflict:${event}`]);
      expect(alert).toMatchObject({ kind: 'order_conflict' });
      expect(alert?.params).toMatchObject({ attemptStatus: 'failed', reported: 'delivered' });
    });
  });
});

describe('Telegram order messages (rules MN1, MN2, F5, F7)', () => {
  const links = { admin: 'http://127.0.0.1:5173' };
  const orderId = newId();

  it('render each kind with its link and no account fields', () => {
    const card = renderTelegramMessage(
      'manual_order',
      {
        orderId,
        orderNumber: 'VO-ABC234',
        gameNameAr: 'ببجي موبايل',
        productNameAr: '60 UC',
        quantity: 2,
        sentAt: '2030-01-01T10:00:00.000Z',
      },
      links,
    ).text;
    expect(card).toContain('طلب يدوي VO-ABC234 بانتظارك');
    expect(card).toContain('ببجي موبايل · 60 UC × 2');
    expect(card).toContain(`${links.admin}/orders/${orderId}`);
    expect(
      renderTelegramMessage(
        'manual_order_reminder',
        {
          orderId,
          orderNumber: 'VO-ABC234',
          gameNameAr: 'ببجي',
          productNameAr: '60 UC',
          quantity: 1,
          waitMinutes: 16,
        },
        links,
      ).text,
    ).toContain('ما زال بانتظارك منذ 16 د');
    expect(
      renderTelegramMessage(
        'order_needs_review',
        { orderId, orderNumber: 'VO-ABC234', supplierNameAr: 'WDGZone', waitMinutes: 30 },
        links,
      ).text,
    ).toContain('⏳ الطلب VO-ABC234 بحاجة لمراجعة: لا جواب نهائي من WDGZone منذ 30 د');
    const conflict = renderTelegramMessage(
      'order_conflict',
      {
        orderId,
        orderNumber: 'VO-ABC234',
        supplierNameAr: 'WDGZone',
        attemptStatus: 'failed',
        reported: 'delivered',
      },
      links,
    ).text;
    expect(conflict).toContain('أبلغ WDGZone أنه سُلّم بعد أن سُجّل أنه فشل');
    // S09 rule PV5: the daily validation quota, once a day per supplier.
    expect(
      renderTelegramMessage(
        'validation_quota_reached',
        { supplier: 'shop2topup', supplierNameAr: 'SHOP2TOPUP', quota: 1000 },
        links,
      ).text,
    ).toBe(
      `⚠️ بلغت حصة التحقق اليومية لدى SHOP2TOPUP (1000). العملاء يؤكدون المعرّف بأنفسهم حتى منتصف الليل.\n${links.admin}/suppliers/shop2topup`,
    );
    expect(
      renderTelegramMessage(
        'order_conflict',
        {
          orderId,
          orderNumber: 'VO-ABC234',
          supplierNameAr: 'WDGZone',
          attemptStatus: 'delivered',
          reported: 'failed',
        },
        links,
      ).text,
    ).toContain('أنه فشل بعد أن سُجّل أنه سُلّم');
  });
});

describe('races on one attempt (committed: each side has its own connection)', () => {
  /**
   * The order and its open attempt, committed; the attempt `sending` or `pending`. The product
   * is sold through a manual route, and the attempt goes to a `shop2topup` offer of its own
   * (answered by the in-process fake here), so nothing committed touches the fake supplier's
   * calls, health, credentials or routes, which the supplier tests read.
   */
  async function committed(offerId: string, status: 'sending' | 'pending', code: boolean) {
    return db.transaction(async (tx) => {
      sent.length = 0;
      const item = await product(tx, { code, fake: null, manualCost: usd(code ? 24 : 0.9) });
      const order = await buy(tx, item);
      const [shop] = await tx
        .select({ id: suppliers.id })
        .from(suppliers)
        .where(eq(suppliers.code, 'shop2topup'));
      const supplierId = shop?.id as string;
      const offer = newId();
      await tx.insert(supplierOffers).values({
        id: offer,
        supplierId,
        offerId: `race-${unique()}`,
        name: 'Race',
        inStock: true,
        costUsdUnits: usd(code ? 24 : 0.9),
        costConfirmedAt: new Date(),
        lastSeenAt: new Date(),
      });
      const route = newId();
      await tx.insert(productRoutes).values({
        id: route,
        productId: item.id,
        supplierId,
        offerId: offer,
        fieldMap: code ? {} : { playerId: 'player_id' },
      });
      const attemptId = newId();
      await tx.insert(fulfilmentAttempts).values({
        id: attemptId,
        orderId: order.id,
        routeId: route,
        supplierId,
        offerId: offer,
        supplierOfferId: offerId,
        quantity: 1,
        unitCostUsdUnits: usd(code ? 24 : 0.9),
        status,
        candidates: [],
        sentAt: new Date(Date.now() - 2 * 60_000),
      });
      await tx.execute(sql`update orders set status = 'sent_to_supplier' where id = ${order.id}`);
      return { order, attemptId, supplierId };
    });
  }

  const costJournals = async (orderId: string) =>
    db
      .select({ id: ledgerJournals.id })
      .from(ledgerJournals)
      .where(sql`${ledgerJournals.idempotencyKey} like ${`order:${orderId}:cost:%`}`);

  it('applies a webhook and a poll of one result once (edge case 7)', async () => {
    const { order, attemptId, supplierId } = await committed('fake-itunes-25', 'pending', true);
    fakeState = fakeSupplierStateSchema.parse({ orderScripts: { 'fake-itunes-25': 'pending' } });
    const fake = new FakeSupplierAdapter({
      webhookSecret: WEBHOOK_SECRET,
      state: structuredClone(fakeState),
      onOrder: async (key, kept) => {
        fakeState = { ...fakeState, orders: { ...fakeState.orders, [key]: kept } };
      },
    });
    await fake.placeOrder({
      idempotencyKey: attemptId,
      offerId: 'fake-itunes-25',
      quantity: 1,
      fields: {},
    });
    const webhook = await fake.resolve(attemptId, 'delivered');
    const eventId = newId();
    await db.insert(supplierWebhookEvents).values({
      id: eventId,
      supplierId,
      eventId: `evt-${unique()}`,
      bodyCiphertext: encryptSecret(codesKey, eventId, webhook.rawBody),
    });
    const [byWebhook, byPoll] = await Promise.all([
      webhooks.process(eventId),
      poll.poll(attemptId),
    ]);
    expect([byWebhook === 'applied', byPoll?.applied === true].filter(Boolean)).toHaveLength(1);
    expect(await costJournals(order.id)).toHaveLength(1);
    expect(await db.select().from(orderCodes).where(eq(orderCodes.orderId, order.id))).toHaveLength(
      1,
    );
    const [row] = await db.select().from(orders).where(eq(orders.id, order.id));
    expect(row).toMatchObject({ status: 'delivered', deliveredQuantity: 1 });
  });

  it('re-sends a slow attempt with its key and delivers once (rule F6, edge case 5)', async () => {
    const { order, attemptId } = await committed('fake-uc-1800', 'sending', false);
    fakeState = fakeSupplierStateSchema.parse({ orderScripts: { 'fake-uc-1800': 'slow:1' } });
    // The first send is still out when the sweep's poll sends the same key again.
    const first = poll.poll(attemptId);
    await new Promise((resolve) => setTimeout(resolve, 300));
    const second = await poll.poll(attemptId);
    expect(second?.applied).toBe(true);
    expect((await first)?.applied).toBe(false);
    expect(await costJournals(order.id)).toHaveLength(1);
    const [attempt] = await db
      .select()
      .from(fulfilmentAttempts)
      .where(eq(fulfilmentAttempts.id, attemptId));
    expect(attempt).toMatchObject({ status: 'delivered', resolvedBy: 'poll' });
    expect(Object.keys(fakeState.orders)).toEqual([attemptId]);
  });
});
