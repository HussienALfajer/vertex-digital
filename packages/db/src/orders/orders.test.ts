import { createHash, randomBytes } from 'node:crypto';
import { CURRENCY_SCALE, priceFromCost, QUEUES } from '@vertex-digital/contracts';
import { and, desc, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDatabase, type Transaction } from '../client.js';
import { newId } from '../id.js';
import { accountBalance } from '../ledger/balance.js';
import { ensureCustomerWallet, ensureSystemAccount, findCustomerWallet } from '../ledger/index.js';
import { postJournal } from '../ledger/post-journal.js';
import { walletTimeline } from '../ledger/wallet.js';
import { repriceProducts } from '../pricing/index.js';
import {
  auditEntries,
  customerNotifications,
  customers,
  fulfilmentAttempts,
  orderCodes,
  orderEvents,
  orders,
  playerChecks,
  productPrices,
  storeSwitchChanges,
} from '../schema/index.js';
import { applyOutcome, refundRemaining } from './outcome.js';
import { OrderError, type PurchaseInput, purchaseOrder } from './purchase.js';
import {
  adminOrder,
  adminOrderCounts,
  adminOrderPage,
  customerOrder,
  customerOrderPage,
  productDeliveryStats,
  revealCode,
} from './reads.js';
import { cancelOwnReservation, expireReservations, payWaitingOrders } from './reservations.js';
import { decryptSecret } from './secrets.js';
import { lockOrder, type OrderContext, type OrderRow, transitionOrder } from './transition.js';

/*
 * The order write path (S08 rules O1–O6, F1, F2, M1–M3) and the guards of migration 0031, on
 * PostgreSQL as the app role (the owner only to prove a guard refuses it too). Each product has
 * its own category, game, rule (10%, $0, $0.10) and `fake` route; each test its own customers.
 * Orders and ledger rows stay in the test database (never deleted, by design).
 */

const connection = createDatabase(process.env.DATABASE_URL as string);
const owner = createDatabase(process.env.DATABASE_OWNER_URL as string);
const { db, pool } = connection;
const DOLLAR = CURRENCY_SCALE.USD;
const usd = (dollars: number) => Math.round(dollars * DOLLAR);
const unique = () => newId().replaceAll('-', '').slice(-12);
const rule = { percentBp: 1000, fixedUsdUnits: 0, minMarginUsdUnits: 100_000 };
const codesKey = randomBytes(32);
const sent: { queue: string; data: object; options?: object }[] = [];
const context = (): OrderContext => ({
  jobs: {
    send: async (_tx, queue, data, options) => {
      sent.push({ queue, data, ...(options && { options }) });
      return null;
    },
  },
  codesKey,
  now: new Date(),
});

let suppliers: Record<'fake' | 'manual' | 'shop2topup', string>;
const categories: string[] = [];

beforeAll(async () => {
  const { rows } = await pool.query<{ id: string; code: 'fake' | 'manual' | 'shop2topup' }>(
    `select id, code from suppliers where code in ('fake', 'manual', 'shop2topup')`,
  );
  suppliers = Object.fromEntries(rows.map((row) => [row.code, row.id])) as typeof suppliers;
  await pool.query(
    `insert into supplier_credentials (id, supplier_id, ciphertext, hints, admin_id)
     select $1, $2, '\\x00', '{}', $3
     where not exists (select 1 from supplier_credentials where supplier_id = $2)`,
    [newId(), suppliers.fake, newId()],
  );
});

afterAll(async () => {
  await pool.query('update catalog_categories set archived_at = now() where id = any($1::uuid[])', [
    categories,
  ]);
  await Promise.all([connection.close(), owner.close()]);
});

async function customer(options: { isTest?: boolean; funds?: number } = {}) {
  const id = newId();
  await db.insert(customers).values({
    id,
    name: 'Buyer',
    email: `${id}@test.vertex-digital.local`,
    phone: '+963900000000',
    emailVerified: true,
    isTest: options.isTest ?? false,
  });
  if (options.funds) {
    await db.transaction(async (tx) => {
      await postJournal(tx, {
        idempotencyKey: `test:${newId()}`,
        kind: 'adjustment',
        postings: [
          { accountId: await ensureCustomerWallet(tx, id), amountUnits: options.funds as number },
          {
            accountId: await ensureSystemAccount(tx, {
              code: 'adjustments:test_funds',
              kind: 'adjustments',
              currency: 'USD',
            }),
            amountUnits: -(options.funds as number),
          },
        ],
      });
    });
  }
  return id;
}

const balance = async (customerId: string) =>
  accountBalance(db, (await findCustomerWallet(db, customerId)) as string);

/** An active product with a `player_id` field, a route to `supplier` at `cost`, and its price. */
async function product(
  options: { kind?: 'direct' | 'code'; cost?: number; supplier?: 'fake' | 'shop2topup' } = {},
) {
  const [category, game, id, offer, route] = [newId(), newId(), newId(), newId(), newId()];
  const kind = options.kind ?? 'direct';
  const supplier = options.supplier ?? 'fake';
  const cost = options.cost ?? usd(0.88);
  categories.push(category);
  await pool.query(
    'insert into catalog_categories (id, slug, name_ar, sort_order) values ($1, $2, $3, 99)',
    [category, `c-${unique()}`, `فئة ${unique()}`],
  );
  await pool.query(
    `insert into catalog_games (id, category_id, slug, name_ar, name_en, status, sort_order)
     values ($1, $2, $3, $4, 'Game', 'active', 1)`,
    [game, category, `g-${unique()}`, `لعبة ${unique()}`],
  );
  if (kind === 'direct') {
    await pool.query(
      `insert into catalog_input_fields (id, game_id, key, label_ar, type, required, sort_order,
         min_length, max_length) values ($1, $2, 'player_id', 'المعرف', 'digits', true, 1, 5, 12)`,
      [newId(), game],
    );
  }
  await pool.query(
    `insert into catalog_products (id, game_id, kind, name_ar, max_quantity, sort_order)
     values ($1, $2, $3, $4, $5, 1)`,
    [id, game, kind, `باقة ${unique()}`, kind === 'code' ? 10 : 1],
  );
  await pool.query(
    `insert into margin_rules (id, scope, target_id, percent_bp, fixed_usd_units,
       min_margin_usd_units) values ($1, 'product', $2, $3, $4, $5)`,
    [newId(), id, rule.percentBp, rule.fixedUsdUnits, rule.minMarginUsdUnits],
  );
  await pool.query(
    `insert into supplier_offers (id, supplier_id, offer_id, name, in_stock, cost_usd_units,
       cost_confirmed_at, last_seen_at) values ($1, $2, $3, 'Offer', true, $4, now(), now())`,
    [offer, suppliers[supplier], `o-${unique()}`, cost],
  );
  await pool.query(
    `insert into product_routes (id, product_id, supplier_id, offer_id, field_map)
     values ($1, $2, $3, $4, $5)`,
    [route, id, suppliers[supplier], offer, kind === 'direct' ? { playerId: 'player_id' } : {}],
  );
  await db.transaction((tx) =>
    repriceProducts(tx, {
      productIds: [id],
      cause: 'route_change',
      context: { now: new Date(), fakeEnabled: true },
    }),
  );
  return { id, game, offer, route, price: priceFromCost(cost, rule), cost };
}

