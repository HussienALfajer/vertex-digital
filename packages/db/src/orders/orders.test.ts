import { createHash, randomBytes } from 'node:crypto';
import { CURRENCY_SCALE, priceFromCost, QUEUES } from '@vertex-digital/contracts';
import { and, desc, eq, sql } from 'drizzle-orm';
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
  checkouts,
  customerNotifications,
  customers,
  emailOutbox,
  fulfilmentAttempts,
  orderCodes,
  orderEvents,
  orderShareLinks,
  orders,
  playerChecks,
  productPrices,
  savedPlayers,
  storeSwitchChanges,
} from '../schema/index.js';
import {
  ADMIN_CLOSE_REASONS,
  closeForAdminRefund,
  fulfilOrderManually,
  type ManualFulfilInput,
  rerouteOptions,
  rerouteOrder,
} from './admin-actions.js';
import { type CheckoutInput, checkoutOrders } from './checkout.js';
import { applyOutcome, refundRemaining } from './outcome.js';
import { OrderError, type PurchaseInput, purchaseOrder } from './purchase.js';
import {
  adminOrder,
  adminOrderCounts,
  adminOrderPage,
  customerCheckout,
  customerOrder,
  customerOrderPage,
  productDeliveryStats,
  revealCode,
} from './reads.js';
import {
  cancelOwnReservation,
  expireReservations,
  payWaitingOrders,
  purchasesStoppedLocked,
} from './reservations.js';
import { savedPlayerHash } from './saved-players.js';
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
    expect(again).toEqual({ order: first.order, created: false, savedPlayer: null });
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

  /** Holds `work`'s transaction open until the returned release is called. */
  function holding(work: (tx: Transaction) => Promise<unknown>) {
    let release: () => void = () => {};
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    let ready: () => void = () => {};
    const started = new Promise<void>((resolve) => {
      ready = resolve;
    });
    const done = db.transaction(async (tx) => {
      await work(tx);
      ready();
      await held;
    });
    return { started, release, done };
  }
  const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

  it('pays at the price a repricing that held the product commits (RS4 step 3, RS6)', async () => {
    const item = await product({ cost: usd(2) });
    const buyer = await customer();
    const { order } = await reserve(buyer, item);
    await credit(buyer, usd(10));
    await pool.query('update supplier_offers set cost_usd_units = $1 where id = $2', [
      usd(1.8),
      item.offer,
    ]);
    // The repricing holds the product `FOR UPDATE`; the payment waits for it on `FOR SHARE`.
    const repricing = holding((tx) =>
      repriceProducts(tx, {
        productIds: [item.id],
        cause: 'rule_change',
        context: { now: new Date(), fakeEnabled: true },
      }),
    );
    await repricing.started;
    const paying = pay(buyer);
    await pause(300);
    repricing.release();
    await repricing.done;
    expect((await paying).outcomes).toEqual([{ orderId: order.id, outcome: 'paid' }]);
    const [current] = await db
      .select()
      .from(productPrices)
      .where(eq(productPrices.productId, item.id))
      .orderBy(desc(productPrices.createdAt))
      .limit(1);
    expect((current?.priceUsdUnits as number) < item.price).toBe(true);
    expect(await orderRow(order.id)).toMatchObject({
      unitPriceUsdUnits: current?.priceUsdUnits,
      priceId: current?.id,
    });
    expect(await balance(buyer)).toBe(usd(10) - (current?.priceUsdUnits as number));
  });

  it('pays nothing when a stop commits while the payment waits on the switches lock (SW7)', async () => {
    const item = await product();
    const buyer = await customer();
    const { order } = await reserve(buyer, item);
    await credit(buyer, usd(10));
    const stopping = holding(async (tx) => {
      await tx.execute(sql`select pg_advisory_xact_lock(hashtext('settings'))`);
      await tx.insert(storeSwitchChanges).values({
        id: newId(),
        switch: 'purchases_stopped',
        value: true,
        adminId: newId(),
        channel: 'admin',
      });
    });
    await stopping.started;
    const paying = pay(buyer);
    await pause(300);
    stopping.release();
    await stopping.done;
    try {
      expect(await paying).toEqual({ stopped: true, outcomes: [] });
      expect((await orderRow(order.id)).status).toBe('awaiting_balance');
      expect(await balance(buyer)).toBe(usd(10));
    } finally {
      await db.insert(storeSwitchChanges).values({
        id: newId(),
        switch: 'purchases_stopped',
        value: false,
        adminId: newId(),
        channel: 'admin',
      });
    }
  });

  it('settles a payment and an expiry at the deadline with one of them (edge case 7)', async () => {
    for (let round = 0; round < 3; round += 1) {
      const item = await product();
      const buyer = await customer();
      const { order } = await reserve(buyer, item);
      await credit(buyer, usd(10));
      await owner.pool.query('alter table orders disable trigger orders_guard');
      try {
        await owner.pool.query(
          `update orders set expires_at = now() + interval '300 milliseconds' where id = $1`,
          [order.id],
        );
      } finally {
        await owner.pool.query('alter table orders enable trigger orders_guard');
      }
      await pause(250 + round * 40);
      await Promise.all([pay(buyer), expireReservations(db, context(), 100), pause(100)]);
      await expireReservations(db, context(), 100);
      const final = await orderRow(order.id);
      if (final.status === 'paid') {
        expect(await balance(buyer)).toBe(usd(10) - item.price);
      } else {
        expect(final).toMatchObject({ status: 'cancelled', cancelReason: 'expired', paidAt: null });
        expect(await balance(buyer)).toBe(usd(10));
      }
    }
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
    expect((await expireReservations(db, context(), 100)).length).toBeGreaterThanOrEqual(1);
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

describe('checkouts, saved ids, gifts and share links (S10)', () => {
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
  const line = (item: { id: string; price: number }, overrides: object = {}) => ({
    productId: item.id,
    quantity: 1,
    fields: { player_id: '5123456789' },
    expectedUnitPriceUsdUnits: item.price,
    confirmPlayer: false,
    ...overrides,
  });
  const cart = (
    customerId: string,
    lines: CheckoutInput['lines'],
    overrides: Partial<CheckoutInput> = {},
  ): CheckoutInput => ({
    customerId,
    lines,
    idempotencyKey: newId(),
    requestHash: hash({ lines }),
    fakeEnabled: true,
    purchasesStopped: false,
    channel: 'store',
    playerCheck: async () => null,
    ...overrides,
  });
  const pay = (input: CheckoutInput) =>
    db.transaction((tx) => checkoutOrders(tx, context(), input));
  const journalAmount = async (journalId: string) => {
    const { rows } = await pool.query<{ amount: string }>(
      'select sum(amount_units) filter (where amount_units > 0) as amount from ledger_postings where journal_id = $1',
      [journalId],
    );
    return Number(rows[0]?.amount);
  };
  const deliver = async (order: OrderRow, item: Awaited<ReturnType<typeof product>>) =>
    apply(await send(order, item), { status: 'delivered', quantity: order.quantity });
  const refund = async (order: OrderRow, item: Awaited<ReturnType<typeof product>>) =>
    apply(await send(order, item), { status: 'failed', reason: 'bad id', inputRejected: true });
  const notifications = async (customerId: string) =>
    db
      .select({ event: customerNotifications.event, params: customerNotifications.params })
      .from(customerNotifications)
      .where(eq(customerNotifications.customerId, customerId))
      .orderBy(customerNotifications.createdAt, customerNotifications.id);
  const emails = async (customerId: string) =>
    (
      await db
        .select({ template: emailOutbox.template })
        .from(emailOutbox)
        .where(eq(emailOutbox.customerId, customerId))
    ).map((row) => row.template);

  it('pays every line with one journal, one order per line, in line order (CT5, M1)', async () => {
    const [first, second] = [await product(), await product({ kind: 'code' })];
    const buyer = await customer({ funds: usd(10) });
    sent.length = 0;
    const input = cart(buyer, [
      line(first, { gift: { senderName: 'أحمد', message: 'كل عام وأنت بخير' } }),
      line(second, { fields: {}, quantity: 2 }),
    ]);
    const { checkout, orders: paid, created } = await pay(input);
    expect(created).toBe(true);
    const total = first.price + second.price * 2;
    expect(checkout).toMatchObject({
      customerId: buyer,
      isTest: false,
      lineCount: 2,
      totalUsdUnits: total,
      finishedAt: null,
    });
    expect(paid.map((order) => [order.checkoutLine, order.status, order.productId])).toEqual([
      [1, 'paid', first.id],
      [2, 'paid', second.id],
    ]);
    expect(paid.every((order) => order.purchaseJournalId === checkout.purchaseJournalId)).toBe(
      true,
    );
    expect(paid[0]).toMatchObject({
      isGift: true,
      giftSenderName: 'أحمد',
      giftMessage: 'كل عام وأنت بخير',
    });
    expect(await journalAmount(checkout.purchaseJournalId)).toBe(total);
    expect(await balance(buyer)).toBe(usd(10) - total);
    // The journal equals the sum of its orders (S13's nightly check).
    const { rows } = await pool.query<{ sum: string }>(
      'select sum(total_usd_units) as sum from orders where checkout_id = $1',
      [checkout.id],
    );
    expect(Number(rows[0]?.sum)).toBe(total);
    expect(sent.filter((job) => job.queue === QUEUES.ordersFulfil)).toHaveLength(2);
    const audits = await db
      .select({ details: auditEntries.details })
      .from(auditEntries)
      .where(eq(auditEntries.entityId, paid[0]?.id as string));
    expect(audits[0]?.details).toMatchObject({ checkoutId: checkout.id, gift: true });
    const links = await db
      .select()
      .from(orderShareLinks)
      .where(eq(orderShareLinks.orderId, paid[0]?.id as string));
    expect(links).toHaveLength(1);
    expect(links[0]).toMatchObject({ kind: 'gift', showPrice: false, playerDisplay: 'masked' });
    expect(links[0]?.token).toMatch(/^[A-Za-z0-9_-]{22}$/);

    // One wallet entry names the checkout and its orders (W5).
    const timeline = await walletTimeline(db, (await findCustomerWallet(db, buyer)) as string, {
      limit: 5,
    });
    expect(timeline.entries[0]).toMatchObject({
      kind: 'purchase',
      amountUnits: -total,
      order: null,
      checkout: {
        id: checkout.id,
        orderCount: 2,
        orders: paid
          .map((order) => ({ id: order.id, number: order.number }))
          .map((o) => expect.objectContaining(o)),
      },
    });

    // The same key and body replays; another body is refused.
    const replay = await pay(input);
    expect(replay.created).toBe(false);
    expect(replay.checkout.id).toBe(checkout.id);
    expect(replay.orders.map((order) => order.id)).toEqual(paid.map((order) => order.id));
    expect(await refusal(pay({ ...input, requestHash: hash({ other: true }) }))).toMatchObject({
      code: 'IDEMPOTENCY_KEY_REUSED',
    });
    expect(await customerCheckout(db, buyer, checkout.id)).toMatchObject({
      checkout: { id: checkout.id, orderCount: 2, totalUsdUnits: total, finishedAt: null },
      items: [
        { id: paid[0]?.id, isGift: true },
        { id: paid[1]?.id, isGift: false },
      ],
    });
    expect(await customerCheckout(db, await customer(), checkout.id)).toBeNull();
  });

  it('refuses the whole cart with every line’s reason, writing nothing (CT5 step 3)', async () => {
    const [ok, dear, code, checked] = [
      await product(),
      await product(),
      await product({ kind: 'code' }),
      await product(),
    ];
    const buyer = await customer({ funds: usd(20) });
    const failure = await refusal(
      pay(
        cart(
          buyer,
          [
            line(ok),
            line(dear, { expectedUnitPriceUsdUnits: dear.price - 10_000 }),
            line({ id: newId(), price: usd(1) }),
            line(code, { fields: {}, gift: {} }),
            line(ok, { fields: { player_id: 'abc' } }),
            line(checked),
          ],
          {
            playerCheck: async (_tx, order) =>
              order.productId === checked.id ? { result: 'invalid' } : null,
          },
        ),
      ),
    );
    expect(failure).toEqual({
      code: 'CHECKOUT_REFUSED',
      details: {
        lines: [
          { index: 1, code: 'PRICE_CHANGED', details: { unitPriceUsdUnits: dear.price } },
          { index: 2, code: 'PRODUCT_UNAVAILABLE', details: { availability: 'hidden' } },
          { index: 3, code: 'VALIDATION_FAILED', details: { gift: 'code_product' } },
          {
            index: 4,
            code: 'VALIDATION_FAILED',
            details: { fields: { player_id: expect.any(String) } },
          },
          { index: 5, code: 'PLAYER_NOT_CONFIRMED', details: { result: 'invalid' } },
        ],
      },
    });
    expect(await balance(buyer)).toBe(usd(20));
    expect(await db.select().from(checkouts).where(eq(checkouts.customerId, buyer))).toEqual([]);
  });

  it('refuses a short balance with the shortfall, and a stop (edge cases 3, 4)', async () => {
    const item = await product();
    const buyer = await customer({ funds: usd(0.5) });
    expect(await refusal(pay(cart(buyer, [line(item)])))).toEqual({
      code: 'INSUFFICIENT_BALANCE',
      details: { balanceUnits: usd(0.5), totalUnits: item.price },
    });
    expect(await refusal(pay(cart(buyer, [line(item)], { purchasesStopped: true })))).toMatchObject(
      { code: 'PURCHASES_STOPPED' },
    );
    expect(await balance(buyer)).toBe(usd(0.5));
  });

  it('pays one key once in parallel (edge case 5)', async () => {
    const item = await product();
    const buyer = await customer({ funds: usd(10) });
    const input = cart(buyer, [line(item)]);
    const results = await Promise.all([pay(input), pay(input), pay(input)]);
    expect(new Set(results.map((result) => result.checkout.id)).size).toBe(1);
    expect(results.filter((result) => result.created)).toHaveLength(1);
    expect(await balance(buyer)).toBe(usd(10) - item.price);
  });

  it('never deadlocks two checkouts that share products in opposite order', async () => {
    const [a, b] = [await product(), await product()];
    const buyers = [await customer({ funds: usd(10) }), await customer({ funds: usd(10) })];
    const results = await Promise.all(
      Array.from({ length: 6 }, (_, index) =>
        pay(cart(buyers[index % 2] as string, index % 2 ? [line(a), line(b)] : [line(b), line(a)])),
      ),
    );
    expect(results.every((result) => result.created)).toBe(true);
  });

  it('never takes the balance below zero when a checkout and a purchase race for it', async () => {
    const item = await product();
    const buyer = await customer({ funds: item.price * 2 });
    const settled = await Promise.allSettled([
      pay(cart(buyer, [line(item), line(item)])),
      buy(request(buyer, item)),
    ]);
    expect(settled.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect(await balance(buyer)).toBeGreaterThanOrEqual(0);
  });

  it('pays at the price a repricing that held a product commits, or refuses it (CT5 step 2)', async () => {
    const item = await product({ cost: usd(2) });
    const buyer = await customer({ funds: usd(10) });
    await pool.query('update supplier_offers set cost_usd_units = $1 where id = $2', [
      usd(1.8),
      item.offer,
    ]);
    let release: () => void = () => {};
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    let ready: () => void = () => {};
    const started = new Promise<void>((resolve) => {
      ready = resolve;
    });
    const repricing = db.transaction(async (tx) => {
      await repriceProducts(tx, {
        productIds: [item.id],
        cause: 'rule_change',
        context: { now: new Date(), fakeEnabled: true },
      });
      ready();
      await held;
    });
    await started;
    const paying = refusal(pay(cart(buyer, [line(item)])));
    await new Promise((resolve) => setTimeout(resolve, 300));
    release();
    await repricing;
    const failure = await paying;
    expect(failure.code).toBe('CHECKOUT_REFUSED');
    expect(await balance(buyer)).toBe(usd(10));
  });

  it('refuses a checkout once a stop commits while it waits on the switches lock', async () => {
    const item = await product();
    const buyer = await customer({ funds: usd(10) });
    const stop = (value: boolean) =>
      db.transaction(async (tx) => {
        await tx.execute(sql`select pg_advisory_xact_lock(hashtext('settings'))`);
        await tx.insert(storeSwitchChanges).values({
          id: newId(),
          switch: 'purchases_stopped',
          value,
          adminId: newId(),
          channel: 'admin',
        });
      });
    await stop(true);
    try {
      const failure = await refusal(
        db.transaction(async (tx) =>
          checkoutOrders(
            tx,
            context(),
            cart(buyer, [line(item)], { purchasesStopped: await purchasesStoppedLocked(tx) }),
          ),
        ),
      );
      expect(failure.code).toBe('PURCHASES_STOPPED');
    } finally {
      await stop(false);
    }
  });

  it('tells the center of each order without email, then sends one summary (CT7, CT8)', async () => {
    const [first, second, third] = [await product(), await product(), await product()];
    const buyer = await customer({ funds: usd(10) });
    const { checkout, orders: paid } = await pay(
      cart(buyer, [line(first), line(second), line(third)]),
    );
    const [one, two, three] = paid as [OrderRow, OrderRow, OrderRow];
    await deliver(one, first);
    await refund(two, second);
    const held = await send(three, third);
    await apply(held, { status: 'unknown', reason: 'timeout' });
    expect((await notifications(buyer)).map((row) => row.event)).toEqual([
      'order_delivered',
      'order_refunded',
    ]);
    expect(await emails(buyer)).toEqual([]);
    expect(
      (await db.select().from(checkouts).where(eq(checkouts.id, checkout.id)))[0]?.finishedAt,
    ).toBeNull();
    await apply(held, { status: 'delivered', quantity: 1 });
    const rows = await notifications(buyer);
    expect(rows.map((row) => row.event)).toEqual([
      'order_delivered',
      'order_refunded',
      'order_delivered',
      'checkout_finished',
    ]);
    expect(rows.at(-1)?.params).toEqual({
      checkoutId: checkout.id,
      orderCount: 3,
      delivered: 2,
      partiallyRefunded: 0,
      refunded: 1,
      refundedUsdUnits: second.price,
    });
    expect(await emails(buyer)).toEqual(['customer_checkout_finished']);
    expect(
      (await db.select().from(checkouts).where(eq(checkouts.id, checkout.id)))[0]?.finishedAt,
    ).not.toBeNull();
  });

  it('sends the summary once when two orders finish together (edge case 7)', async () => {
    for (let round = 0; round < 3; round += 1) {
      const [first, second] = [await product(), await product()];
      const buyer = await customer({ funds: usd(10) });
      const { orders: paid } = await pay(cart(buyer, [line(first), line(second)]));
      const [one, two] = paid as [OrderRow, OrderRow];
      const attempts = [await send(one, first), await send(two, second)];
      await Promise.all(
        attempts.map((attemptId) => apply(attemptId, { status: 'delivered', quantity: 1 })),
      );
      const finished = (await notifications(buyer)).filter(
        (row) => row.event === 'checkout_finished',
      );
      expect(finished).toHaveLength(1);
    }
  });

  it('saves an id under its limits, refreshes it and marks a supplier refusal (SP1–SP6)', async () => {
    const item = await product();
    const buyer = await customer({ funds: usd(20) });
    const fields = { player_id: '5123456789' };
    const valid = async () => ({ result: 'valid' as const, playerName: 'Hero' });
    const first = await buy(
      request(buyer, item, { savePlayer: { label: 'حسابي' }, playerCheck: valid }),
    );
    expect(first.savedPlayer).toMatchObject({
      label: 'حسابي',
      fields,
      fieldsHash: savedPlayerHash(item.game, fields),
      playerName: 'Hero',
      rejectedAt: null,
    });
    expect(first.savedPlayer?.lastUsedAt).not.toBeNull();
    // Saving again keeps the old label (edge case 9); a replay answers the saved row.
    const again = await buy(request(buyer, item, { savePlayer: { label: 'أخي' } }));
    expect(again.savedPlayer?.id).toBe(first.savedPlayer?.id);
    expect(again.savedPlayer?.label).toBe('حسابي');
    // A refusal by the supplier marks it (SP6); a delivery clears the mark.
    await refund(again.order, item);
    const [marked] = await db.select().from(savedPlayers).where(eq(savedPlayers.customerId, buyer));
    expect(marked?.rejectedAt).not.toBeNull();
    const third = await buy(request(buyer, item));
    expect(third.savedPlayer).toBeNull();
    await deliver(third.order, item);
    const [cleared] = await db
      .select()
      .from(savedPlayers)
      .where(eq(savedPlayers.customerId, buyer));
    expect(cleared?.rejectedAt).toBeNull();
    expect(cleared?.playerName).toBe('Hero');

    // At the game's limit the purchase goes on without saving (SP1, edge case 24).
    for (let index = 1; index < 10; index += 1) {
      await db.insert(savedPlayers).values({
        id: newId(),
        customerId: buyer,
        gameId: item.game,
        label: `id ${index}`,
        fields: { player_id: `90000000${index}` },
        fieldsHash: savedPlayerHash(item.game, { player_id: `90000000${index}` }),
      });
    }
    const full = await buy(
      request(buyer, item, { fields: { player_id: '777777777' }, savePlayer: { label: 'جديد' } }),
    );
    expect(full.created).toBe(true);
    expect(full.savedPlayer).toBeNull();
    // The unique hash keeps one row per id (edge case 9).
    await expect(
      db.insert(savedPlayers).values({
        id: newId(),
        customerId: buyer,
        gameId: item.game,
        label: 'نسخة',
        fields,
        fieldsHash: savedPlayerHash(item.game, fields),
      }),
    ).rejects.toThrow();
  });

  it('makes a gift link when a reserved gift is paid, never for a cancelled one (GF2)', async () => {
    const item = await product();
    const buyer = await customer();
    const reserve = (gift: object) =>
      buy(request(buyer, item, { whenBalanceShort: 'reserve', gift }));
    const { order: kept } = await reserve({ message: 'مبروك' });
    const { order: dropped } = await reserve({});
    await db.transaction((tx) =>
      cancelOwnReservation(tx, context(), { customerId: buyer, orderId: dropped.id }),
    );
    expect(
      await db.select().from(orderShareLinks).where(eq(orderShareLinks.orderId, kept.id)),
    ).toEqual([]);
    await credit(buyer, usd(10));
    await payWaitingOrders(db, { ...context(), now: () => new Date(), fakeEnabled: true }, buyer);
    expect(
      await db.select().from(orderShareLinks).where(eq(orderShareLinks.orderId, kept.id)),
    ).toHaveLength(1);
    expect(
      await db.select().from(orderShareLinks).where(eq(orderShareLinks.orderId, dropped.id)),
    ).toEqual([]);
    expect(
      await refusal(buy(request(buyer, await product({ kind: 'code' }), { fields: {}, gift: {} }))),
    ).toMatchObject({ code: 'VALIDATION_FAILED', details: { gift: 'code_product' } });
  });

  it('reads the checkout, the gift, the links and rule OT3 for the customer and the admin', async () => {
    const item = await product();
    const buyer = await customer({ funds: usd(10) });
    const { checkout, orders: paid } = await pay(
      cart(buyer, [line(item, { gift: { message: 'مبروك' } })]),
    );
    const order = paid[0] as OrderRow;
    const view = await customerOrder(db, buyer, order.id, 'https://store.test');
    expect(view).toMatchObject({
      checkoutId: checkout.id,
      isGift: true,
      gift: { senderName: null, message: 'مبروك' },
      repeatable: false,
      shareLinks: [{ kind: 'gift', showPrice: false, playerDisplay: 'masked' }],
    });
    expect(view?.shareLinks[0]?.url).toMatch(/^https:\/\/store\.test\/g\/[A-Za-z0-9_-]{22}$/);
    await deliver(order, item);
    expect((await customerOrder(db, buyer, order.id))?.repeatable).toBe(true);
    const page = await customerOrderPage(db, buyer, { after: null, limit: 5 });
    expect(page.items[0]).toMatchObject({
      checkoutId: checkout.id,
      isGift: true,
      repeatable: true,
    });
    // A paused game is not shown: no repeat (OT3).
    await pool.query(`update catalog_games set status = 'paused' where id = $1`, [item.game]);
    expect((await customerOrder(db, buyer, order.id))?.repeatable).toBe(false);

    const admin = await adminOrder(db, order.id);
    expect(admin).toMatchObject({
      checkout: {
        id: checkout.id,
        orderCount: 1,
        totalUsdUnits: item.price,
        orders: [{ id: order.id, number: order.number, line: 1, status: 'delivered' }],
      },
      gift: { senderName: null, message: 'مبروك' },
      shareLinks: [{ kind: 'gift', revokedAt: null, revokedBy: null, revokeReason: null }],
    });
    expect(admin?.checkout?.finishedAt).not.toBeNull();
    const found = await adminOrderPage(db, {
      page: 1,
      pageSize: 10,
      tab: 'all',
      q: checkout.id.toUpperCase(),
    });
    expect(found.items.map((row) => [row.id, row.checkoutId, row.isGift])).toEqual([
      [order.id, checkout.id, true],
    ]);
  });

  it('guards checkouts, checkout orders, gifts and share links', async () => {
    const item = await product();
    const buyer = await customer({ funds: usd(10) });
    const { checkout, orders: paid } = await pay(
      cart(buyer, [line(item, { gift: { senderName: 'أحمد' } })]),
    );
    const order = paid[0] as OrderRow;
    // Only `finished_at`, once (CT7), and never deleted.
    await expect(
      pool.query('update checkouts set total_usd_units = 10000 where id = $1', [checkout.id]),
    ).rejects.toThrow(/only finished_at changes/);
    await expect(pool.query('delete from checkouts where id = $1', [checkout.id])).rejects.toThrow(
      /permission denied/,
    );
    await expect(
      owner.pool.query('delete from checkouts where id = $1', [checkout.id]),
    ).rejects.toThrow(/never deleted/);
    // The checkout and the gift are fixed on the order.
    await expect(
      pool.query(`update orders set gift_message = 'x' where id = $1`, [order.id]),
    ).rejects.toThrow(/identity and fields are fixed/);
    await expect(
      pool.query('update orders set checkout_line = 2 where id = $1', [order.id]),
    ).rejects.toThrow(/identity and fields are fixed/);
    // A checkout order carries its checkout's journal; a single order its own.
    const { rows } = await pool.query<{ id: string }>(
      'select id from ledger_journals where id <> $1 limit 1',
      [checkout.purchaseJournalId],
    );
    const insert = (values: Record<string, unknown>) =>
      pool.query(
        `insert into orders (id, number, customer_id, is_test, product_id, game_id, kind, status,
           quantity, unit_price_usd_units, total_usd_units, price_id, min_margin_usd_units, fields,
           idempotency_key, request_hash, purchase_journal_id, paid_at, checkout_id,
           checkout_line, reserved_at, expires_at, is_gift, gift_message)
         values ($1, $2, $3, false, $4, $5, $6, 'paid', 1, $7, $7, $8, 0, '{}', $9, $10, $11,
           now(), $12, $13, $14, $15, $16, $17)`,
        [
          newId(),
          `VO-${'23456789ABCDEFGHJKMNPQRSTUVWXYZ'.charAt(Math.floor(Math.random() * 31))}2345${Math.floor(Math.random() * 8) + 2}`,
          buyer,
          item.id,
          item.game,
          values.kind ?? 'direct',
          item.price,
          order.priceId,
          newId(),
          'a'.repeat(64),
          values.journal,
          values.checkoutId ?? null,
          values.line ?? null,
          values.reservedAt ?? null,
          values.reservedAt ? new Date(Date.now() + 3_600_000) : null,
          values.isGift ?? false,
          values.giftMessage ?? null,
        ],
      );
    await expect(
      insert({ journal: rows[0]?.id, checkoutId: checkout.id, line: 2 }),
    ).rejects.toThrow(/its checkout's journal/);
    await expect(insert({ journal: checkout.purchaseJournalId })).rejects.toThrow(
      /pays only its checkout's orders/,
    );
    const single = await buy(request(buyer, item));
    await expect(insert({ journal: single.order.purchaseJournalId })).rejects.toThrow(
      /orders_purchase_journal_id_single_idx/,
    );
    await expect(
      insert({ journal: checkout.purchaseJournalId, checkoutId: checkout.id }),
    ).rejects.toThrow(/orders_checkout_check/);
    await expect(
      insert({
        journal: checkout.purchaseJournalId,
        checkoutId: checkout.id,
        line: 3,
        reservedAt: new Date(),
      }),
    ).rejects.toThrow(/orders_checkout_check/);
    await expect(
      insert({
        journal: checkout.purchaseJournalId,
        checkoutId: checkout.id,
        line: 4,
        kind: 'code',
        isGift: true,
      }),
    ).rejects.toThrow(/orders_gift_check/);
    await expect(
      insert({
        journal: checkout.purchaseJournalId,
        checkoutId: checkout.id,
        line: 5,
        giftMessage: 'hi',
      }),
    ).rejects.toThrow(/orders_gift_check/);

    // One live link per kind; a revoked link never changes; none is deleted.
    const [gift] = await db
      .select()
      .from(orderShareLinks)
      .where(eq(orderShareLinks.orderId, order.id));
    const link = gift as typeof orderShareLinks.$inferSelect;
    await expect(
      db.insert(orderShareLinks).values({
        id: newId(),
        orderId: order.id,
        kind: 'gift',
        token: 'A'.repeat(22),
        showPrice: false,
      }),
    ).rejects.toThrow();
    await expect(
      pool.query(`update order_share_links set token = $2 where id = $1`, [
        link.id,
        'B'.repeat(22),
      ]),
    ).rejects.toThrow(/order, kind and token are fixed/);
    await pool.query(
      `update order_share_links set revoked_at = now(), revoked_by = 'customer' where id = $1`,
      [link.id],
    );
    await expect(
      pool.query(`update order_share_links set show_price = true where id = $1`, [link.id]),
    ).rejects.toThrow(/revoked and never changes/);
    await expect(
      pool.query('delete from order_share_links where id = $1', [link.id]),
    ).rejects.toThrow(/permission denied/);
    await expect(
      owner.pool.query('delete from order_share_links where id = $1', [link.id]),
    ).rejects.toThrow(/never deleted/);
  });
});

describe('live operations: reroute, manual fulfil, refund (S11)', () => {
  /** A manual route on the product at `cost` (S07: the admin's own cost). */
  async function manualRoute(productId: string, cost = usd(0.85)) {
    const [offer, route] = [newId(), newId()];
    await pool.query(
      `insert into supplier_offers (id, supplier_id, offer_id, name, in_stock, cost_usd_units,
         cost_confirmed_at, last_seen_at) values ($1, $2, $3, 'Manual', true, $4, now(), now())`,
      [offer, suppliers.manual, `m-${unique()}`, cost],
    );
    await pool.query(
      `insert into product_routes (id, product_id, supplier_id, offer_id, field_map)
       values ($1, $2, $3, $4, '{}')`,
      [route, productId, suppliers.manual, offer],
    );
    return { route, offer, cost };
  }

  /** A stored `delivery_proof` file (rule MF2). */
  async function proof(kind: 'delivery_proof' | 'deposit_receipt' = 'delivery_proof') {
    const id = newId();
    await pool.query(
      `insert into stored_files (id, kind, storage_key, content_type, byte_size, width, height)
       values ($1, $2, $3, 'image/webp', 10, 1, 1)`,
      [id, kind, `${kind}/${id.slice(-2)}/${id}.webp`],
    );
    return id;
  }

  type Item = Awaited<ReturnType<typeof product>>;

  /** The SQLSTATE of a refused statement (Drizzle keeps PostgreSQL's error as its cause). */
  const sqlState = async (statement: Promise<unknown>) => {
    try {
      await statement;
    } catch (error) {
      const { cause, code } = error as { cause?: { code?: string }; code?: string };
      return cause?.code ?? code;
    }
    throw new Error('Expected a refusal');
  };

  const routing = { now: new Date(), fakeEnabled: true };
  const admin = (key = newId()) => ({ id: newId(), reason: 'قرار الأدمن', idempotencyKey: key });
  const reroute = (orderId: string, routeId: string, decision = admin()) =>
    db.transaction((tx) =>
      rerouteOrder(tx, { ...context(), routing }, { orderId, routeId, admin: decision }),
    );
  const fulfil = (orderId: string, input: Partial<ManualFulfilInput> & { proofFileId: string }) =>
    db.transaction((tx) =>
      fulfilOrderManually(tx, context(), {
        orderId,
        quantity: 1,
        codes: [],
        unitCostUsdUnits: usd(0.8),
        acceptLoss: false,
        reference: null,
        admin: admin(),
        ...input,
      }),
    );
  const attemptsOf = (orderId: string) =>
    db
      .select()
      .from(fulfilmentAttempts)
      .where(eq(fulfilmentAttempts.orderId, orderId))
      .orderBy(fulfilmentAttempts.createdAt, fulfilmentAttempts.id);
  const hold = (orderId: string) =>
    db.transaction(async (tx) => {
      const locked = (await lockOrder(tx, orderId)) as OrderRow;
      await transitionOrder(tx, locked, 'needs_review', { actor: 'system', reason: 'hard_limit' });
    });

  /** A paid order sent to its fake route and held for review (rule F7's hard limit). */
  async function held(item: Item) {
    const buyer = await customer({ funds: usd(50) });
    const { order } = await buy(request(buyer, item));
    const attemptId = await send(order, item);
    await apply(attemptId, { status: 'unknown', reason: 'timeout' });
    await hold(order.id);
    return { order: await orderRow(order.id), attemptId };
  }

  /** A paid order waiting on its manual route (rule MN1), after a reroute from review. */
  async function waitingManual(item: Item, manual: { route: string }) {
    const { order, attemptId } = await held(item);
    await reroute(order.id, manual.route);
    const open = (await attemptsOf(order.id)).find((attempt) => attempt.status === 'pending');
    return {
      order: await orderRow(order.id),
      closedAttemptId: attemptId,
      manualAttemptId: open?.id as string,
    };
  }

  it('checks attempt kinds, zero costs and proofs (migration 0038)', async () => {
    const item = await product();
    const { order } = await held(item);
    const insert = async (values: Partial<typeof fulfilmentAttempts.$inferInsert>) =>
      sqlState(
        db.insert(fulfilmentAttempts).values({
          id: newId(),
          orderId: order.id,
          supplierId: suppliers.manual,
          quantity: 1,
          candidates: [],
          unitCostUsdUnits: 0,
          status: 'delivered',
          deliveredQuantity: 1,
          resolvedAt: new Date(),
          resolvedBy: 'admin',
          adminReason: 'سلّمت من مصدر آخر',
          ...values,
        }),
      );
    // An admin delivery has a proof and no route; a routed attempt has its route.
    expect(await insert({ kind: 'admin_fulfil' })).toBe('23514');
    expect(
      await insert({ kind: 'admin_fulfil', proofFileId: await proof(), routeId: item.route }),
    ).toBe('23514');
    expect(await insert({ kind: 'routed', proofFileId: await proof() })).toBe('23514');
    // A zero-cost routed attempt needs a proof; a delivered cost needs its journal.
    expect(
      await insert({
        kind: 'routed',
        routeId: item.route,
        offerId: item.offer,
        supplierOfferId: 'o-x',
        status: 'pending',
        deliveredQuantity: 0,
        resolvedAt: null,
        resolvedBy: null,
        adminReason: null,
      }),
    ).toBe('23514');
    expect(
      await insert({ kind: 'admin_fulfil', proofFileId: await proof(), unitCostUsdUnits: 10_000 }),
    ).toBe('23514');
    // A proof serves one attempt.
    const used = await proof();
    await db.insert(fulfilmentAttempts).values({
      id: newId(),
      orderId: order.id,
      kind: 'admin_fulfil',
      supplierId: suppliers.manual,
      quantity: 1,
      candidates: [],
      unitCostUsdUnits: 0,
      status: 'delivered',
      deliveredQuantity: 1,
      resolvedAt: new Date(),
      resolvedBy: 'admin',
      adminReason: 'سلّمت من مصدر آخر',
      proofFileId: used,
    });
    expect(await insert({ kind: 'admin_fulfil', proofFileId: used })).toBe('23505');
  });

  it('keeps kinds fixed and takes a cost and a proof only on an open manual attempt', async () => {
    const item = await product();
    const manual = await manualRoute(item.id);
    const { closedAttemptId, manualAttemptId } = await waitingManual(item, manual);
    const update = (id: string, values: Partial<typeof fulfilmentAttempts.$inferInsert>) =>
      sqlState(db.update(fulfilmentAttempts).set(values).where(eq(fulfilmentAttempts.id, id)));
    expect(await update(manualAttemptId, { kind: 'admin_fulfil' })).toBe('23001');
    expect(await update(manualAttemptId, { chosenByAdmin: false })).toBe('23001');
    expect(await update(closedAttemptId, { unitCostUsdUnits: 1 })).toBe('23001');
    // The cost and the reference change only with the proof, once.
    expect(await update(manualAttemptId, { unitCostUsdUnits: usd(0.7) })).toBe('23001');
    expect(await update(manualAttemptId, { deliveryReference: 'OP-0' })).toBe('23001');
    await db
      .update(fulfilmentAttempts)
      .set({ unitCostUsdUnits: usd(0.7), proofFileId: await proof(), deliveryReference: 'OP-1' })
      .where(eq(fulfilmentAttempts.id, manualAttemptId));
    // A proof and a reference are set once.
    expect(await update(manualAttemptId, { proofFileId: await proof() })).toBe('23001');
    expect(await update(manualAttemptId, { deliveryReference: 'OP-2' })).toBe('23001');
    expect(await update(manualAttemptId, { unitCostUsdUnits: usd(0.6) })).toBe('23001');
    // An open automatic attempt takes neither a cost nor a proof.
    const other = await held(await product());
    expect(await update(other.attemptId, { unitCostUsdUnits: usd(0.5) })).toBe('23001');
    expect(await update(other.attemptId, { proofFileId: await proof() })).toBe('23001');
  });

  it('lists the routes with their eligibility for the order (rule RR2)', async () => {
    const item = await product();
    const manual = await manualRoute(item.id);
    const { order } = await held(item);
    const options = await rerouteOptions(db, order, routing);
    expect(options).toMatchObject({ orderId: order.id, remainingUnits: 1 });
    const byRoute = new Map(options.routes.map((route) => [route.routeId, route]));
    expect(options.routes).toHaveLength(2);
    expect(byRoute.get(item.route)).toMatchObject({ eligible: false, skipReason: 'already_tried' });
    expect(byRoute.get(manual.route)).toMatchObject({
      eligible: true,
      supplierCode: 'manual',
      balanceUsdUnits: null,
      unitCostUsdUnits: manual.cost,
      marginUsdUnits: item.price - manual.cost,
    });
  });

  it('reroutes a held order to the manual route with its card (rules RR1–RR3)', async () => {
    const item = await product();
    const manual = await manualRoute(item.id);
    const { order, attemptId } = await held(item);
    const key = newId();
    sent.length = 0;
    const result = await reroute(order.id, manual.route, admin(key));
    expect(result).toMatchObject({ closedAttemptId: attemptId, supplierCode: 'manual' });
    expect(result.order.status).toBe('sent_to_supplier');
    const [closed, opened] = await attemptsOf(order.id);
    expect(closed).toMatchObject({
      status: 'failed',
      resolvedBy: 'admin',
      inputRejected: false,
      decisionIdempotencyKey: key,
      failureReason: ADMIN_CLOSE_REASONS.reroute,
    });
    expect(opened).toMatchObject({ status: 'pending', chosenByAdmin: true, quantity: 1 });
    expect(opened?.candidates).toHaveLength(2);
    const { rows: cards } = await pool.query(
      'select kind from telegram_messages where dedupe_key = $1',
      [`manual:${opened?.id}`],
    );
    expect(cards).toEqual([{ kind: 'manual_order' }]);
    expect(sent.some((job) => job.queue === QUEUES.ordersPoll)).toBe(false);
    // The route already tried, and a supplier without credentials, are refused.
    expect(await refusal(reroute(order.id, item.route))).toEqual({
      code: 'ROUTE_NOT_ELIGIBLE',
      details: { reason: 'already_tried' },
    });
    expect(await refusal(reroute(order.id, newId()))).toEqual({
      code: 'ROUTE_NOT_ELIGIBLE',
      details: { reason: 'archived' },
    });
    const statuses = await db
      .select({ to: orderEvents.toStatus })
      .from(orderEvents)
      .where(and(eq(orderEvents.orderId, order.id), eq(orderEvents.kind, 'status')))
      .orderBy(orderEvents.createdAt, orderEvents.id);
    expect(statuses.map((row) => row.to)).toEqual([
      'paid',
      'sent_to_supplier',
      'needs_review',
      'sent_to_supplier',
    ]);
  });

  it('moves a manual order to an automatic route through failed, sent by its poll', async () => {
    const item = await product();
    const manual = await manualRoute(item.id);
    const buyer = await customer({ funds: usd(10) });
    const { order } = await buy(request(buyer, item));
    // Sent to the manual route first, as `orders.fulfil` does when it ranks first.
    const manualAttemptId = await db.transaction(async (tx) => {
      const locked = (await lockOrder(tx, order.id)) as OrderRow;
      const id = newId();
      await tx.insert(fulfilmentAttempts).values({
        id,
        orderId: order.id,
        routeId: manual.route,
        supplierId: suppliers.manual,
        offerId: manual.offer,
        supplierOfferId: 'm-test',
        quantity: 1,
        unitCostUsdUnits: manual.cost,
        status: 'pending',
        candidates: [],
        sentAt: new Date(),
      });
      await transitionOrder(tx, locked, 'sent_to_supplier', { actor: 'system', attemptId: id });
      return id;
    });
    sent.length = 0;
    const result = await reroute(order.id, item.route);
    expect(result).toMatchObject({ closedAttemptId: manualAttemptId, supplierCode: 'fake' });
    expect(result.attempt).toMatchObject({ status: 'sending', chosenByAdmin: true });
    expect(sent).toContainEqual(
      expect.objectContaining({ queue: QUEUES.ordersPoll, data: { attemptId: result.attempt.id } }),
    );
    const statuses = await db
      .select({ to: orderEvents.toStatus })
      .from(orderEvents)
      .where(and(eq(orderEvents.orderId, order.id), eq(orderEvents.kind, 'status')))
      .orderBy(orderEvents.createdAt, orderEvents.id);
    expect(statuses.map((row) => row.to)).toEqual([
      'paid',
      'sent_to_supplier',
      'failed',
      'sent_to_supplier',
    ]);
    // An automatic attempt now runs: no reroute before the hard limit (ADR 0004).
    expect(await refusal(reroute(order.id, manual.route))).toMatchObject({
      code: 'ORDER_NOT_DECIDABLE',
    });
  });

  it('refuses a reroute of a running, finished or unknown order', async () => {
    const item = await product();
    const manual = await manualRoute(item.id);
    const buyer = await customer({ funds: usd(10) });
    const { order } = await buy(request(buyer, item));
    expect(await refusal(reroute(order.id, manual.route))).toMatchObject({
      code: 'ORDER_NOT_DECIDABLE',
    });
    await send(order, item);
    expect(await refusal(reroute(order.id, manual.route))).toMatchObject({
      code: 'ORDER_NOT_DECIDABLE',
    });
    expect(await refusal(reroute(newId(), manual.route))).toMatchObject({ code: 'NOT_FOUND' });
  });

  it('rechecks the route under the lock: a cost rise makes it unprofitable (edge case 2)', async () => {
    const item = await product();
    const manual = await manualRoute(item.id);
    const { order } = await held(item);
    await pool.query('update supplier_offers set cost_usd_units = $1 where id = $2', [
      item.price,
      manual.offer,
    ]);
    expect(await refusal(reroute(order.id, manual.route))).toEqual({
      code: 'ROUTE_NOT_ELIGIBLE',
      details: { reason: 'unprofitable' },
    });
  });

  it('offers only fake and manual routes to a test customer (edge case 3)', async () => {
    const item = await product();
    const manual = await manualRoute(item.id);
    const buyer = await customer({ isTest: true, funds: usd(10) });
    const { order } = await buy(request(buyer, item));
    const attemptId = await send(order, item);
    await apply(attemptId, { status: 'unknown', reason: 'timeout' });
    await hold(order.id);
    const options = await rerouteOptions(db, await orderRow(order.id), routing);
    expect(options.routes.find((route) => route.routeId === manual.route)?.eligible).toBe(true);
  });

  it('serializes a reroute and a late result on one attempt (edge case 1)', async () => {
    const item = await product();
    const manual = await manualRoute(item.id);
    const { order, attemptId } = await held(item);
    const [rerouted, late] = await Promise.allSettled([
      reroute(order.id, manual.route),
      apply(attemptId, { status: 'delivered', quantity: 1 }, 'webhook'),
    ]);
    const final = await orderRow(order.id);
    if (rerouted.status === 'fulfilled') {
      // The reroute won: the late result found its attempt closed and changed nothing.
      expect(late).toMatchObject({ status: 'fulfilled', value: { applied: false } });
      expect(final.status).toBe('sent_to_supplier');
    } else {
      expect(rerouted.reason).toMatchObject({ code: 'ORDER_NOT_DECIDABLE' });
      expect(final.status).toBe('delivered');
    }
  });

  it('fulfils an open manual attempt with its proof and cost (rules MF2–MF5, MF-M1)', async () => {
    const item = await product();
    const manual = await manualRoute(item.id);
    const { order, manualAttemptId } = await waitingManual(item, manual);
    const before = await balance(order.customerId);
    const prepaid = await db.transaction((tx) =>
      ensureSystemAccount(tx, {
        code: 'supplier_prepaid:manual',
        kind: 'supplier_prepaid',
        currency: 'USD',
      }),
    );
    const prepaidBefore = await accountBalance(db, prepaid);
    const proofFileId = await proof();
    const key = newId();
    const result = await fulfil(order.id, { proofFileId, reference: 'OP-1', admin: admin(key) });
    expect(result).toMatchObject({
      attemptId: manualAttemptId,
      case: 'manual_attempt',
      lossAccepted: false,
    });
    expect(result.order.status).toBe('delivered');
    const attempt = (await attemptsOf(order.id)).find((row) => row.id === manualAttemptId);
    expect(attempt).toMatchObject({
      status: 'delivered',
      unitCostUsdUnits: usd(0.8),
      proofFileId,
      deliveryReference: 'OP-1',
      resolvedBy: 'admin',
      decisionIdempotencyKey: key,
    });
    expect(attempt?.costJournalId).not.toBeNull();
    expect(await accountBalance(db, prepaid)).toBe(prepaidBefore - usd(0.8));
    expect(await balance(order.customerId)).toBe(before);
    const [delivered] = await db
      .select({ event: customerNotifications.event })
      .from(customerNotifications)
      .where(eq(customerNotifications.customerId, order.customerId))
      .orderBy(desc(customerNotifications.createdAt))
      .limit(1);
    expect(delivered?.event).toBe('order_delivered');
  });

  it('refuses a used or foreign proof, a loss without confirmation and wrong units', async () => {
    const item = await product();
    const manual = await manualRoute(item.id);
    const first = await waitingManual(item, manual);
    const used = await proof();
    await fulfil(first.order.id, { proofFileId: used });

    const second = await held(item);
    const id = second.order.id;
    expect(await refusal(fulfil(id, { proofFileId: used }))).toMatchObject({
      code: 'PROOF_INVALID',
    });
    expect(
      await refusal(fulfil(id, { proofFileId: await proof('deposit_receipt') })),
    ).toMatchObject({ code: 'PROOF_INVALID' });
    expect(await refusal(fulfil(id, { proofFileId: newId() }))).toMatchObject({
      code: 'PROOF_INVALID',
    });
    const fresh = await proof();
    const above = item.price + 10_000;
    expect(await refusal(fulfil(id, { proofFileId: fresh, unitCostUsdUnits: above }))).toEqual({
      code: 'LOSS_NOT_CONFIRMED',
      details: { unitCostUsdUnits: above, unitPriceUsdUnits: item.price },
    });
    expect(await refusal(fulfil(id, { proofFileId: fresh, codes: ['ABCDEFGH'] }))).toMatchObject({
      code: 'CODES_COUNT_MISMATCH',
    });
    expect(await refusal(fulfil(id, { proofFileId: fresh, quantity: 2 }))).toMatchObject({
      code: 'VALIDATION_FAILED',
    });
    const loss = await fulfil(id, {
      proofFileId: fresh,
      unitCostUsdUnits: above,
      acceptLoss: true,
    });
    expect(loss).toMatchObject({ case: 'review', lossAccepted: true });
    expect(loss.order.status).toBe('delivered');
    expect(await refusal(fulfil(id, { proofFileId: await proof() }))).toMatchObject({
      code: 'ORDER_NOT_DECIDABLE',
    });
  });

  it('fulfils part of a held code order elsewhere at zero cost (edge cases 5, 7)', async () => {
    const item = await product({ kind: 'code' });
    const buyer = await customer({ funds: usd(50) });
    const { order } = await buy(request(buyer, item, { quantity: 3, fields: {} }));
    const attemptId = await send(order, item);
    await apply(attemptId, { status: 'unknown', reason: 'timeout' });
    await hold(order.id);
    sent.length = 0;
    const result = await fulfil(order.id, {
      proofFileId: await proof(),
      quantity: 2,
      codes: ['CODE-AAAA-1111', 'CODE-BBBB-2222'],
      unitCostUsdUnits: 0,
    });
    expect(result.case).toBe('review');
    const [closed, delivered] = await attemptsOf(order.id);
    expect(closed).toMatchObject({ status: 'failed', failureReason: ADMIN_CLOSE_REASONS.fulfil });
    expect(delivered).toMatchObject({
      kind: 'admin_fulfil',
      routeId: null,
      status: 'delivered',
      deliveredQuantity: 2,
      unitCostUsdUnits: 0,
      costJournalId: null,
    });
    // The third unit goes to `orders.fulfil` from review (there is no `needs_review → failed`).
    expect(result.order).toMatchObject({ status: 'needs_review', deliveredQuantity: 2 });
    expect(sent.filter((job) => job.queue === QUEUES.ordersFulfil)).toHaveLength(1);
    const codes = await db
      .select()
      .from(orderCodes)
      .where(eq(orderCodes.attemptId, result.attemptId));
    expect(codes).toHaveLength(2);
    // An admin delivery is never the open attempt (edge case 17).
    const read = await adminOrder(db, order.id);
    expect(read?.attempts[0]).toMatchObject({ kind: 'admin_fulfil', offerId: null, routeId: null });
    expect(read?.decisions).toMatchObject({ attemptId: null, fulfil: true, reroute: false });
  });

  it('lets one of two parallel fulfils win (edge case 9)', async () => {
    const item = await product();
    const manual = await manualRoute(item.id);
    const { order } = await waitingManual(item, manual);
    const [a, b] = await Promise.allSettled([
      fulfil(order.id, { proofFileId: await proof() }),
      fulfil(order.id, { proofFileId: await proof() }),
    ]);
    expect([a, b].filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    const lost = [a, b].find((result) => result.status === 'rejected') as PromiseRejectedResult;
    expect(lost.reason).toMatchObject({ code: 'ORDER_NOT_DECIDABLE' });
  });

  it('serializes a manual fulfil and a late result from review (rule MF6)', async () => {
    const item = await product();
    const { order, attemptId } = await held(item);
    const [fulfilled, late] = await Promise.allSettled([
      fulfil(order.id, { proofFileId: await proof() }),
      apply(attemptId, { status: 'delivered', quantity: 1 }, 'poll'),
    ]);
    const attempts = await attemptsOf(order.id);
    if (fulfilled.status === 'fulfilled') {
      expect(late).toMatchObject({ status: 'fulfilled', value: { applied: false } });
      expect(attempts.map((row) => row.status)).toEqual(['failed', 'delivered']);
    } else {
      expect(fulfilled.reason).toMatchObject({ code: 'ORDER_NOT_DECIDABLE' });
      expect(attempts.map((row) => row.status)).toEqual(['delivered']);
    }
    expect((await orderRow(order.id)).status).toBe('delivered');
  });

  it('refunds an order waiting on the manual supplier through failed (rule RF1)', async () => {
    const item = await product();
    const manual = await manualRoute(item.id);
    const { order, manualAttemptId } = await waitingManual(item, manual);
    const before = await balance(order.customerId);
    const by = { id: newId(), reason: 'لا يتوفر الآن' };
    const refunded = await db.transaction(async (tx) => {
      const closed = await closeForAdminRefund(tx, order.id, by, new Date());
      expect(closed).toMatchObject({ closedAttemptId: manualAttemptId });
      expect(closed.order.status).toBe('failed');
      return refundRemaining(tx, context(), closed.order, 'admin', {
        actor: 'admin',
        actorId: by.id,
        idempotencyKey: newId(),
      });
    });
    expect(refunded.status).toBe('refunded');
    expect(await balance(order.customerId)).toBe(before + item.price);
    const manualAttempt = (await attemptsOf(order.id)).find((row) => row.id === manualAttemptId);
    expect(manualAttempt).toMatchObject({
      status: 'failed',
      failureReason: ADMIN_CLOSE_REASONS.refund,
    });
    expect(
      await refusal(db.transaction((tx) => closeForAdminRefund(tx, order.id, by, new Date()))),
    ).toMatchObject({ code: 'ORDER_NOT_DECIDABLE' });
  });
});