const hash = (value: object) => createHash('sha256').update(JSON.stringify(value)).digest('hex');

function request(
  customerId: string,
  item: { id: string; price: number },
  overrides: Partial<PurchaseInput> = {},
): PurchaseInput {
  return {
    customerId,
    productId: item.id,
    quantity: 1,
    fields: { player_id: '5123456789' },
    expectedUnitPriceUsdUnits: item.price,
    idempotencyKey: newId(),
    requestHash: hash({ productId: item.id }),
    fakeEnabled: true,
    purchasesStopped: false,
    channel: 'store',
    whenBalanceShort: 'refuse',
    confirmPlayer: false,
    playerCheck: async () => null,
    ...overrides,
  };
}

const buy = (input: PurchaseInput) => db.transaction((tx) => purchaseOrder(tx, context(), input));

const refusal = async (promise: Promise<unknown>) => {
  try {
    await promise;
  } catch (error) {
    return error instanceof OrderError
      ? { code: error.code, details: error.details }
      : {
          code: (error as { code?: string }).code,
          details: (error as { details?: unknown }).details,
        };
  }
  throw new Error('Expected a refusal');
};

/** Sends the order to its route, as `orders.fulfil` does (PR 2): the attempt is `sending`. */
async function send(order: OrderRow, item: { route: string; offer: string; cost: number }) {
  return db.transaction(async (tx) => {
    const locked = (await lockOrder(tx, order.id)) as OrderRow;
    const remaining = locked.quantity - locked.deliveredQuantity - locked.refundedQuantity;
    const id = newId();
    await tx.insert(fulfilmentAttempts).values({
      id,
      orderId: order.id,
      routeId: item.route,
      supplierId: suppliers.fake,
      offerId: item.offer,
      supplierOfferId: 'o-test',
      quantity: remaining,
      unitCostUsdUnits: item.cost,
      status: 'sending',
      candidates: [],
      sentAt: new Date(),
    });
    await transitionOrder(tx, locked, 'sent_to_supplier', { actor: 'system', attemptId: id });
    return id;
  });
}

const orderRow = async (id: string) =>
  (await db.select().from(orders).where(eq(orders.id, id)))[0] as OrderRow;

const apply = (
  attemptId: string,
  outcome: Parameters<typeof applyOutcome>[3],
  by: 'supplier' | 'poll' | 'webhook' = 'supplier',
) => db.transaction((tx) => applyOutcome(tx, context(), attemptId, outcome, { by }));

describe('purchase (rules O1–O6, M1)', () => {
  it('debits the wallet, writes the paid order, its event, audit and job in one transaction', async () => {
    const item = await product();
    const buyer = await customer({ funds: usd(10) });
    const input = request(buyer, item);
    const { order, created } = await buy(input);
    expect(created).toBe(true);
    expect(order).toMatchObject({
      status: 'paid',
      quantity: 1,
      unitPriceUsdUnits: item.price,
      totalUsdUnits: item.price,
      minMarginUsdUnits: rule.minMarginUsdUnits,
      fields: { player_id: '5123456789' },
      isTest: false,
    });
    expect(order.number).toMatch(/^VO-[2-9A-HJKMNP-Z]{6}$/);
    expect(await balance(buyer)).toBe(usd(10) - item.price);
    const events = await db.select().from(orderEvents).where(eq(orderEvents.orderId, order.id));
    expect(events.map((e) => [e.kind, e.toStatus, e.actor])).toEqual([
      ['status', 'paid', 'customer'],
    ]);
    const [audit] = await db
      .select()
      .from(auditEntries)
      .where(and(eq(auditEntries.entityId, order.id), eq(auditEntries.action, 'order.paid')));
    expect(audit?.details).toMatchObject({ number: order.number, totalUsdUnits: item.price });
    expect(sent.find((job) => (job.data as { orderId?: string }).orderId === order.id)).toEqual({
      queue: QUEUES.ordersFulfil,
      data: { orderId: order.id },
      options: expect.objectContaining({ singletonKey: order.id }),
    });
  });

  it('returns the first order for the same key and body, refuses another body or customer', async () => {
    const item = await product();
    const buyer = await customer({ funds: usd(10) });
    const input = request(buyer, item);
    const first = await buy(input);
    const again = await buy(input);
    expect(again).toEqual({ order: first.order, created: false });
    expect(await balance(buyer)).toBe(usd(10) - item.price);
    expect(await refusal(buy({ ...input, requestHash: hash({ other: 1 }) }))).toMatchObject({
      code: 'IDEMPOTENCY_KEY_REUSED',
    });
    // A replay still answers while purchases are stopped; a new purchase does not (rule O2).
    expect(await buy({ ...input, purchasesStopped: true })).toMatchObject({ created: false });
    expect(
      await refusal(buy({ ...input, idempotencyKey: newId(), purchasesStopped: true })),
    ).toMatchObject({ code: 'PURCHASES_STOPPED' });
    const stranger = await customer({ funds: usd(10) });
    expect(await refusal(buy({ ...input, customerId: stranger }))).toMatchObject({
      code: 'IDEMPOTENCY_KEY_REUSED',
    });
  });

  it('buys once for one key sent twice in parallel', async () => {
    const item = await product();
    const buyer = await customer({ funds: usd(10) });
    const input = request(buyer, item);
    const results = await Promise.all([buy(input), buy(input)]);
    expect(results.map((result) => result.created).sort()).toEqual([false, true]);
    expect(results[0]?.order.id).toBe(results[1]?.order.id);
    expect(await balance(buyer)).toBe(usd(10) - item.price);
  });

  it('never overdraws a wallet with parallel purchases (edge case 1)', async () => {
    const item = await product();
    const buyer = await customer({ funds: item.price * 2 });
    const outcomes = await Promise.allSettled(
      Array.from({ length: 4 }, () => buy(request(buyer, item))),
    );
    expect(outcomes.filter((o) => o.status === 'fulfilled')).toHaveLength(2);
    for (const failed of outcomes.filter((o) => o.status === 'rejected')) {
      expect((failed as PromiseRejectedResult).reason).toMatchObject({
        code: 'INSUFFICIENT_BALANCE',
        details: { balanceUnits: expect.any(Number) },
      });
    }
    expect(await balance(buyer)).toBe(0);
  });

  it('refuses a changed price with the new one, and reads the price a waiting repricing set', async () => {
    const item = await product();
    const buyer = await customer({ funds: usd(10) });
    expect(
      await refusal(buy(request(buyer, item, { expectedUnitPriceUsdUnits: item.price + 10_000 }))),
    ).toEqual({ code: 'PRICE_CHANGED', details: { unitPriceUsdUnits: item.price } });

    // A repricing holds the product; the purchase waits, then sees its new price (edge case 2).
    const repricing = await pool.connect();
    try {
      await repricing.query('begin');
      await repricing.query('select id from catalog_products where id = $1 for update', [item.id]);
      const [current] = await db
        .select()
        .from(productPrices)
        .where(eq(productPrices.productId, item.id));
      await repricing.query(
        `insert into product_prices (id, product_id, price_usd_units, cost_usd_units, route_id,
           rule_id, percent_bp, fixed_usd_units, min_margin_usd_units, cause)
         values ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'rule_change')`,
        [
          newId(),
          item.id,
          item.price + 20_000,
          current?.costUsdUnits,
          current?.routeId,
          current?.ruleId,
          rule.percentBp,
          rule.fixedUsdUnits,
          rule.minMarginUsdUnits,
        ],
      );
      const purchase = refusal(buy(request(buyer, item)));
      await new Promise((resolve) => setTimeout(resolve, 200));
      await repricing.query('commit');
      expect(await purchase).toEqual({
        code: 'PRICE_CHANGED',
        details: { unitPriceUsdUnits: item.price + 20_000 },
      });
    } finally {
      repricing.release();
    }
    expect(await balance(buyer)).toBe(usd(10));
  });

  it('refuses a product that cannot be bought, and real suppliers for a test customer (O3, R4)', async () => {
    const item = await product({ supplier: 'shop2topup' });
    const buyer = await customer({ funds: usd(10) });
    // `shop2topup` has no adapter in this build (S07 SP1): no usable route, no price.
    expect(await refusal(buy(request(buyer, { id: item.id, price: 1 })))).toMatchObject({
      code: 'PRODUCT_UNAVAILABLE',
    });
    const fakeItem = await product();
    await pool.query(`update catalog_products set status = 'paused' where id = $1`, [fakeItem.id]);
    expect(await refusal(buy(request(buyer, fakeItem)))).toEqual({
      code: 'PRODUCT_UNAVAILABLE',
      details: { availability: 'paused' },
    });
    expect(await refusal(buy(request(buyer, { id: newId(), price: 1 })))).toMatchObject({
      code: 'NOT_FOUND',
    });
    const tester = await customer({ isTest: true, funds: usd(10) });
    const testItem = await product();
    const { order } = await buy(request(tester, testItem));
    expect(order.isTest).toBe(true);
  });

  it('refuses a quantity above the maximum and invalid fields, by key (O5)', async () => {
    const item = await product();
    const buyer = await customer({ funds: usd(10) });
    expect(await refusal(buy(request(buyer, item, { quantity: 2 })))).toEqual({
      code: 'VALIDATION_FAILED',
      details: { fields: { quantity: 'too_big' } },
    });
    expect(
      await refusal(buy(request(buyer, item, { fields: { player_id: '12', zone: '1' } }))),
    ).toEqual({
      code: 'VALIDATION_FAILED',
      details: { fields: { player_id: 'too_small', zone: 'unknown' } },
    });
    expect(await balance(buyer)).toBe(usd(10));
  });
});

describe('outcomes (rules F1, F2, M2)', () => {
  it('delivers a top-up: cost posted, order delivered, customer notified', async () => {
    const item = await product();
    const buyer = await customer({ funds: usd(10) });
    const { order } = await buy(request(buyer, item));
    const attemptId = await send(order, item);
    const result = await apply(attemptId, {
      status: 'delivered',
      quantity: 1,
      supplierOrderId: 'f-1',
    });
    expect(result.applied).toBe(true);
    expect(result.order).toMatchObject({ status: 'delivered', deliveredQuantity: 1 });
    expect(result.order.deliveredAt).not.toBeNull();
    expect(result.attempt).toMatchObject({
      status: 'delivered',
      deliveredQuantity: 1,
      resolvedBy: 'supplier',
      supplierOrderId: 'f-1',
    });
    const [notice] = await db
      .select()
      .from(customerNotifications)
      .where(eq(customerNotifications.customerId, buyer));
    expect(notice).toMatchObject({ event: 'order_delivered' });

    // A second result for a closed attempt changes nothing (edge case 7).
    const late = await apply(attemptId, { status: 'failed', reason: 'late' }, 'webhook');
    expect(late.applied).toBe(false);
    expect((await orderRow(order.id)).status).toBe('delivered');
  });

  it('stores codes encrypted, one per unit, and routes the rest of a partial delivery', async () => {
    const item = await product({ kind: 'code', cost: usd(9.6) });
    const buyer = await customer({ funds: usd(100) });
    const { order } = await buy(request(buyer, item, { quantity: 3, fields: {} }));
    const attemptId = await send(order, item);
    const codes = ['AAAA-BBBB-CCCC-0001', 'AAAA-BBBB-CCCC-0002'];

    // Codes missing for a code product: kept open, polled (edge case 10).
    const missing = await apply(attemptId, { status: 'delivered', quantity: 2, codes: ['X'] });
    expect(missing.attempt).toMatchObject({ status: 'unknown', failureReason: 'codes_missing' });

    const result = await apply(attemptId, { status: 'delivered', quantity: 2, codes }, 'poll');
    expect(result.order).toMatchObject({ status: 'failed', deliveredQuantity: 2 });
    const stored = await db.select().from(orderCodes).where(eq(orderCodes.attemptId, attemptId));
    expect(stored.map((row) => [row.position, row.hint])).toEqual([
      [1, '0001'],
      [2, '0002'],
    ]);
    for (const row of stored) {
      expect(row.ciphertext.includes(Buffer.from('BBBB'))).toBe(false);
      expect(codes).toContain(decryptSecret(codesKey, row.id, row.ciphertext));
    }
    expect(JSON.stringify(result.attempt.result)).not.toContain('AAAA');

    // No route left: the third unit is refunded (edge case 8).
    const refunded = await db.transaction(async (tx) =>
      refundRemaining(
        tx,
        context(),
        (await lockOrder(tx, order.id)) as OrderRow,
        'routes_exhausted',
        {
          actor: 'system',
          actorId: null,
        },
      ),
    );
    expect(refunded).toMatchObject({
      status: 'partially_refunded',
      deliveredQuantity: 2,
      refundedQuantity: 1,
      refundedUsdUnits: item.price,
      refundReason: 'routes_exhausted',
    });
    expect(await balance(buyer)).toBe(usd(100) - item.price * 2);
  });

  it('refunds at once when the account fields are refused, without another route', async () => {
    const item = await product();
    const buyer = await customer({ funds: usd(10) });
    const { order } = await buy(request(buyer, item));
    const attemptId = await send(order, item);
    const result = await apply(attemptId, {
      status: 'failed',
      reason: 'Player not found',
      inputRejected: true,
      supplierErrorCode: 'PLAYER_NOT_FOUND',
    });
    expect(result.order).toMatchObject({ status: 'refunded', refundReason: 'input_rejected' });
    expect(result.attempt).toMatchObject({ status: 'failed', inputRejected: true });
    expect(await balance(buyer)).toBe(usd(10));
    const statuses = await db
      .select({ to: orderEvents.toStatus })
      .from(orderEvents)
      .where(and(eq(orderEvents.orderId, order.id), eq(orderEvents.kind, 'status')));
    expect(statuses.map((row) => row.to)).toEqual([
      'paid',
      'sent_to_supplier',
      'failed',
      'refunded',
    ]);
  });

  it('moves a failed attempt to the next route, and polls a pending or unknown one', async () => {
    const item = await product();
    const buyer = await customer({ funds: usd(10) });
    const { order } = await buy(request(buyer, item));
    const attemptId = await send(order, item);
    const pending = await apply(attemptId, { status: 'pending', supplierOrderId: 'p-1' });
    expect(pending.attempt.status).toBe('pending');
    expect(pending.attempt.nextPollAt).not.toBeNull();
    expect(sent.at(-1)).toMatchObject({ queue: QUEUES.ordersPoll, data: { attemptId } });
    const unknown = await apply(attemptId, { status: 'unknown', reason: 'timeout' }, 'poll');
    expect(unknown.attempt.status).toBe('unknown');
    const failed = await apply(attemptId, { status: 'failed', reason: 'Refused' }, 'poll');
    expect(failed.order.status).toBe('failed');
    expect(sent.at(-1)).toMatchObject({ queue: QUEUES.ordersFulfil, data: { orderId: order.id } });
  });

  it('applies one of a webhook and a poll arriving at once (edge case 7)', async () => {
    const item = await product();
    const buyer = await customer({ funds: usd(10) });
    const { order } = await buy(request(buyer, item));
    const attemptId = await send(order, item);
    const results = await Promise.all([
      apply(attemptId, { status: 'delivered', quantity: 1 }, 'webhook'),
      apply(attemptId, { status: 'delivered', quantity: 1 }, 'poll'),
    ]);
    expect(results.map((r) => r.applied).sort()).toEqual([false, true]);
    const { rows } = await pool.query(
      `select count(*)::int as n from ledger_journals where idempotency_key like $1`,
      [`order:${order.id}:cost:%`],
    );
    expect(rows[0].n).toBe(1);
  });
});

describe('guards (migration 0031)', () => {
  it('refuses a second open attempt and a route tried twice', async () => {
    const item = await product();
    const buyer = await customer({ funds: usd(10) });
    const { order } = await buy(request(buyer, item));
    await send(order, item);
    await expect(
      pool.query(
        `insert into fulfilment_attempts (id, order_id, route_id, supplier_id, offer_id,
           supplier_offer_id, quantity, unit_cost_usd_units, status, candidates)
         values ($1, $2, $3, $4, $5, 'o', 1, 1, 'pending', '[]')`,
        [newId(), order.id, item.route, suppliers.fake, item.offer],
      ),
    ).rejects.toThrow(/fulfilment_attempts_(open|order_id_route_id)_idx/);
  });

  it('refunds an order once, never above what was paid', async () => {
    const item = await product();
    const buyer = await customer({ funds: usd(10) });
    const { order } = await buy(request(buyer, item));
    const refund = () =>
      db.transaction(async (tx: Transaction) =>
        refundRemaining(tx, context(), (await lockOrder(tx, order.id)) as OrderRow, 'no_route', {
          actor: 'system',
          actorId: null,
        }),
      );
    const outcomes = await Promise.allSettled([refund(), refund()]);
    expect(outcomes.filter((o) => o.status === 'fulfilled')).toHaveLength(1);
    expect(await balance(buyer)).toBe(usd(10));
    await expect(
      pool.query('update orders set refunded_usd_units = refunded_usd_units * 2 where id = $1', [
        order.id,
      ]),
    ).rejects.toThrow(/never changes/);
  });

  it('keeps an order on the transition table, its price fixed, and never deletes it', async () => {
    const item = await product();
    const buyer = await customer({ funds: usd(10) });
    const { order } = await buy(request(buyer, item));
    await expect(
      pool.query(`update orders set status = 'delivered' where id = $1`, [order.id]),
    ).rejects.toThrow(/not an allowed transition/);
    await expect(
      pool.query('update orders set unit_price_usd_units = 10000 where id = $1', [order.id]),
    ).rejects.toThrow(/fixed/);
    await expect(pool.query('delete from orders where id = $1', [order.id])).rejects.toThrow(
      /permission denied/,
    );
    await expect(owner.pool.query('delete from orders where id = $1', [order.id])).rejects.toThrow(
      /never deleted/,
    );
    await expect(
      pool.query(`update order_events set reason = 'x' where order_id = $1`, [order.id]),
    ).rejects.toThrow(/permission denied/);
  });

  it('loses a race on a status change without writing an event', async () => {
    const item = await product();
    const buyer = await customer({ funds: usd(10) });
    const { order } = await buy(request(buyer, item));
    const changed = await db.transaction((tx) =>
      transitionOrder(tx, { id: order.id, status: 'failed' }, 'refunded', { actor: 'system' }),
    );
    expect(changed).toBeNull();
    await expect(
      db.transaction((tx) => transitionOrder(tx, order, 'delivered', { actor: 'system' })),
    ).rejects.toThrow(/not an allowed transition/);
  });

  it('closes an attempt for good once it has a result', async () => {
    const item = await product();
    const buyer = await customer({ funds: usd(10) });
    const { order } = await buy(request(buyer, item));
    const attemptId = await send(order, item);
    await apply(attemptId, { status: 'failed', reason: 'Refused' });
    await expect(
      pool.query(`update fulfilment_attempts set status = 'pending' where id = $1`, [attemptId]),
    ).rejects.toThrow(/never changes/);
  });

  it('changes a webhook event only once, and only its processing', async () => {
    const id = newId();
    await pool.query(
      `insert into supplier_webhook_events (id, supplier_id, event_id, body_ciphertext)
       values ($1, $2, $3, '\\x01')`,
      [id, suppliers.fake, `evt-${unique()}`],
    );
    await expect(
      pool.query(`update supplier_webhook_events set event_id = 'x' where id = $1`, [id]),
    ).rejects.toThrow(/permission denied/);
    await pool.query(
      `update supplier_webhook_events set processed_at = now(), result = 'unknown_key' where id = $1`,
      [id],
    );
    await expect(
      pool.query(`update supplier_webhook_events set result = 'applied' where id = $1`, [id]),
    ).rejects.toThrow(/already processed/);
  });
});

describe('reads (S08 "API")', () => {
  it('shows the customer their own orders only, with stages, fields and masked codes', async () => {
    const item = await product({ kind: 'code', cost: usd(9.6) });
    const buyer = await customer({ funds: usd(100) });
    const { order } = await buy(request(buyer, item, { quantity: 2, fields: {} }));
    const attemptId = await send(order, item);
    await apply(attemptId, {
      status: 'delivered',
      quantity: 2,
      codes: ['GIFT-CODE-0000-1111', 'SHORT'],
    });

    const page = await customerOrderPage(db, buyer, { after: null, limit: 20 });
    expect(page.items).toEqual([
      expect.objectContaining({ id: order.id, stage: 'delivered', quantity: 2 }),
    ]);
    expect(page.more).toBe(false);
    expect(await customerOrder(db, await customer(), order.id)).toBeNull();

    const view = await customerOrder(db, buyer, order.id);
    expect(view?.timeline.map((entry) => entry.step)).toEqual(['paid', 'sent', 'delivered']);
    expect(view?.codes.map((code) => [code.position, code.masked, code.firstRevealedAt])).toEqual([
      [1, '••••••1111', null],
      [2, '••••••••', null],
    ]);
    expect(JSON.stringify(view)).not.toContain('GIFT-CODE');

    // A reveal decrypts one code and logs it; another customer reaches nothing.
    const codeId = view?.codes[0]?.id as string;
    const reveal = (customerId: string) =>
      db.transaction((tx) =>
        revealCode(tx, codesKey, {
          orderId: order.id,
          codeId,
          customerId,
          actor: 'customer',
          actorId: customerId,
          ipAddress: '203.0.113.7',
          userAgent: 'Test',
        }),
      );
    const first = await reveal(buyer);
    expect(first?.code).toBe('GIFT-CODE-0000-1111');
    expect((await reveal(buyer))?.firstRevealedAt).toEqual(first?.firstRevealedAt);
    expect(await reveal(await customer())).toBeNull();
    const admin = await adminOrder(db, order.id);
    expect(admin?.codes[0]?.reveals.map((r) => [r.actor, r.ipAddress])).toEqual([
      ['customer', '203.0.113.7'],
      ['customer', '203.0.113.7'],
    ]);
    expect(admin?.journals.map((j) => j.kind)).toEqual(['purchase', 'cost_of_goods']);
    expect(admin?.attempts[0]).toMatchObject({ status: 'delivered', deliveredQuantity: 2 });
    expect(JSON.stringify(admin)).not.toContain('GIFT-CODE');
  });

  it('names the order on the wallet timeline for its purchase and refund', async () => {
    const item = await product();
    const buyer = await customer({ funds: usd(10) });
    const { order } = await buy(request(buyer, item));
    await db.transaction(async (tx) =>
      refundRemaining(tx, context(), (await lockOrder(tx, order.id)) as OrderRow, 'no_route', {
        actor: 'system',
        actorId: null,
      }),
    );
    const { entries } = await walletTimeline(db, (await findCustomerWallet(db, buyer)) as string, {
      limit: 10,
    });
    const named = { id: order.id, number: order.number, productNameAr: expect.any(String) };
    expect(entries.map((entry) => [entry.kind, entry.order])).toEqual([
      ['refund', named],
      ['purchase', named],
      ['adjustment', null],
    ]);
  });

  it('filters the admin list by tab, number and email, and counts what waits', async () => {
    const item = await product();
    const buyer = await customer({ funds: usd(10) });
    const { order } = await buy(request(buyer, item));
    const query = { page: 1, pageSize: 50, tab: 'all' as const };
    const byNumber = await adminOrderPage(db, { ...query, q: order.number.toLowerCase() });
    expect(byNumber.items.map((row) => row.id)).toEqual([order.id]);
    const byEmail = await adminOrderPage(db, { ...query, q: buyer.slice(0, 13) });
    expect(byEmail.items.map((row) => row.id)).toContain(order.id);
    const active = await adminOrderPage(db, { ...query, tab: 'active', productId: item.id });
    expect(active).toMatchObject({ total: 1, items: [{ status: 'paid', supplierCode: null }] });
    const delivered = await adminOrderPage(db, { ...query, tab: 'delivered', productId: item.id });
    expect(delivered.total).toBe(0);
    const counts = await adminOrderCounts(db);
    expect(counts.needsReview).toBeGreaterThanOrEqual(0);
    expect(await adminOrder(db, newId())).toBeNull();
  });

  it('gives delivery times from five delivered orders of real customers (rule T1)', async () => {
    const item = await product();
    expect((await productDeliveryStats(db, [item.id])).get(item.id)).toBeNull();
    for (let index = 0; index < 5; index += 1) {
      const buyer = await customer({ funds: usd(10) });
      const { order } = await buy(request(buyer, item));
      await apply(await send(order, item), { status: 'delivered', quantity: 1 });
    }
    const tester = await customer({ isTest: true, funds: usd(10) });
    const { order } = await buy(request(tester, item));
    await apply(await send(order, item), { status: 'delivered', quantity: 1 });
    expect((await productDeliveryStats(db, [item.id])).get(item.id)).toMatchObject({ count: 5 });
    expect(await productDeliveryStats(db, [])).toEqual(new Map());
  });
});

describe('reservations (S09 rules RS1–RS9, PV8)', () => {
  const reserve = (
    customerId: string,
    item: { id: string; price: number },
    extra: Partial<PurchaseInput> = {},
  ) => buy(request(customerId, item, { whenBalanceShort: 'reserve', ...extra }));
  const payContext = () => ({ jobs: context().jobs, now: () => new Date(), fakeEnabled: true });
  const pay = (customerId: string) => payWaitingOrders(db, payContext(), customerId);
  const credit = async (customerId: string, amount: number) =>
    db.transaction(async (tx) => {
      await postJournal(tx, {
        idempotencyKey: `test:${newId()}`,
        kind: 'adjustment',
        postings: [
          { accountId: await ensureCustomerWallet(tx, customerId), amountUnits: amount },
          {
            accountId: await ensureSystemAccount(tx, {
              code: 'adjustments:test_funds',
              kind: 'adjustments',
              currency: 'USD',
            }),
            amountUnits: -amount,
          },
        ],
      });
    });
  const notificationsOf = async (customerId: string) =>
    (
      await db
        .select()
        .from(customerNotifications)
        .where(eq(customerNotifications.customerId, customerId))
    ).map((row) => [row.event, (row.params as { reason?: string }).reason ?? null]);
  const reprice = (id: string) =>
    db.transaction((tx) =>
      repriceProducts(tx, {
        productIds: [id],
        cause: 'rule_change',
        context: { now: new Date(), fakeEnabled: true },
      }),
    );

  it('reserves a short order without moving money, pays it in full when the balance covers it', async () => {
    const item = await product();
    const buyer = await customer({ funds: usd(0.5) });
    const before = new Date();
    const { order } = await reserve(buyer, item);
    expect(order).toMatchObject({
      status: 'awaiting_balance',
      purchaseJournalId: null,
      paidAt: null,
      totalUsdUnits: item.price,
      playerCheck: 'none',
    });
    const hours =
      ((order.expiresAt as Date).getTime() - (order.reservedAt as Date).getTime()) / 3_600_000;
    expect(hours).toBe(24);
    expect((order.reservedAt as Date).getTime()).toBeGreaterThanOrEqual(before.getTime() - 1_000);
    expect(await balance(buyer)).toBe(usd(0.5));
    const [audit] = await db
      .select()
      .from(auditEntries)
      .where(and(eq(auditEntries.entityId, order.id), eq(auditEntries.action, 'order.reserved')));
    expect(audit?.details).toMatchObject({ number: order.number, totalUsdUnits: item.price });
    expect(sent.find((job) => (job.data as { customerId?: string }).customerId === buyer)).toEqual({
      queue: QUEUES.ordersPayWaiting,
      data: { customerId: buyer },
      options: expect.objectContaining({ singletonKey: buyer }),
    });
    const [event] = await db.select().from(orderEvents).where(eq(orderEvents.orderId, order.id));
    expect([event?.fromStatus, event?.toStatus]).toEqual([null, 'awaiting_balance']);
    // `refuse` keeps S08's refusal; a covered balance pays at once even with `reserve`.
    expect(await refusal(buy(request(buyer, item)))).toMatchObject({
      code: 'INSUFFICIENT_BALANCE',
    });
    const rich = await customer({ funds: usd(10) });
    expect((await reserve(rich, item)).order.status).toBe('paid');
  });

  it('holds at most 3 open reservations, also when asked in parallel (RS2)', async () => {
    const item = await product();
    const buyer = await customer();
    const outcomes = await Promise.allSettled(
      Array.from({ length: 5 }, () => reserve(buyer, item)),
    );
    expect(outcomes.filter((o) => o.status === 'fulfilled')).toHaveLength(3);
    for (const failed of outcomes.filter((o) => o.status === 'rejected')) {
      expect((failed as PromiseRejectedResult).reason).toMatchObject({
        code: 'RESERVATIONS_LIMIT_REACHED',
        details: { limit: 3 },
      });
    }
    // One key with `reserve` sent twice at once makes one reservation.
    const other = await customer();
    const input = request(other, item, { whenBalanceShort: 'reserve' });
    const results = await Promise.all([buy(input), buy(input)]);
    expect(results.map((r) => r.created).sort()).toEqual([false, true]);
  });

  it('records the player check and asks for a confirmation when the id is not known valid (PV8)', async () => {
    const item = await product();
    const buyer = await customer({ funds: usd(10) });
    const valid = await buy(
      request(buyer, item, { playerCheck: async () => ({ result: 'valid', playerName: 'Hero' }) }),
    );
    expect(valid.order).toMatchObject({ playerCheck: 'valid', playerName: 'Hero' });
    for (const result of ['invalid', 'none'] as const) {
      const lookup = async () => ({ result });
      expect(await refusal(buy(request(buyer, item, { playerCheck: lookup })))).toMatchObject({
        code: 'PLAYER_NOT_CONFIRMED',
      });
      const confirmed = await buy(
        request(buyer, item, { playerCheck: lookup, confirmPlayer: true }),
      );
      expect(confirmed.order.playerCheck).toBe(
        result === 'invalid' ? 'invalid_confirmed' : 'unchecked_confirmed',
      );
    }
    // No check possible: the confirmation is ignored.
    const none = await buy(request(buyer, item, { confirmPlayer: true }));
    expect(none.order).toMatchObject({ playerCheck: 'none', playerName: null });
  });

  it('pays reservations after a credit, oldest first, skipping one the balance cannot cover (RS4)', async () => {
    const cheap = await product({ cost: usd(0.5) });
    const dear = await product({ cost: usd(5) });
    const buyer = await customer();
    const older = (await reserve(buyer, dear)).order;
    const newer = (await reserve(buyer, cheap)).order;
    await credit(buyer, cheap.price + usd(1));
    const result = await pay(buyer);
    expect(result).toEqual({
      stopped: false,
      outcomes: [
        { orderId: older.id, outcome: 'skipped_balance' },
        { orderId: newer.id, outcome: 'paid' },
      ],
    });
    expect(await balance(buyer)).toBe(usd(1));
    const paid = await orderRow(newer.id);
    expect(paid).toMatchObject({ status: 'paid', unitPriceUsdUnits: cheap.price });
    expect(paid.purchaseJournalId).not.toBeNull();
    expect(paid.paidAt).not.toBeNull();
    expect((await orderRow(older.id)).status).toBe('awaiting_balance');
    const [audit] = await db
      .select()
      .from(auditEntries)
      .where(and(eq(auditEntries.entityId, newer.id), eq(auditEntries.action, 'order.paid')));
    expect(audit).toMatchObject({ actorKind: 'system', channel: 'worker' });
    expect(audit?.details).toMatchObject({ priceSource: 'saved' });
    expect(await notificationsOf(buyer)).toEqual([['order_paid', null]]);
    expect(sent.some((job) => (job.data as { orderId?: string }).orderId === newer.id)).toBe(true);
    // Run again: nothing more to pay, nothing paid twice.
    expect((await pay(buyer)).outcomes).toEqual([
      { orderId: older.id, outcome: 'skipped_balance' },
    ]);
    expect(await balance(buyer)).toBe(usd(1));
  });

  it('pays one reservation once when two runs race (edge case: two credits at once)', async () => {
    const item = await product();
    const buyer = await customer();
    const { order } = await reserve(buyer, item);
    await credit(buyer, item.price * 3);
    const runs = await Promise.all([pay(buyer), pay(buyer), pay(buyer)]);
    expect(runs.flatMap((run) => run.outcomes).filter((o) => o.outcome === 'paid')).toHaveLength(1);
    expect(await balance(buyer)).toBe(item.price * 2);
    expect((await orderRow(order.id)).status).toBe('paid');
  });

  it('charges a lower current price, keeps a saved one while it stays profitable (RS6)', async () => {
    const fell = await product({ cost: usd(2) });
    const rose = await product({ cost: usd(2) });
    const buyer = await customer();
    const a = (await reserve(buyer, fell)).order;
    const b = (await reserve(buyer, rose)).order;
    // Fall: a cheaper route. Rise: a bigger markup, the minimum margin unchanged.
    // 10% exactly applies at once (rule P3).
    await pool.query('update supplier_offers set cost_usd_units = $1 where id = $2', [
      usd(1.8),
      fell.offer,
    ]);
    await reprice(fell.id);
    await pool.query(`update margin_rules set percent_bp = 5000 where target_id = $1`, [rose.id]);
    await reprice(rose.id);
    await credit(buyer, usd(20));
    await pay(buyer);
    const [current] = await db
      .select()
      .from(productPrices)
      .where(eq(productPrices.productId, fell.id))
      .orderBy(desc(productPrices.createdAt))
      .limit(1);
    expect(await orderRow(a.id)).toMatchObject({
      status: 'paid',
      unitPriceUsdUnits: current?.priceUsdUnits,
      priceId: current?.id,
    });
    expect((current?.priceUsdUnits as number) < fell.price).toBe(true);
    expect(await orderRow(b.id)).toMatchObject({
      status: 'paid',
      unitPriceUsdUnits: rose.price,
      priceId: b.priceId,
    });
    expect(await balance(buyer)).toBe(usd(20) - (current?.priceUsdUnits as number) - rose.price);
    const [audit] = await db
      .select()
      .from(auditEntries)
      .where(and(eq(auditEntries.entityId, a.id), eq(auditEntries.action, 'order.paid')));
    expect(audit?.details).toMatchObject({ priceSource: 'current' });
  });

  it('cancels a reservation whose saved price lost its margin, or whose fields changed (RS4, RS9)', async () => {
    const rose = await product();
    const changed = await product();
    const buyer = await customer();
    const a = (await reserve(buyer, rose)).order;
    const b = (await reserve(buyer, changed)).order;
    await pool.query(`update margin_rules set min_margin_usd_units = $1 where target_id = $2`, [
      usd(1),
      rose.id,
    ]);
    await reprice(rose.id);
    await pool.query(
      `insert into catalog_input_fields (id, game_id, key, label_ar, type, required, sort_order)
       values ($1, $2, 'server', 'الخادم', 'text', true, 2)`,
      [newId(), changed.game],
    );
    await credit(buyer, usd(10));
    expect((await pay(buyer)).outcomes.map((o) => o.outcome)).toEqual([
      'cancelled_price_rose',
      'cancelled_product_changed',
    ]);
    expect(await orderRow(a.id)).toMatchObject({ status: 'cancelled', cancelReason: 'price_rose' });
    expect(await orderRow(b.id)).toMatchObject({
      status: 'cancelled',
      cancelReason: 'product_changed',
    });
    expect((await orderRow(a.id)).finishedAt).not.toBeNull();
    expect(await balance(buyer)).toBe(usd(10));
    expect((await notificationsOf(buyer)).sort()).toEqual([
      ['order_cancelled', 'price_rose'],
      ['order_cancelled', 'product_changed'],
    ]);
  });

  it('waits while purchases are stopped or the product is unavailable (RS4 steps 1, 3)', async () => {
    const item = await product();
    const buyer = await customer();
    const { order } = await reserve(buyer, item);
    await credit(buyer, usd(10));
    await db.insert(storeSwitchChanges).values({
      id: newId(),
      switch: 'purchases_stopped',
      value: true,
      adminId: newId(),
      channel: 'admin',
    });
    try {
      expect(await pay(buyer)).toEqual({ stopped: true, outcomes: [] });
    } finally {
      await db.insert(storeSwitchChanges).values({
        id: newId(),
        switch: 'purchases_stopped',
        value: false,
        adminId: newId(),
        channel: 'admin',
      });
    }
    await pool.query(`update catalog_products set status = 'paused' where id = $1`, [item.id]);
    expect((await pay(buyer)).outcomes).toEqual([
      { orderId: order.id, outcome: 'skipped_unavailable' },
    ]);
    expect((await orderRow(order.id)).status).toBe('awaiting_balance');
    expect(await balance(buyer)).toBe(usd(10));
  });

  it('lets the customer cancel an own reservation only, and settles races by the order lock (RS8, edge cases 6, 7)', async () => {
    const item = await product();
    const buyer = await customer();
    const stranger = await customer();
    const { order } = await reserve(buyer, item);
    const cancel = (customerId: string, orderId = order.id) =>
      db.transaction((tx) => cancelOwnReservation(tx, context(), { orderId, customerId }));
    expect(await refusal(cancel(stranger))).toMatchObject({ code: 'NOT_FOUND' });
    // Cancel and pay at once: exactly one wins.
    await credit(buyer, usd(10));
    const [cancelled, paid] = await Promise.allSettled([cancel(buyer), pay(buyer)]);
    const final = await orderRow(order.id);
    if (final.status === 'cancelled') {
      expect(cancelled.status).toBe('fulfilled');
      expect(final.cancelReason).toBe('customer');
      expect(await balance(buyer)).toBe(usd(10));
    } else {
      expect(final.status).toBe('paid');
      expect((cancelled as PromiseRejectedResult).reason).toMatchObject({
        code: 'ORDER_NOT_CANCELLABLE',
        details: { status: 'paid' },
      });
    }
    expect(paid.status).toBe('fulfilled');
    // The customer is not notified of their own cancel.
    expect((await notificationsOf(buyer)).filter(([event]) => event === 'order_cancelled')).toEqual(
      [],
    );
    const settled = (await reserve(buyer, item, {})).order;
    expect(settled.status).toBe('paid');
    expect(await refusal(cancel(buyer, settled.id))).toMatchObject({
      code: 'ORDER_NOT_CANCELLABLE',
    });
  });

  it('expires reservations past their deadline, and never pays one (RS7, A15)', async () => {
    const item = await product();
    const buyer = await customer();
    const { order } = await reserve(buyer, item);
    await owner.pool.query('alter table orders disable trigger orders_guard');
    try {
      await owner.pool.query(
        `update orders set reserved_at = reserved_at - interval '25 hours',
           expires_at = expires_at - interval '25 hours' where id = $1`,
        [order.id],
      );
    } finally {
      await owner.pool.query('alter table orders enable trigger orders_guard');
    }
    await credit(buyer, usd(10));
    expect((await pay(buyer)).outcomes).toEqual([]);
    expect(await expireReservations(db, context(), 100)).toBeGreaterThanOrEqual(1);
    expect(await orderRow(order.id)).toMatchObject({
      status: 'cancelled',
      cancelReason: 'expired',
    });
    expect(await notificationsOf(buyer)).toEqual([['order_cancelled', 'expired']]);
    const [audit] = await db
      .select()
      .from(auditEntries)
      .where(and(eq(auditEntries.entityId, order.id), eq(auditEntries.action, 'order.cancelled')));
    expect(audit).toMatchObject({ actorKind: 'system', details: { reason: 'expired' } });
  });

  it('keeps the guard: prices change only when a reservation is paid, reservation columns never (migration 0035)', async () => {
    const item = await product();
    const buyer = await customer();
    const { order } = await reserve(buyer, item);
    await expect(
      pool.query(
        'update orders set unit_price_usd_units = 10000, total_usd_units = 10000 where id = $1',
        [order.id],
      ),
    ).rejects.toThrow(/fixed once paid/);
    await expect(
      pool.query(`update orders set expires_at = now() + interval '9 days' where id = $1`, [
        order.id,
      ]),
    ).rejects.toThrow(/identity and fields are fixed/);
    await expect(
      pool.query(`update orders set status = 'cancelled', finished_at = now() where id = $1`, [
        order.id,
      ]),
    ).rejects.toThrow(/orders_reservation_check/);
    await expect(
      pool.query(`update orders set status = 'paid' where id = $1`, [order.id]),
    ).rejects.toThrow(/orders_purchase_journal_check/);
    await credit(buyer, usd(10));
    await pay(buyer);
    await expect(
      pool.query(
        'update orders set unit_price_usd_units = 10000, total_usd_units = 10000 where id = $1',
        [order.id],
      ),
    ).rejects.toThrow(/fixed once paid/);
  });

  it('lets the app role read, add and delete player checks, never change one', async () => {
    const item = await product();
    const buyer = await customer();
    const id = newId();
    await db.insert(playerChecks).values({
      id,
      gameId: item.game,
      fieldsHash: 'a'.repeat(64),
      result: 'valid',
      playerName: 'Hero',
      supplierId: suppliers.fake,
      customerId: buyer,
      expiresAt: new Date(Date.now() + 60_000),
    });
    await expect(
      pool.query(`update player_checks set result = 'invalid' where id = $1`, [id]),
    ).rejects.toThrow(/permission denied/);
    await expect(
      pool.query(
        `insert into player_checks (id, game_id, fields_hash, result, player_name, supplier_id, customer_id, expires_at)
         values ($1, $2, $3, 'invalid', 'X', $4, $5, now() + interval '1 hour')`,
        [newId(), item.game, 'b'.repeat(64), suppliers.fake, buyer],
      ),
    ).rejects.toThrow(/player_checks_player_name_check/);
    await db.delete(playerChecks).where(eq(playerChecks.id, id));
  });
});
