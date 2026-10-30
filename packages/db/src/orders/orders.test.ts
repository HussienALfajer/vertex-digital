import { createHash, randomBytes } from 'node:crypto';
import {
  CURRENCY_SCALE,
  damascusMonth,
  markupPrice,
  previousMonth,
  priceFromCost,
  QUEUES,
  ROOT_PRICE_LIST_IDS,
  statementBalances,
  TIER_NAMES_AR,
} from '@vertex-digital/contracts';
import { and, desc, eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { recordAudit } from '../audit/index.js';
import { createDatabase, type Transaction } from '../client.js';
import { lockActiveCustomer, purchasedLastDay } from '../customers/guard.js';
import {
  accountPriceList,
  accountsOnList,
  assignedAccountCounts,
  releaseArchivedAccounts,
  setCustomerPriceList,
} from '../customers/price-lists.js';
import {
  archiveCustomer,
  CustomerError,
  freezeCustomer,
  lockCustomer,
  setCustomerLimits,
  unarchiveCustomer,
  unfreezeCustomer,
} from '../customers/state.js';
import { newId } from '../id.js';
import { accountBalance } from '../ledger/balance.js';
import { ensureCustomerWallet, ensureSystemAccount, findCustomerWallet } from '../ledger/index.js';
import { postJournal } from '../ledger/post-journal.js';
import { walletTimeline } from '../ledger/wallet.js';
import { dashboardFacts, recentPlayers } from '../merchant-tools/reads.js';
import { setOrderSale } from '../merchant-tools/sales.js';
import {
  sendStatementReady,
  statementEmailMerchants,
  statementFacts,
} from '../merchant-tools/statements.js';
import { compareMerchantWatches } from '../merchant-tools/watch-alerts.js';
import {
  type GrantInput,
  grantMerchant,
  merchantDepositTier,
  orderRate,
  revokeMerchant,
} from '../merchants/accounts.js';
import {
  endTierGrant,
  expireTierGrant,
  grantTier,
  remindEndingTierGrants,
} from '../merchants/grants.js';
import { tierSavings } from '../merchants/identity.js';
import { netPurchases, recomputeMerchantLevel, recordTierMonth } from '../merchants/levels.js';
import { accountMerchant, merchantProfileOf } from '../merchants/reads.js';
import { repriceProducts, supplierDeliveryMedians } from '../pricing/index.js';
import {
  activeAlertCount,
  cancelProductAlert,
  createProductAlert,
  customerProductAlerts,
  deleteOldProductAlerts,
  runProductAlerts,
  waitingAlertCounts,
} from '../product-alerts/index.js';
import {
  deleteOldQuickLinkEvents,
  quickLinkStats,
  recordQuickLinkOpen,
  resolveQuickCode,
} from '../quick-links/index.js';
import { type CheckResult, internalChecks, runInternalChecks } from '../reconciliation/index.js';
import {
  auditEntries,
  checkouts,
  customerNotifications,
  customers,
  emailOutbox,
  fulfilmentAttempts,
  gamePlayerChecks,
  orderCodes,
  orderEvents,
  orderShareLinks,
  orders,
  playerChecks,
  productAlerts,
  productPrices,
  savedPlayers,
  storeSwitchChanges,
  telegramMessages,
} from '../schema/index.js';
import {
  ADMIN_CLOSE_REASONS,
  closeForAdminRefund,
  fulfilOrderManually,
  type ManualFulfilInput,
  rerouteOptions,
  rerouteOrder,
} from './admin-actions.js';
import { type AdminPurchaseInput, adminPurchaseOrder, ownerSpentToday } from './admin-purchase.js';
import { type CheckoutInput, checkoutOrders } from './checkout.js';
import { applyOutcome, ownerDrawings, refundRemaining } from './outcome.js';
import { OrderError, type PurchaseInput, purchaseOrder } from './purchase.js';
import { quickBuyRows, reservedUsdUnits } from './quick-buy.js';
import {
  adminOrder,
  adminOrderCounts,
  adminOrderPage,
  customerCheckout,
  customerOrder,
  customerOrderPage,
  productDeliveryStats,
  publicShare,
  revealCode,
} from './reads.js';
import { orderPrint, publicVerification, type ReleaseInput, releaseCodes } from './receipts.js';
import {
  cancelOwnReservation,
  expireReservations,
  payWaitingOrders,
  purchasesStoppedLocked,
} from './reservations.js';
import { savedPlayerHash } from './saved-players.js';
import { decryptSecret } from './secrets.js';
import { createShareLink } from './share-links.js';
import { attemptSupplierFacts, supplierOrderMatches } from './supplier-matches.js';
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

let suppliers: Record<'fake' | 'manual', string>;
const categories: string[] = [];

beforeAll(async () => {
  const { rows } = await pool.query<{ id: string; code: 'fake' | 'manual' }>(
    `select id, code from suppliers where code in ('fake', 'manual')`,
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

/** An active product with a `player_id` field, a route to the fake supplier at `cost`, and its price. */
async function product(
  options: { kind?: 'direct' | 'code'; cost?: number; inStock?: boolean } = {},
) {
  const [category, game, id, offer, route] = [newId(), newId(), newId(), newId(), newId()];
  const kind = options.kind ?? 'direct';
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
    `insert into margin_rules (id, price_list_id, scope, target_id, percent_bp, fixed_usd_units,
       min_margin_usd_units) values ($1, $2, 'product', $3, $4, $5, $6)`,
    [
      newId(),
      ROOT_PRICE_LIST_IDS.retail,
      id,
      rule.percentBp,
      rule.fixedUsdUnits,
      rule.minMarginUsdUnits,
    ],
  );
  await pool.query(
    `insert into supplier_offers (id, supplier_id, offer_id, name, in_stock, cost_usd_units,
       cost_confirmed_at, last_seen_at) values ($1, $2, $3, 'Offer', $4, $5, now(), now())`,
    [offer, suppliers.fake, `o-${unique()}`, options.inStock ?? true, cost],
  );
  await pool.query(
    `insert into product_routes (id, product_id, supplier_id, offer_id, field_map)
     values ($1, $2, $3, $4, $5)`,
    [route, id, suppliers.fake, offer, kind === 'direct' ? { playerId: 'player_id' } : {}],
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

/** A product's current price on a list (its newest row, as the routing reads it). */
async function listPriceOf(productId: string, priceListId: string): Promise<number> {
  const { rows } = await pool.query<{ price: string }>(
    `select price_usd_units::text as price from product_prices
     where product_id = $1 and price_list_id = $2 order by created_at desc, id desc limit 1`,
    [productId, priceListId],
  );
  return Number(rows[0]?.price);
}

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
           rule_id, percent_bp, fixed_usd_units, min_margin_usd_units, cause, price_list_id)
         values ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'rule_change', '${ROOT_PRICE_LIST_IDS.retail}')`,
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
    const item = await product({ inStock: false });
    const buyer = await customer({ funds: usd(10) });
    // Its only offer is out of stock (S07 RT4): no usable route, no price.
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

    // Codes missing for a code product: kept open, polled (edge case 10), with the supplier's
    // order id, by which a webhook that carries only it finds the attempt (WDGZone).
    const missing = await apply(attemptId, {
      status: 'delivered',
      quantity: 2,
      codes: ['X'],
      supplierOrderId: `s-${attemptId}`,
    });
    expect(missing.attempt).toMatchObject({
      status: 'unknown',
      failureReason: 'codes_missing',
      supplierOrderId: `s-${attemptId}`,
    });

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

  it('passes the reconciliation checks, which list planted faults on its journals (S13 C5–C7)', async () => {
    const item = await product({ kind: 'code', cost: usd(9.6) });
    const buyer = await customer({ funds: usd(100) });
    const { order } = await buy(request(buyer, item, { quantity: 3, fields: {} }));
    const attemptId = await send(order, item);
    await apply(attemptId, {
      status: 'delivered',
      quantity: 2,
      codes: ['RECO-NCIL-IATI-0001', 'RECO-NCIL-IATI-0002'],
    });
    const finished = await db.transaction(async (tx) =>
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
    const [attempt] = await db
      .select()
      .from(fulfilmentAttempts)
      .where(eq(fulfilmentAttempts.id, attemptId));
    const ids = (results: CheckResult[], check: string) =>
      results
        .filter((result) => result.check === check)
        .flatMap((result) => result.details.offending.map((item) => item.id));
    const ours = [
      order.id,
      attemptId,
      finished.purchaseJournalId,
      finished.refundJournalId,
      attempt?.costJournalId,
    ];
    const clean = (await runInternalChecks(db)).results;
    for (const check of ['attempt_cost', 'order_purchase', 'order_refund', 'journal_balance']) {
      for (const id of ours) expect(ids(clean, check)).not.toContain(id);
    }

    // A posting added to each journal by the owner, never committed.
    class Rollback extends Error {}
    await owner.db
      .transaction(async (tx) => {
        const wallet = await ensureCustomerWallet(tx, buyer);
        for (const journal of [
          attempt?.costJournalId,
          finished.purchaseJournalId,
          finished.refundJournalId,
        ]) {
          await tx.execute(sql`insert into ledger_postings (id, journal_id, account_id, currency, amount_units)
            values (${newId()}, ${journal}, ${wallet}, 'USD', 10000)`);
        }
        const { results } = await internalChecks(tx);
        expect(ids(results, 'attempt_cost')).toContain(attemptId);
        expect(ids(results, 'order_purchase')).toContain(order.id);
        expect(ids(results, 'order_refund')).toContain(order.id);
        throw new Rollback();
      })
      .catch((error: unknown) => {
        if (!(error instanceof Rollback)) throw error;
      });
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
    // S13 LS1 (ADR 0027): cost of goods −cost, the supplier's prepaid account +cost.
    const { rows: costPostings } = await pool.query(
      `select a.kind, p.amount_units::text as amount from ledger_postings p
       join ledger_accounts a on a.id = p.account_id
       join fulfilment_attempts f on f.cost_journal_id = p.journal_id
       where f.id = $1 order by a.kind::text`,
      [attemptId],
    );
    expect(costPostings).toEqual([
      { kind: 'cost_of_goods', amount: String(-usd(19.2)) },
      { kind: 'supplier_prepaid', amount: String(usd(19.2)) },
    ]);
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
      request(buyer, item, {
        playerCheck: async () => ({ result: 'valid', playerName: 'Hero', region: 'ME' }),
      }),
    );
    expect(valid.order).toMatchObject({
      playerCheck: 'valid',
      playerName: 'Hero',
      playerRegion: 'ME',
    });
    // S19 PC3: an account outside the game's regions is refused, even confirmed.
    const mismatch = async () => ({ result: 'region_mismatch' as const, region: 'EU' });
    expect(
      await refusal(buy(request(buyer, item, { playerCheck: mismatch, confirmPlayer: true }))),
    ).toMatchObject({ code: 'PLAYER_REGION_MISMATCH', details: { region: 'EU' } });
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
      .where(
        and(
          eq(productPrices.productId, fell.id),
          eq(productPrices.priceListId, ROOT_PRICE_LIST_IDS.retail),
        ),
      )
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
      .where(
        and(
          eq(productPrices.productId, item.id),
          eq(productPrices.priceListId, ROOT_PRICE_LIST_IDS.retail),
        ),
      )
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
    await expect(
      pool.query(
        `insert into player_checks (id, game_id, fields_hash, result, region, supplier_id, customer_id, expires_at)
         values ($1, $2, $3, 'invalid', 'ME', $4, $5, now() + interval '1 hour')`,
        [newId(), item.game, 'c'.repeat(64), suppliers.fake, buyer],
      ),
    ).rejects.toThrow(/player_checks_region_check/);
    await db.delete(playerChecks).where(eq(playerChecks.id, id));
  });

  it('fixes the player region with the name (S19 PC9, migration 0074)', async () => {
    const item = await product();
    const buyer = await customer({ funds: usd(10) });
    const { order } = await buy(
      request(buyer, item, {
        playerCheck: async () => ({ result: 'valid', playerName: 'Hero', region: 'ME' }),
      }),
    );
    await expect(
      pool.query(`update orders set player_region = 'EU' where id = $1`, [order.id]),
    ).rejects.toThrow(/identity and fields are fixed/);
    const other = await buy(request(buyer, item));
    await expect(
      owner.pool.query(`update orders set player_region = 'EU' where id = $1`, [other.order.id]),
    ).rejects.toThrow(/orders_player_region_check|identity and fields are fixed/);
  });

  it('keeps a game check provider row, never deletes it (S19 PC1, migration 0074)', async () => {
    const item = await product();
    await db.insert(gamePlayerChecks).values({
      gameId: item.game,
      supplierId: suppliers.fake,
      categoryId: 'player',
      fieldMap: { playerId: 'player_id' },
      allowedRegions: ['ME'],
      enabled: true,
      adminId: newId(),
    });
    await expect(
      pool.query('delete from game_player_checks where game_id = $1', [item.game]),
    ).rejects.toThrow(/permission denied/);
    await expect(
      pool.query(
        `update game_player_checks set allowed_regions = array_fill('X'::text, array[21])
         where game_id = $1`,
        [item.game],
      ),
    ).rejects.toThrow(/game_player_checks_allowed_regions_check/);
  });
});

describe('measured delivery time (S19 RT12)', () => {
  it('measures a supplier from 10 deliveries by its own answer, never from fewer', async () => {
    const item = await product({ cost: usd(0.1) });
    const buyer = await customer({ funds: usd(20) });
    const {
      rows: [wdgzone],
    } = await pool.query<{ id: string }>(`select id from suppliers where code = 'wdgzone'`);
    class Rollback extends Error {}
    await db
      .transaction(async (tx) => {
        const now = new Date();
        for (let minutes = 1; minutes <= 10; minutes += 1) {
          const { order } = await purchaseOrder(tx, context(), request(buyer, item));
          const locked = (await lockOrder(tx, order.id)) as OrderRow;
          const id = newId();
          await tx.insert(fulfilmentAttempts).values({
            id,
            orderId: order.id,
            routeId: item.route,
            supplierId: wdgzone?.id as string,
            offerId: item.offer,
            supplierOfferId: 'o-test',
            quantity: 1,
            unitCostUsdUnits: item.cost,
            status: 'sending',
            candidates: [],
            sentAt: now,
            sendStartedAt: new Date(now.getTime() - minutes * 60_000),
          });
          await transitionOrder(tx, locked, 'sent_to_supplier', { actor: 'system', attemptId: id });
          await applyOutcome(
            tx,
            { ...context(), now },
            id,
            { status: 'delivered', quantity: 1 },
            { by: 'supplier' },
          );
          const measured = (await supplierDeliveryMedians(tx, now)).get(wdgzone?.id as string);
          expect(measured).toBe(minutes < 10 ? undefined : 330_000);
        }
        throw new Rollback();
      })
      .catch((error: unknown) => {
        if (!(error instanceof Rollback)) throw error;
      });
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
    const [ok, dear, code, checked, far] = [
      await product(),
      await product(),
      await product({ kind: 'code' }),
      await product(),
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
            line(far, { confirmPlayer: true }),
          ],
          {
            playerCheck: async (_tx, order) =>
              order.productId === checked.id
                ? { result: 'invalid' }
                : order.productId === far.id
                  ? { result: 'region_mismatch', region: 'EU' }
                  : null,
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
          // S19 PC3: confirmed or not.
          { index: 6, code: 'PLAYER_REGION_MISMATCH', details: { region: 'EU' } },
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
    const valid = async () => ({ result: 'valid' as const, playerName: 'Hero', region: null });
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
           checkout_line, reserved_at, expires_at, is_gift, gift_message, price_list_id)
         values ($1, $2, $3, false, $4, $5, $6, 'paid', 1, $7, $7, $8, 0, '{}', $9, $10, $11,
           now(), $12, $13, $14, $15, $16, $17, '${ROOT_PRICE_LIST_IDS.retail}')`,
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
  /** As the API's upload does: the proof's audit entry names the order it was taken for. */
  const uploaded = (tx: Transaction, orderId: string, fileId: string) =>
    recordAudit(tx, {
      action: 'order.proof_uploaded',
      actorKind: 'admin',
      actorId: newId(),
      channel: 'admin',
      entityType: 'order',
      entityId: orderId,
      details: { fileId },
    });
  const fulfil = (
    orderId: string,
    input: Partial<ManualFulfilInput> & { proofFileId: string },
    upload = true,
  ) =>
    db.transaction(async (tx) => {
      if (upload) await uploaded(tx, orderId, input.proofFileId);
      return fulfilOrderManually(tx, context(), {
        orderId,
        quantity: 1,
        codes: [],
        unitCostUsdUnits: usd(0.8),
        acceptLoss: false,
        reference: null,
        admin: admin(),
        ...input,
      });
    });
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
    // S16 RS1 (migration 0055): the first send is marked once.
    await db
      .update(fulfilmentAttempts)
      .set({ sendStartedAt: new Date() })
      .where(eq(fulfilmentAttempts.id, other.attemptId));
    expect(await update(other.attemptId, { sendStartedAt: new Date() })).toBe('23001');
    expect(await update(other.attemptId, { sendStartedAt: null })).toBe('23001');
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
    // S16 MF2: the attempt keeps the route's option map beside its field map.
    expect(opened?.optionMap).toEqual({});
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
    const before = await balance(order.customerId as string);
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
    // S13 LS1: the store holds less at the supplier: its account grows by the cost.
    expect(await accountBalance(db, prepaid)).toBe(prepaidBefore + usd(0.8));
    expect(await balance(order.customerId as string)).toBe(before);
    const [delivered] = await db
      .select({ event: customerNotifications.event })
      .from(customerNotifications)
      .where(eq(customerNotifications.customerId, order.customerId as string))
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
    // A proof no upload of this order took (audit A04-20).
    expect(await refusal(fulfil(id, { proofFileId: await proof() }, false))).toMatchObject({
      code: 'PROOF_INVALID',
    });
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
    const before = await balance(order.customerId as string);
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
    expect(await balance(order.customerId as string)).toBe(before + item.price);
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

describe('customer guards: freezing, the purchase cap and archiving (S12)', () => {
  const admin = { adminId: newId(), ipAddress: null, userAgent: null };
  const reason = 'تحقق من الحساب';
  const freeze = (customerId: string) =>
    db.transaction((tx) => freezeCustomer(tx, context(), { customerId, reason, actor: admin }));
  const unfreeze = (customerId: string) =>
    db.transaction((tx) => unfreezeCustomer(tx, { customerId, reason, actor: admin }));
  const archive = (customerId: string) =>
    db.transaction((tx) => archiveCustomer(tx, { customerId, reason, actor: admin }));
  const setCap = (customerId: string, dailyPurchaseUsdUnits: number | null) =>
    db.transaction((tx) =>
      setCustomerLimits(tx, {
        customerId,
        limits: { perDepositUsdUnits: null, dailyDepositUsdUnits: null, dailyPurchaseUsdUnits },
        reason,
        actor: admin,
      }),
    );
  const stateRefusal = async (promise: Promise<unknown>) => {
    try {
      await promise;
    } catch (error) {
      if (error instanceof CustomerError) return { code: error.code, details: error.details };
      throw error;
    }
    throw new Error('Expected a refusal');
  };
  const cart = (customerId: string, items: { id: string; price: number }[]): CheckoutInput => ({
    customerId,
    lines: items.map((item) => ({
      productId: item.id,
      quantity: 1,
      fields: { player_id: '5123456789' },
      expectedUnitPriceUsdUnits: item.price,
      confirmPlayer: false,
    })),
    idempotencyKey: newId(),
    requestHash: hash({ items: items.map((item) => item.id) }),
    fakeEnabled: true,
    purchasesStopped: false,
    channel: 'store',
    playerCheck: async () => null,
  });
  const payCheckout = (input: CheckoutInput) =>
    db.transaction((tx) => checkoutOrders(tx, context(), input));
  const reserve = (customerId: string, item: { id: string; price: number }) =>
    buy(request(customerId, item, { whenBalanceShort: 'reserve' }));
  const ticketNumber = () =>
    `VT-${Array.from({ length: 6 }, () => TICKET_ALPHABET[(randomBytes(1)[0] as number) % TICKET_ALPHABET.length]).join('')}`;
  /** A transaction held open after `work` until `release` is called. */
  function held<T>(work: (tx: Transaction) => Promise<T>) {
    let release = () => {};
    let inside = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const entered = new Promise<void>((resolve) => {
      inside = resolve;
    });
    const done = db.transaction(async (tx) => {
      const result = await work(tx);
      inside();
      await gate;
      return result;
    });
    return { done, entered, release: () => release() };
  }
  const settledWithin = (promise: Promise<unknown>, ms: number) =>
    Promise.race([
      promise.then(
        () => true,
        () => true,
      ),
      new Promise<boolean>((resolve) => setTimeout(() => resolve(false), ms)),
    ]);

  it('refuses a frozen customer every purchase, checkout and reservation (CF2)', async () => {
    const item = await product();
    const buyer = await customer({ funds: usd(10) });
    await freeze(buyer);
    expect(await refusal(buy(request(buyer, item)))).toEqual({
      code: 'ACCOUNT_FROZEN',
      details: undefined,
    });
    expect((await refusal(payCheckout(cart(buyer, [item])))).code).toBe('ACCOUNT_FROZEN');
    const poor = await customer();
    await freeze(poor);
    expect((await refusal(reserve(poor, item))).code).toBe('ACCOUNT_FROZEN');
    await unfreeze(buyer);
    expect((await buy(request(buyer, item))).created).toBe(true);
  });

  it('cancels every reservation with the reason frozen and tells the customer (CF1)', async () => {
    const item = await product();
    const buyer = await customer();
    const first = (await reserve(buyer, item)).order;
    const second = (await reserve(buyer, item)).order;
    const { cancelledOrderIds } = await freeze(buyer);
    expect(cancelledOrderIds.sort()).toEqual([first.id, second.id].sort());
    for (const id of [first.id, second.id]) {
      expect(await orderRow(id)).toMatchObject({ status: 'cancelled', cancelReason: 'frozen' });
    }
    const events = await db
      .select({ event: customerNotifications.event })
      .from(customerNotifications)
      .where(eq(customerNotifications.customerId, buyer));
    expect(events).toEqual([{ event: 'order_cancelled' }, { event: 'order_cancelled' }]);
    const [audit] = await db
      .select({ reason: auditEntries.reason })
      .from(auditEntries)
      .where(and(eq(auditEntries.entityId, buyer), eq(auditEntries.action, 'customer.frozen')));
    expect(audit?.reason).toBe(reason);
    // Edge case 2: nothing comes back after an unfreeze.
    await unfreeze(buyer);
    expect((await orderRow(first.id)).status).toBe('cancelled');
  });

  it('lets one of two freezes win and refuses unfreezing an active customer (CF1, CF6)', async () => {
    const buyer = await customer();
    const outcomes = await Promise.allSettled([freeze(buyer), freeze(buyer)]);
    expect(outcomes.filter((outcome) => outcome.status === 'fulfilled')).toHaveLength(1);
    const failed = outcomes.find((outcome) => outcome.status === 'rejected');
    expect((failed as PromiseRejectedResult).reason).toMatchObject({
      code: 'CUSTOMER_STATE_INVALID',
      details: { status: 'frozen' },
    });
    expect(await stateRefusal(unfreeze(await customer()))).toEqual({
      code: 'CUSTOMER_STATE_INVALID',
      details: { status: 'active' },
    });
  });

  it('serializes a purchase and a freeze in either order (CF2, edge case 1)', async () => {
    const item = await product();
    // The purchase first: the freeze waits, then the paid order stays paid.
    const early = await customer({ funds: usd(10) });
    const purchase = held((tx) => purchaseOrder(tx, context(), request(early, item)));
    await purchase.entered;
    const frozen = freeze(early);
    expect(await settledWithin(frozen, 200)).toBe(false);
    purchase.release();
    const { order } = await purchase.done;
    expect((await frozen).cancelledOrderIds).toEqual([]);
    expect((await orderRow(order.id)).status).toBe('paid');

    // The freeze first: the purchase waits, then is refused.
    const late = await customer({ funds: usd(10) });
    const freezing = held((tx) =>
      freezeCustomer(tx, context(), { customerId: late, reason, actor: admin }),
    );
    await freezing.entered;
    const buying = buy(request(late, item));
    expect(await settledWithin(buying, 200)).toBe(false);
    freezing.release();
    await freezing.done;
    expect((await refusal(buying)).code).toBe('ACCOUNT_FROZEN');
    expect(await balance(late)).toBe(usd(10));
  });

  it('caps purchases over 24 hours net of refunds, and a checkout as a whole (LM4)', async () => {
    const item = await product();
    const buyer = await customer({ funds: usd(10) });
    await setCap(buyer, usd(1));
    const { order } = await buy(request(buyer, item));
    expect(await refusal(buy(request(buyer, item)))).toEqual({
      code: 'PURCHASE_LIMIT_EXCEEDED',
      details: { limitUnits: usd(1), remainingUnits: usd(1) - item.price },
    });
    // Edge case 5: a checkout beyond the cap is refused as a whole.
    expect((await refusal(payCheckout(cart(buyer, [item])))).code).toBe('PURCHASE_LIMIT_EXCEEDED');
    // Edge case 6: a refund frees room by its amount.
    await db.transaction(async (tx) =>
      refundRemaining(tx, context(), (await lockOrder(tx, order.id)) as OrderRow, 'no_route', {
        actor: 'system',
        actorId: null,
      }),
    );
    expect(await purchasedLastDay(db, buyer)).toBe(0);
    expect((await buy(request(buyer, item))).created).toBe(true);
    await setCap(buyer, null);
    expect((await buy(request(buyer, item))).created).toBe(true);
  });

  it('counts only orders paid in the last 24 hours (LM4)', async () => {
    const item = await product();
    const buyer = await customer({ funds: usd(10) });
    const { order } = await buy(request(buyer, item));
    expect(await purchasedLastDay(db, buyer)).toBe(item.price);
    // Only the owner, with the guard off inside one transaction, can move a payment back in time.
    await owner.db.transaction(async (tx) => {
      await tx.execute(sql`alter table orders disable trigger orders_guard`);
      await tx.execute(
        sql`update orders set paid_at = now() - interval '24 hours' where id = ${order.id}`,
      );
      await tx.execute(sql`alter table orders enable trigger orders_guard`);
    });
    expect(await purchasedLastDay(db, buyer)).toBe(0);
  });

  it('refuses a reservation above the cap and skips paying one past it (LM4, edge case 7)', async () => {
    const item = await product();
    const buyer = await customer();
    await setCap(buyer, item.price - 10_000);
    expect((await refusal(reserve(buyer, item))).code).toBe('PURCHASE_LIMIT_EXCEEDED');
    await setCap(buyer, item.price + 10_000);
    const reserved = (await reserve(buyer, item)).order;
    await db.transaction(async (tx) => {
      await postJournal(tx, {
        idempotencyKey: `test:${newId()}`,
        kind: 'adjustment',
        postings: [
          { accountId: await ensureCustomerWallet(tx, buyer), amountUnits: usd(10) },
          {
            accountId: await ensureSystemAccount(tx, {
              code: 'adjustments:test_funds',
              kind: 'adjustments',
              currency: 'USD',
            }),
            amountUnits: -usd(10),
          },
        ],
      });
    });
    await buy(request(buyer, item));
    const run = await payWaitingOrders(
      db,
      { jobs: context().jobs, now: () => new Date(), fakeEnabled: true },
      buyer,
    );
    expect(run.outcomes).toEqual([{ orderId: reserved.id, outcome: 'skipped_cap' }]);
    expect((await orderRow(reserved.id)).status).toBe('awaiting_balance');
  });

  it('archives only a customer with a zero balance and nothing open (AR1, AR2)', async () => {
    const item = await product();
    const rich = await customer({ funds: usd(1) });
    expect(await stateRefusal(archive(rich))).toEqual({
      code: 'CUSTOMER_NOT_ARCHIVABLE',
      details: { blockers: ['balance'] },
    });
    const buyer = await customer({ funds: item.price });
    await buy(request(buyer, item));
    expect(await stateRefusal(archive(buyer))).toEqual({
      code: 'CUSTOMER_NOT_ARCHIVABLE',
      details: { blockers: ['open_orders'] },
    });

    const quiet = await customer();
    await pool.query(
      `insert into customer_sessions (id, user_id, token, expires_at)
       values ($1, $2, $3, now() + interval '1 day')`,
      [newId(), quiet, newId()],
    );
    const ticket = newId();
    await pool.query(
      `insert into support_tickets (id, number, customer_id, category, subject, status, opened_by)
       values ($1, $2, $3, 'account', 'سؤال', 'open', 'customer')`,
      [ticket, ticketNumber(), quiet],
    );
    expect(await archive(quiet)).toEqual({ sessions: 1, closedTicketIds: [ticket] });
    const { rows } = await pool.query(
      'select status, closed_by from support_tickets where id = $1',
      [ticket],
    );
    expect(rows).toEqual([{ status: 'closed', closed_by: 'system' }]);
    expect(await stateRefusal(archive(quiet))).toMatchObject({ code: 'CUSTOMER_STATE_INVALID' });
    expect(await stateRefusal(freeze(quiet))).toEqual({
      code: 'CUSTOMER_STATE_INVALID',
      details: { status: 'archived' },
    });
    await db.transaction((tx) =>
      unarchiveCustomer(tx, { customerId: quiet, reason, actor: admin }),
    );
  });

  it('serializes an archive and a checkout: the checkout first blocks the archive (AR1)', async () => {
    const item = await product();
    const buyer = await customer({ funds: item.price });
    const paying = held((tx) => checkoutOrders(tx, context(), cart(buyer, [item])));
    await paying.entered;
    const archiving = archive(buyer);
    expect(await settledWithin(archiving, 200)).toBe(false);
    paying.release();
    await paying.done;
    expect(await stateRefusal(archiving)).toEqual({
      code: 'CUSTOMER_NOT_ARCHIVABLE',
      details: { blockers: ['open_orders'] },
    });
  });

  it('refuses a reservation that waited behind an archive (AR1)', async () => {
    const item = await product();
    const quiet = await customer();
    const archiving = held((tx) =>
      archiveCustomer(tx, { customerId: quiet, reason, actor: admin }),
    );
    await archiving.entered;
    const reserving = reserve(quiet, item);
    expect(await settledWithin(reserving, 200)).toBe(false);
    archiving.release();
    await archiving.done;
    expect((await refusal(reserving)).code).toBe('ACCOUNT_FROZEN');
    const open = await db
      .select({ id: orders.id })
      .from(orders)
      .where(eq(orders.customerId, quiet));
    expect(open).toEqual([]);
  });

  it('keeps one open ticket per order: of two at once, one wins (TK1, edge case 12)', async () => {
    const item = await product();
    const buyer = await customer({ funds: usd(10) });
    const { order } = await buy(request(buyer, item));
    const open = (closed: boolean) =>
      pool.query(
        `insert into support_tickets (id, number, customer_id, category, order_id, subject, status,
           opened_by, closed_at, closed_by)
         values ($1, $2, $3, 'order', $4, 'أين طلبي؟', $5, 'customer', $6, $7)`,
        [
          newId(),
          ticketNumber(),
          buyer,
          order.id,
          closed ? 'closed' : 'open',
          closed ? new Date() : null,
          closed ? 'customer' : null,
        ],
      );
    const outcomes = await Promise.allSettled([open(false), open(false)]);
    expect(outcomes.filter((outcome) => outcome.status === 'fulfilled')).toHaveLength(1);
    await open(true);
  });
});

const TICKET_ALPHABET = '23456789ABCDEFGHJKMNPQRSTUVWXYZ';

describe('admin purchases (S16 AP1–AP15, AM1–AM3)', () => {
  const adminId = newId();

  /** A new policy row like the one in force, with this owner cap. */
  async function setOwnerCap(units: number) {
    await pool.query(
      `insert into order_policy (id, first_poll_seconds, fast_poll_seconds, fast_poll_minutes,
         slow_poll_seconds, hard_limit_minutes, review_poll_minutes, review_poll_hours,
         manual_reminder_minutes, owner_daily_cap_usd_units, admin_id)
       select $1, first_poll_seconds, fast_poll_seconds, fast_poll_minutes, slow_poll_seconds,
         hard_limit_minutes, review_poll_minutes, review_poll_hours, manual_reminder_minutes, $2, $3
       from order_policy order by created_at desc, id desc limit 1`,
      [newId(), units, adminId],
    );
  }

  beforeAll(() => setOwnerCap(usd(10_000)));

  function adminInput(
    item: { id: string; price: number },
    overrides: Partial<AdminPurchaseInput> = {},
  ): AdminPurchaseInput {
    return {
      adminId,
      purpose: 'walk_in',
      customerId: null,
      priceListId: null,
      productId: item.id,
      quantity: 1,
      fields: { player_id: '5123456789' },
      expectedUnitPriceUsdUnits: item.price,
      confirmPlayer: false,
      reason: 'Bought at the counter',
      customerNote: null,
      idempotencyKey: newId(),
      requestHash: hash({ productId: item.id, admin: true }),
      fakeEnabled: true,
      purchasesStopped: false,
      playerCheck: async () => null,
      ...overrides,
    };
  }

  const adminBuy = (input: AdminPurchaseInput) =>
    db.transaction((tx) => adminPurchaseOrder(tx, context(), input));

  const drawings = () => db.transaction(async (tx) => accountBalance(tx, await ownerDrawings(tx)));

  it('charges a merchant on behalf at their list; gifts take the cost list, walk-in retail (S20 PO4, AP16)', async () => {
    const item = await product({ cost: usd(1) });
    const merchant = await customer({ funds: usd(10) });
    await db.update(customers).set({ accountType: 'merchant' }).where(eq(customers.id, merchant));
    expect(
      await refusal(adminBuy(adminInput(item, { purpose: 'on_behalf', customerId: merchant }))),
    ).toMatchObject({ code: 'PRICE_CHANGED', details: { unitPriceUsdUnits: usd(1.05) } });
    const onBehalf = await adminBuy(
      adminInput({ id: item.id, price: usd(1.05) }, { purpose: 'on_behalf', customerId: merchant }),
    );
    expect(onBehalf.order).toMatchObject({
      priceListId: ROOT_PRICE_LIST_IDS.wholesale,
      unitPriceUsdUnits: usd(1.05),
      payer: 'customer',
    });
    expect(await balance(merchant)).toBe(usd(10) - usd(1.05));
    const costPrice = await listPriceOf(item.id, ROOT_PRICE_LIST_IDS.cost);
    expect(costPrice).toBeLessThan(item.price);
    for (const purpose of ['gift', 'compensation'] as const) {
      // A gift or a compensation is booked at the cost list, whatever the customer pays.
      expect(
        await refusal(
          adminBuy(
            adminInput(item, { purpose, customerId: merchant, reason: 'A gift from owner' }),
          ),
        ),
      ).toMatchObject({ code: 'PRICE_CHANGED', details: { unitPriceUsdUnits: costPrice } });
      const { order } = await adminBuy(
        adminInput(
          { id: item.id, price: costPrice },
          { purpose, customerId: merchant, reason: 'A gift from the owner' },
        ),
      );
      expect(order).toMatchObject({
        priceListId: ROOT_PRICE_LIST_IDS.cost,
        unitPriceUsdUnits: costPrice,
        payer: 'owner',
      });
    }
    const walkIn = await adminBuy(adminInput(item));
    expect(walkIn.order.priceListId).toBe(ROOT_PRICE_LIST_IDS.retail);
  });

  it('charges a walk-in order on the list the admin chose; an unknown or archived list is refused (AP16)', async () => {
    const item = await product({ cost: usd(1) });
    const wholesale = await listPriceOf(item.id, ROOT_PRICE_LIST_IDS.wholesale);
    const { order } = await adminBuy(
      adminInput({ id: item.id, price: wholesale }, { priceListId: ROOT_PRICE_LIST_IDS.wholesale }),
    );
    expect(order).toMatchObject({
      priceListId: ROOT_PRICE_LIST_IDS.wholesale,
      unitPriceUsdUnits: wholesale,
      payer: 'owner',
    });
    expect(await refusal(adminBuy(adminInput(item, { priceListId: newId() })))).toMatchObject({
      code: 'VALIDATION_FAILED',
      details: { fields: { priceListId: 'not_found' } },
    });
    const archived = newId();
    await pool.query(
      `insert into price_lists (id, kind, name, parent_list_id, archived_at)
       values ($1, 'custom', $2, $3, now())`,
      [archived, `List ${unique()}`, ROOT_PRICE_LIST_IDS.retail],
    );
    expect(await refusal(adminBuy(adminInput(item, { priceListId: archived })))).toMatchObject({
      code: 'VALIDATION_FAILED',
    });
  });

  it('gives a paused pack as a gift at the cost list (AP5, AP16)', async () => {
    const item = await product({ cost: usd(1) });
    const buyer = await customer();
    await pool.query("update catalog_products set status = 'paused' where id = $1", [item.id]);
    const costPrice = await listPriceOf(item.id, ROOT_PRICE_LIST_IDS.cost);
    const { order } = await adminBuy(
      adminInput({ id: item.id, price: costPrice }, { purpose: 'gift', customerId: buyer }),
    );
    expect(order).toMatchObject({ priceListId: ROOT_PRICE_LIST_IDS.cost, payer: 'owner' });
  });

  it('pays a walk-in order from owner drawings, without a customer or a notice (AP1, AM2, AP12, AP13)', async () => {
    const item = await product();
    const before = await drawings();
    sent.length = 0;
    const { order, created } = await adminBuy(adminInput(item));
    expect(created).toBe(true);
    expect(order).toMatchObject({
      status: 'paid',
      customerId: null,
      isTest: false,
      placedBy: 'admin',
      payer: 'owner',
      adminPurpose: 'walk_in',
      adminId,
      adminReason: 'Bought at the counter',
      customerNote: null,
    });
    expect(await drawings()).toBe(before - item.price);
    expect(sent.map((job) => job.queue)).toEqual(
      expect.arrayContaining([QUEUES.ordersFulfil, QUEUES.telegramSend]),
    );
    const [event] = await db.select().from(orderEvents).where(eq(orderEvents.orderId, order.id));
    expect(event).toMatchObject({ actor: 'admin', actorId: adminId, toStatus: 'paid' });
    const [audit] = await db
      .select()
      .from(auditEntries)
      .where(and(eq(auditEntries.entityId, order.id), eq(auditEntries.action, 'order.paid')));
    expect(audit).toMatchObject({
      actorKind: 'admin',
      actorId: adminId,
      reason: 'Bought at the counter',
    });
    expect(audit?.details).toMatchObject({ purpose: 'walk_in', payer: 'owner', customerId: null });
    const [notice] = await db
      .select()
      .from(telegramMessages)
      .where(eq(telegramMessages.dedupeKey, `admin-order:${order.id}`));
    expect(notice?.params).toMatchObject({
      orderNumber: order.number,
      purpose: 'walk_in',
      totalUsdUnits: item.price,
      owner: { capUsdUnits: usd(10_000) },
    });
    expect(await adminOrder(db, order.id)).toMatchObject({
      customer: null,
      placedBy: 'admin',
      payer: 'owner',
      purpose: 'walk_in',
      adminReason: 'Bought at the counter',
    });
    const page = await adminOrderPage(db, {
      tab: 'all',
      page: 1,
      pageSize: 50,
      purpose: 'walk_in',
      payer: 'owner',
      placedBy: 'admin',
    });
    expect(page.items.map((row) => row.id)).toContain(order.id);
    expect(page.items.every((row) => row.purpose === 'walk_in' && row.customer === null)).toBe(
      true,
    );
  });

  it('replays the same key and body, and refuses the key for another body (AP2)', async () => {
    const item = await product();
    const input = adminInput(item);
    const first = await adminBuy(input);
    expect(await adminBuy(input)).toMatchObject({ created: false, order: { id: first.order.id } });
    expect(await refusal(adminBuy({ ...input, requestHash: hash({ other: true }) }))).toMatchObject(
      { code: 'IDEMPOTENCY_KEY_REUSED' },
    );
    // A customer's key never replays as an admin order.
    const buyer = await customer({ funds: usd(10) });
    const bought = await buy(request(buyer, item));
    expect(
      await refusal(adminBuy({ ...input, idempotencyKey: bought.order.idempotencyKey })),
    ).toMatchObject({ code: 'IDEMPOTENCY_KEY_REUSED' });
  });

  it('pays on behalf of a customer from the wallet and tells them (AM1, AP4, AP11)', async () => {
    const item = await product();
    const buyer = await customer({ funds: usd(5) });
    const before = await drawings();
    const { order } = await adminBuy(
      adminInput(item, { purpose: 'on_behalf', customerId: buyer, reason: 'Asked on WhatsApp' }),
    );
    expect(order).toMatchObject({
      payer: 'customer',
      customerId: buyer,
      adminPurpose: 'on_behalf',
    });
    expect(await balance(buyer)).toBe(usd(5) - item.price);
    expect(await drawings()).toBe(before);
    const [notice] = await db
      .select()
      .from(customerNotifications)
      .where(eq(customerNotifications.customerId, buyer));
    expect(notice).toMatchObject({
      event: 'order_placed_for_you',
      params: { orderId: order.id, purpose: 'on_behalf' },
    });
    // It counts toward the customer's own daily cap (S12 LM4).
    expect(await purchasedLastDay(db, buyer)).toBe(item.price);
    expect(await customerOrder(db, buyer, order.id)).toMatchObject({
      placedByStore: 'on_behalf',
      totalUsdUnits: item.price,
      customerNote: null,
    });
    const poor = await customer({ funds: usd(0.5) });
    expect(
      await refusal(adminBuy(adminInput(item, { purpose: 'on_behalf', customerId: poor }))),
    ).toMatchObject({ code: 'INSUFFICIENT_BALANCE' });
  });

  it('gives a gift from owner funds, hides its price and refunds it to owner drawings (AM2, AM3, AP11, edge case 4)', async () => {
    const product0 = await product();
    const item = { ...product0, price: await listPriceOf(product0.id, ROOT_PRICE_LIST_IDS.cost) };
    const buyer = await customer();
    const before = await drawings();
    const usedBefore = (await ownerSpentToday(db)).usedUsdUnits;
    const { order } = await adminBuy(
      adminInput(item, {
        purpose: 'gift',
        customerId: buyer,
        reason: 'Loyal customer gift',
        customerNote: 'عيد سعيد',
      }),
    );
    expect(order).toMatchObject({ payer: 'owner', customerNote: 'عيد سعيد' });
    expect(await drawings()).toBe(before - item.price);
    expect((await ownerSpentToday(db)).usedUsdUnits).toBe(usedBefore + item.price);
    expect(await purchasedLastDay(db, buyer)).toBe(0);
    const [notice] = await db
      .select()
      .from(customerNotifications)
      .where(eq(customerNotifications.customerId, buyer));
    expect(notice?.params).toMatchObject({ purpose: 'gift', message: 'عيد سعيد' });
    expect(await customerOrder(db, buyer, order.id)).toMatchObject({
      placedByStore: 'gift',
      customerNote: 'عيد سعيد',
      unitPriceUsdUnits: null,
      totalUsdUnits: null,
      totalSypUnits: null,
      refundedUsdUnits: null,
    });
    const page = await customerOrderPage(db, buyer, { after: null, limit: 10 });
    expect(page.items[0]).toMatchObject({ placedByStore: 'gift', totalUsdUnits: null });

    const attemptId = await send(order, item);
    await apply(attemptId, { status: 'failed', reason: 'refused', inputRejected: true });
    const refunded = (await orderRow(order.id)) as OrderRow;
    expect(refunded.status).toBe('refunded');
    expect(await drawings()).toBe(before);
    expect(await findCustomerWallet(db, buyer)).toBeNull();
    expect((await ownerSpentToday(db)).usedUsdUnits).toBe(usedBefore);
    const [latest] = await db
      .select()
      .from(customerNotifications)
      .where(eq(customerNotifications.customerId, buyer))
      .orderBy(desc(customerNotifications.createdAt))
      .limit(1);
    expect(latest).toMatchObject({ event: 'order_refunded', params: { refundedUsdUnits: null } });

    // C4, C6, C7 pass with owner-funded orders.
    const { results } = await runInternalChecks(db);
    for (const check of ['account_journal_kinds', 'order_purchase', 'order_refund']) {
      const offending = results
        .filter((result) => result.check === check)
        .flatMap((result) => result.details.offending.map((entry) => entry.id));
      for (const id of [order.id, refunded.purchaseJournalId, refunded.refundJournalId]) {
        expect(offending).not.toContain(id);
      }
    }
  });

  it("applies the customer's own rules to the customer modes (AP3, AP4, AP6, edge cases 5–7, 22)", async () => {
    const item = await product();
    const archived = await customer();
    await pool.query('update customers set archived_at = now() where id = $1', [archived]);
    expect(
      await refusal(adminBuy(adminInput(item, { purpose: 'gift', customerId: archived }))),
    ).toMatchObject({ code: 'NOT_FOUND' });
    const unverified = await customer();
    await pool.query('update customers set email_verified = false where id = $1', [unverified]);
    expect(
      await refusal(
        adminBuy(adminInput(item, { purpose: 'compensation', customerId: unverified })),
      ),
    ).toMatchObject({ code: 'EMAIL_NOT_VERIFIED' });
    const frozen = await customer({ funds: usd(10) });
    await pool.query('update customers set frozen_at = now() where id = $1', [frozen]);
    for (const purpose of ['gift', 'on_behalf'] as const) {
      expect(
        await refusal(adminBuy(adminInput(item, { purpose, customerId: frozen }))),
      ).toMatchObject({ code: 'ACCOUNT_FROZEN' });
    }
    expect(
      await refusal(adminBuy(adminInput(item, { purpose: 'gift', customerId: null }))),
    ).toMatchObject({ code: 'VALIDATION_FAILED' });
    expect(await refusal(adminBuy(adminInput(item, { purchasesStopped: true })))).toMatchObject({
      code: 'PURCHASES_STOPPED',
    });
    expect(
      await refusal(adminBuy(adminInput(item, { expectedUnitPriceUsdUnits: item.price + usd(1) }))),
    ).toMatchObject({ code: 'PRICE_CHANGED', details: { unitPriceUsdUnits: item.price } });
  });

  it('buys a paused pack from owner funds only (AP5, edge case 10)', async () => {
    const item = await product();
    await pool.query("update catalog_products set status = 'paused' where id = $1", [item.id]);
    const buyer = await customer({ funds: usd(10) });
    expect(
      await refusal(adminBuy(adminInput(item, { purpose: 'on_behalf', customerId: buyer }))),
    ).toMatchObject({ code: 'PRODUCT_UNAVAILABLE' });
    const { order } = await adminBuy(adminInput(item));
    expect(order.status).toBe('paid');
    const { rows } = await pool.query<{ status: string }>(
      'select status from catalog_products where id = $1',
      [item.id],
    );
    expect(rows[0]?.status).toBe('paused');
    await pool.query('update catalog_products set archived_at = now() where id = $1', [item.id]);
    expect(await refusal(adminBuy(adminInput(item)))).toMatchObject({
      code: 'PRODUCT_UNAVAILABLE',
    });
  });

  it('lets exactly one of two owner orders pass at the edge of the cap (AP7, edge case 3)', async () => {
    const item = await product();
    const { usedUsdUnits } = await ownerSpentToday(db);
    // Room for one order and a half, in whole cents.
    await setOwnerCap(Math.ceil((usedUsdUnits + item.price * 1.5) / 10_000) * 10_000);
    try {
      const results = await Promise.allSettled([
        adminBuy(adminInput(item)),
        adminBuy(adminInput(item)),
      ]);
      expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
      const failed = results.find((result) => result.status === 'rejected');
      const error = (failed as PromiseRejectedResult).reason as OrderError;
      expect(error.code).toBe('OWNER_DAILY_CAP_EXCEEDED');
      expect((error.details as { remainingUsdUnits: number }).remainingUsdUnits).toBeLessThan(
        item.price,
      );
      // A cap of 0 turns owner-funded orders off.
      await setOwnerCap(0);
      expect(await refusal(adminBuy(adminInput(item)))).toMatchObject({
        code: 'OWNER_DAILY_CAP_EXCEEDED',
        details: { remainingUsdUnits: 0 },
      });
    } finally {
      await setOwnerCap(usd(10_000));
    }
  });

  it("never takes a wallet below zero beside the customer's own purchase (AM1)", async () => {
    const item = await product();
    const buyer = await customer({ funds: item.price });
    const results = await Promise.allSettled([
      adminBuy(adminInput(item, { purpose: 'on_behalf', customerId: buyer })),
      buy(request(buyer, item)),
    ]);
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect(await balance(buyer)).toBe(0);
  });

  it('keeps the admin columns tied together and fixed (migrations 0051–0053)', async () => {
    const item = await product();
    const { order } = await adminBuy(adminInput(item));
    for (const change of [
      `customer_note = 'نص'`,
      `admin_reason = 'Another reason'`,
      `payer = 'customer'`,
      `placed_by = 'customer'`,
    ]) {
      await expect(
        pool.query(`update orders set ${change} where id = $1`, [order.id]),
      ).rejects.toThrow();
    }
    // The checks, which the guard does not reach: an order inserted with admin columns that do not fit.
    const buyer = await customer({ funds: usd(10) });
    const bought = await buy(request(buyer, item));
    const copy = (overrides: string) =>
      pool.query(
        `insert into orders select (jsonb_populate_record(o, jsonb_build_object(
           'id', $2::uuid, 'number', 'VO-' || $3, 'idempotency_key', $4::uuid,
           'purchase_journal_id', null, 'paid_at', null, 'status', 'awaiting_balance',
           'reserved_at', now(), 'expires_at', now() + interval '1 hour') || ${overrides})).*
         from orders o where o.id = $1`,
        [bought.order.id, newId(), 'ZZZZZZ', newId()],
      );
    await expect(copy(`jsonb_build_object('customer_note', 'نص')`)).rejects.toThrow(
      /orders_admin_check/,
    );
    await expect(
      copy(`jsonb_build_object('placed_by', 'admin', 'admin_purpose', 'walk_in',
        'admin_id', gen_random_uuid(), 'admin_reason', 'Reason here', 'payer', 'owner')`),
    ).rejects.toThrow(/orders_admin_check/);
    // A player check names exactly one requester.
    await expect(
      pool.query(
        `insert into player_checks (id, game_id, fields_hash, result, supplier_id, expires_at)
         values ($1, $2, $3, 'valid', $4, now() + interval '1 hour')`,
        [newId(), item.game, 'a'.repeat(64), suppliers.fake],
      ),
    ).rejects.toThrow(/player_checks_requester_check/);
    await pool.query(
      `insert into player_checks (id, game_id, fields_hash, result, supplier_id, admin_id,
         expires_at) values ($1, $2, $3, 'valid', $4, $5, now() + interval '1 hour')`,
      [newId(), item.game, 'b'.repeat(64), suppliers.fake, adminId],
    );
  });
});

describe('the supplier statement matched to attempts (S16 SF3, SF4)', () => {
  it('names the newest attempt of a supplier order id, and the facts of an attempt', async () => {
    const item = await product();
    const buyer = await customer({ funds: usd(10) });
    const { order } = await buy(request(buyer, item));
    const attemptId = await send(order, item);
    const supplierOrderId = `m-${unique()}`;
    await apply(attemptId, { status: 'pending', supplierOrderId });
    const matches = await supplierOrderMatches(db, suppliers.fake, [
      supplierOrderId,
      supplierOrderId,
      `none-${unique()}`,
      '',
    ]);
    expect([...matches.keys()]).toEqual([supplierOrderId]);
    expect(matches.get(supplierOrderId)).toEqual({
      orderId: order.id,
      orderNumber: order.number,
      orderStatus: 'sent_to_supplier',
      attemptId,
      attemptStatus: 'pending',
    });
    expect((await supplierOrderMatches(db, suppliers.manual, [supplierOrderId])).size).toBe(0);
    expect((await supplierOrderMatches(db, suppliers.fake, [])).size).toBe(0);
    expect(await attemptSupplierFacts(db, order.id, attemptId)).toMatchObject({
      attemptId,
      supplierId: suppliers.fake,
      supplierCode: 'fake',
      supplierOfferId: 'o-test',
      quantity: 1,
    });
    expect(await attemptSupplierFacts(db, newId(), attemptId)).toBeNull();
  });
});

describe('price lists (S20 PO2–PO4)', () => {
  const { retail, wholesale, cost } = ROOT_PRICE_LIST_IDS;
  const listRow = async (productId: string, priceListId: string) =>
    (
      await db
        .select()
        .from(productPrices)
        .where(
          and(eq(productPrices.productId, productId), eq(productPrices.priceListId, priceListId)),
        )
        .orderBy(desc(productPrices.createdAt))
        .limit(1)
    )[0];
  const setAccount = (
    id: string,
    values: { accountType?: 'merchant' | 'customer'; priceListId?: string | null },
  ) => db.update(customers).set(values).where(eq(customers.id, id));

  it('charges the effective list’s row and records the list on the order (PO2, AT1)', async () => {
    const item = await product({ cost: usd(1) });
    expect(item.price).toBe(usd(1.1));
    const merchant = await customer({ funds: usd(10) });
    await setAccount(merchant, { accountType: 'merchant' });
    const row = await listRow(item.id, wholesale);
    expect(row?.priceUsdUnits).toBe(usd(1.05));

    // The retail figure is refused with the merchant's price.
    expect(await refusal(buy(request(merchant, item)))).toMatchObject({
      code: 'PRICE_CHANGED',
      details: { unitPriceUsdUnits: usd(1.05) },
    });
    const { order } = await buy(request(merchant, { id: item.id, price: usd(1.05) }));
    expect(order).toMatchObject({
      priceListId: wholesale,
      priceId: row?.id,
      unitPriceUsdUnits: usd(1.05),
      minMarginUsdUnits: usd(0.05),
    });
    expect(await balance(merchant)).toBe(usd(10) - usd(1.05));
    // No share link shows a price charged off retail, whatever the owner chose (S20 privacy).
    expect((await customerOrder(db, merchant, order.id))?.privatePrice).toBe(true);
    const link = await db.transaction((tx) =>
      createShareLink(tx, { orderId: order.id, kind: 'receipt', showPrice: true }),
    );
    expect((await publicShare(db, link.token))?.share.price).toBeNull();

    // An assigned list wins over the type's default; a customer stays on retail.
    await setAccount(merchant, { priceListId: cost });
    const special = await buy(request(merchant, { id: item.id, price: usd(1.01) }));
    expect(special.order).toMatchObject({ priceListId: cost, unitPriceUsdUnits: usd(1.01) });
    const buyer = await customer({ funds: usd(10) });
    expect((await buy(request(buyer, item))).order.priceListId).toBe(retail);

    // Migration 0078: the list is fixed with the price.
    await expect(
      pool.query('update orders set price_list_id = $2 where id = $1', [order.id, retail]),
    ).rejects.toThrow(/fixed once paid/);
  });

  it('refuses a product without a row on the list (RP4, edge case 1)', async () => {
    const item = await product();
    const listId = newId();
    await pool.query(
      `insert into price_lists (id, kind, name, parent_list_id) values ($1, 'custom', $2, $3)`,
      [listId, `قائمة ${unique()}`, wholesale],
    );
    try {
      const buyer = await customer({ funds: usd(10) });
      await setAccount(buyer, { priceListId: listId });
      expect(await refusal(buy(request(buyer, item)))).toMatchObject({
        code: 'PRODUCT_UNAVAILABLE',
        details: { availability: 'out_of_stock' },
      });
    } finally {
      await pool.query('update price_lists set archived_at = now() where id = $1', [listId]);
    }
  });

  it('cancels a reservation whose list is no longer the account’s, never pays it (PO3)', async () => {
    const item = await product();
    const buyer = await customer({ funds: usd(0.1) });
    const { order } = await buy(request(buyer, item, { whenBalanceShort: 'reserve' }));
    expect(order).toMatchObject({ status: 'awaiting_balance', priceListId: retail });
    await setAccount(buyer, { accountType: 'merchant' });
    await db.transaction(async (tx) => {
      await postJournal(tx, {
        idempotencyKey: `test:${newId()}`,
        kind: 'adjustment',
        postings: [
          { accountId: await ensureCustomerWallet(tx, buyer), amountUnits: usd(10) },
          {
            accountId: await ensureSystemAccount(tx, {
              code: 'adjustments:test_funds',
              kind: 'adjustments',
              currency: 'USD',
            }),
            amountUnits: -usd(10),
          },
        ],
      });
    });
    const run = await payWaitingOrders(
      db,
      { ...context(), now: () => new Date(), fakeEnabled: true },
      buyer,
    );
    expect(run.outcomes).toEqual([{ orderId: order.id, outcome: 'cancelled_price_list_changed' }]);
    expect(await orderRow(order.id)).toMatchObject({
      status: 'cancelled',
      cancelReason: 'price_list_changed',
    });
    expect(await balance(buyer)).toBe(usd(10.1));
  });

  const admin = { adminId: newId(), ipAddress: null, userAgent: null };
  const reason = 'حساب تاجر جملة';
  const assign = (customerId: string, priceListId: string | null) =>
    db.transaction((tx) =>
      setCustomerPriceList(tx, context(), { customerId, priceListId, reason, actor: admin }),
    );
  const assignRefusal = async (promise: Promise<unknown>) => {
    try {
      await promise;
    } catch (error) {
      if (error instanceof CustomerError) return error.code;
      throw error;
    }
    throw new Error('Expected a refusal');
  };

  it('assigns a list, cancels reservations and tells the customer, center only (AT2, AT3)', async () => {
    const item = await product();
    const buyer = await customer({ funds: usd(0.1) });
    const { order } = await buy(request(buyer, item, { whenBalanceShort: 'reserve' }));
    const result = await assign(buyer, cost);
    expect(result).toEqual({ cancelledOrderIds: [order.id] });
    expect(await orderRow(order.id)).toMatchObject({ cancelReason: 'price_list_changed' });
    expect(await accountPriceList(db, buyer)).toEqual({
      accountType: 'customer',
      assignedListId: cost,
      effectiveList: { id: cost, kind: 'cost', name: 'سعر التكلفة' },
      priceKind: 'special',
    });
    const { rows: notices } = await pool.query(
      `select n.event, n.params, (select count(*) from email_outbox e
         where e.customer_id = n.customer_id and e.template = 'customer_order_cancelled')::int as emails
       from customer_notifications n where n.customer_id = $1 order by n.event`,
      [buyer],
    );
    expect(notices.map((row) => [row.event, row.params])).toEqual([
      ['order_cancelled', expect.objectContaining({ reason: 'price_list_changed' })],
      ['price_list_changed', { priceKind: 'special' }],
    ]);
    // The reservation's cancel email only (S09); the list change has none.
    expect(notices[0]?.emails).toBe(1);
    const { rows: audits } = await pool.query(
      `select details, reason from audit_entries where entity_id = $1
         and action = 'customer.price_list_changed'`,
      [buyer],
    );
    expect(audits).toEqual([
      {
        reason,
        details: {
          before: { priceListId: null, effectiveListId: retail },
          after: { priceListId: cost, effectiveListId: cost },
          cancelledOrderIds: [order.id],
        },
      },
    ]);
    // Back to the type's default: a merchant's is wholesale.
    await setAccount(buyer, { accountType: 'merchant' });
    expect(await assign(buyer, null)).toEqual({ cancelledOrderIds: [] });
    expect((await accountPriceList(db, buyer))?.effectiveList.id).toBe(wholesale);
    // The same effective list again tells nobody.
    await assign(buyer, wholesale);
    const { rows } = await pool.query(
      `select count(*)::int as count from customer_notifications
       where customer_id = $1 and event = 'price_list_changed'`,
      [buyer],
    );
    expect(rows[0]?.count).toBe(2);
  });

  it('refuses an archived account, an archived list and a list not priced yet', async () => {
    const buyer = await customer({ funds: 0 });
    const listId = newId();
    await pool.query(
      `insert into price_lists (id, kind, name, parent_list_id, archived_at)
       values ($1, 'custom', $2, $3, now())`,
      [listId, `قائمة ${unique()}`, wholesale],
    );
    expect(await assignRefusal(assign(buyer, listId))).toBe('PRICE_LIST_ARCHIVED');
    expect(await assignRefusal(assign(buyer, newId()))).toBe('NOT_FOUND');
    await db
      .transaction(async (tx) => {
        await tx.execute(
          sql`update margin_rules set archived_at = now() where price_list_id = ${cost}`,
        );
        expect(
          await assignRefusal(
            setCustomerPriceList(tx, context(), {
              customerId: buyer,
              priceListId: cost,
              reason,
              actor: admin,
            }),
          ),
        ).toBe('PRICE_LIST_NOT_READY');
        throw new Error('rollback');
      })
      .catch((error: Error) => expect(error.message).toBe('rollback'));
    await pool.query('update customers set archived_at = now() where id = $1', [buyer]);
    expect(await assignRefusal(assign(buyer, cost))).toBe('CUSTOMER_STATE_INVALID');
  });

  it('serializes an assignment with a purchase: the purchase sees one list (AT3)', async () => {
    const item = await product({ cost: usd(1) });
    const buyer = await customer({ funds: usd(10) });
    const results = await Promise.allSettled([buy(request(buyer, item)), assign(buyer, cost)]);
    const [purchase, assigned] = results;
    expect(assigned.status).toBe('fulfilled');
    // Either the purchase ran first at retail, or after the change and was refused at cost.
    if (purchase.status === 'fulfilled') {
      expect(purchase.value.order).toMatchObject({
        priceListId: retail,
        unitPriceUsdUnits: usd(1.1),
      });
    } else {
      expect(purchase.reason).toMatchObject({
        code: 'PRICE_CHANGED',
        details: { unitPriceUsdUnits: usd(1.01) },
      });
    }
  });

  it('releases archived accounts from a list being archived (LS5)', async () => {
    const buyer = await customer({ funds: 0 });
    await setAccount(buyer, { priceListId: cost });
    await pool.query('update customers set archived_at = now() where id = $1', [buyer]);
    const released = await db.transaction((tx) =>
      releaseArchivedAccounts(tx, { priceListId: cost, reason, actor: admin }),
    );
    expect(released).toBeGreaterThanOrEqual(1);
    expect((await accountPriceList(db, buyer))?.assignedListId).toBeNull();
    expect(await accountsOnList(db, cost)).toBe((await assignedAccountCounts(db)).get(cost) ?? 0);
  });
});

describe('merchant accounts (S20 MA5–MA7, MT2)', () => {
  const { retail, wholesale, cost } = ROOT_PRICE_LIST_IDS;
  const admin = { adminId: newId(), ipAddress: null, userAgent: null };
  const grantInput = (values: Partial<GrantInput> = {}): GrantInput => ({
    tradeName: 'محل النور',
    governorate: 'aleppo',
    city: 'اعزاز',
    applicationId: null,
    termsVersionId: null,
    priceListId: null,
    reason: 'تاجر معروف لدينا',
    actor: admin,
    ...values,
  });
  const grant = (customerId: string, values: Partial<GrantInput> = {}) =>
    db.transaction(async (tx) =>
      grantMerchant(tx, context(), await lockCustomer(tx, customerId), grantInput(values)),
    );
  const revoke = (customerId: string) =>
    db.transaction(async (tx) =>
      revokeMerchant(tx, context(), await lockCustomer(tx, customerId), {
        reason: 'لم يعد تاجراً',
        actor: admin,
      }),
    );
  const terms = async () => {
    const id = newId();
    await pool.query(
      `insert into content_page_versions (id, page, version, title, body, draft_revision, admin_id)
       values ($1, 'merchant_terms', 1000 + floor(random() * 1e9)::int, 'شروط التاجر', 'النص', 1, $2)`,
      [id, newId()],
    );
    return id;
  };

  it('grants on wholesale by default, cancels reservations and tells the customer (MA5, AT3)', async () => {
    const item = await product();
    const buyer = await customer({ funds: usd(0.1) });
    const { order } = await buy(request(buyer, item, { whenBalanceShort: 'reserve' }));
    const result = await grant(buyer, { priceListId: wholesale });
    expect(result).toEqual({ effectiveListId: wholesale, cancelledOrderIds: [order.id] });
    expect(await accountPriceList(db, buyer)).toMatchObject({
      accountType: 'merchant',
      assignedListId: null,
      priceKind: 'wholesale',
    });
    expect(await accountMerchant(db, buyer)).toEqual({
      tradeName: 'محل النور',
      termsAccepted: false,
    });
    const { rows } = await pool.query(
      `select event, params from customer_notifications where customer_id = $1 order by event`,
      [buyer],
    );
    // Ordered by the enum: the reservation's cancel, then the grant.
    expect(rows).toEqual([
      expect.objectContaining({ event: 'order_cancelled' }),
      { event: 'merchant_approved', params: { priceKind: 'wholesale' } },
    ]);
    const { rows: audits } = await pool.query(
      `select details from audit_entries where entity_id = $1 and action = 'customer.merchant_granted'`,
      [buyer],
    );
    expect(audits[0]?.details).toMatchObject({ priceListId: null, cancelledOrderIds: [order.id] });
  });

  it('refuses a merchant, a frozen customer and an archived list', async () => {
    const buyer = await customer({ funds: 0 });
    await grant(buyer, { priceListId: cost });
    expect((await accountPriceList(db, buyer))?.effectiveList.id).toBe(cost);
    expect(await refusal(grant(buyer))).toMatchObject({ code: 'ALREADY_MERCHANT' });
    const frozen = await customer({ funds: 0 });
    await pool.query('update customers set frozen_at = now() where id = $1', [frozen]);
    expect(await refusal(grant(frozen))).toMatchObject({ code: 'CUSTOMER_STATE_INVALID' });
    const other = await customer({ funds: 0 });
    expect(await refusal(grant(other, { priceListId: newId() }))).toMatchObject({
      code: 'NOT_FOUND',
    });
  });

  it('asks a directly granted merchant to accept the terms before buying (MT2)', async () => {
    const item = await product();
    const buyer = await customer({ funds: usd(10) });
    await grant(buyer);
    expect(await refusal(buy(request(buyer, item)))).toMatchObject({
      code: 'MERCHANT_TERMS_REQUIRED',
    });
    await pool.query('update merchant_profiles set terms_version_id = $2 where customer_id = $1', [
      buyer,
      await terms(),
    ]);
    const [row] = await db
      .select()
      .from(productPrices)
      .where(and(eq(productPrices.productId, item.id), eq(productPrices.priceListId, wholesale)))
      .orderBy(desc(productPrices.createdAt))
      .limit(1);
    const { order } = await buy(
      request(buyer, item, { expectedUnitPriceUsdUnits: row?.priceUsdUnits as number }),
    );
    expect(order.priceListId).toBe(wholesale);
  });

  it('revokes back to retail, keeping the profile with its date (MA7)', async () => {
    const buyer = await customer({ funds: 0 });
    expect(await refusal(revoke(buyer))).toMatchObject({ code: 'NOT_MERCHANT' });
    await grant(buyer, { priceListId: cost });
    expect(await revoke(buyer)).toEqual({ cancelledOrderIds: [] });
    expect(await accountPriceList(db, buyer)).toMatchObject({
      accountType: 'customer',
      assignedListId: null,
      effectiveList: { id: retail },
    });
    expect(await accountMerchant(db, buyer)).toBeNull();
    expect((await merchantProfileOf(db, buyer))?.revokedAt).toBeInstanceOf(Date);
    await grant(buyer, { tradeName: 'محل جديد' });
    expect((await merchantProfileOf(db, buyer))?.revokedAt).toBeNull();
  });

  it('gives a merchant the merchant tier and rate (MD1, PO5)', async () => {
    const buyer = await customer({ funds: 0 });
    expect(await merchantDepositTier(db, buyer)).toBeNull();
    expect(await orderRate(db, buyer)).toEqual({ merchant: false, perTenMinutes: 10 });
    await grant(buyer);
    expect(await merchantDepositTier(db, buyer)).toEqual({
      perDepositUsdUnits: usd(2000),
      dailyDepositUsdUnits: usd(5000),
    });
    expect(await orderRate(db, buyer)).toEqual({ merchant: true, perTenMinutes: 60 });
  });

  it('cancels reservations on every grant and revocation, whatever the list (AT3, decision 11)', async () => {
    const item = await product();
    const buyer = await customer({ funds: usd(0.1) });
    // Retail kept across the grant (the retail list chosen): the type change still cancels.
    const { order } = await buy(request(buyer, item, { whenBalanceShort: 'reserve' }));
    expect(await grant(buyer, { priceListId: retail })).toMatchObject({
      cancelledOrderIds: [order.id],
    });
    await pool.query('update merchant_profiles set terms_version_id = $2 where customer_id = $1', [
      buyer,
      await terms(),
    ]);
    const { order: second } = await buy(request(buyer, item, { whenBalanceShort: 'reserve' }));
    expect(await revoke(buyer)).toEqual({ cancelledOrderIds: [second.id] });
  });

  it('keeps a reservation waiting while the merchant terms are not accepted (MT2)', async () => {
    const item = await product();
    const buyer = await customer({ funds: usd(0.1) });
    const { order } = await buy(request(buyer, item, { whenBalanceShort: 'reserve' }));
    // A profile without terms on an account whose reservation outlived the grant.
    await pool.query(
      `insert into merchant_profiles (customer_id, trade_name, governorate, city, granted_at)
       values ($1, 'محل', 'damascus', 'دمشق', now())`,
      [buyer],
    );
    await pool.query("update customers set account_type = 'merchant' where id = $1", [buyer]);
    const run = await payWaitingOrders(
      db,
      { ...context(), now: () => new Date(), fakeEnabled: true },
      buyer,
    );
    expect(run.outcomes).toEqual([{ orderId: order.id, outcome: 'skipped_terms' }]);
  });

  it('serializes a grant with a purchase: the purchase sees one list (AT3)', async () => {
    const item = await product({ cost: usd(1) });
    const buyer = await customer({ funds: usd(10) });
    const [purchase, granted] = await Promise.allSettled([
      buy(request(buyer, item)),
      grant(buyer, { priceListId: cost }),
    ]);
    expect(granted.status).toBe('fulfilled');
    if (purchase.status === 'fulfilled') {
      expect(purchase.value.order).toMatchObject({ priceListId: retail });
    } else {
      // After the grant the account is a merchant without accepted terms (MT2).
      expect(purchase.reason).toMatchObject({ code: 'MERCHANT_TERMS_REQUIRED' });
    }
  });
});

describe('merchant tools (S21 SP4, LV3–LV7, AL2–AL6)', () => {
  const { retail, wholesale, cost } = ROOT_PRICE_LIST_IDS;
  const termsVersion = async () => {
    const id = newId();
    await pool.query(
      `insert into content_page_versions (id, page, version, title, body, draft_revision, admin_id)
       values ($1, 'merchant_terms', 1000 + floor(random() * 1e9)::int, 'شروط التاجر', 'النص', 1, $2)`,
      [id, newId()],
    );
    return id;
  };
  const merchant = async (funds: number) => {
    const id = await customer({ funds });
    await db.update(customers).set({ accountType: 'merchant' }).where(eq(customers.id, id));
    await pool.query(
      `insert into merchant_profiles (customer_id, trade_name, governorate, city, granted_at, terms_version_id)
       values ($1, 'محل النور', 'aleppo', 'اعزاز', now(), $2)`,
      [id, await termsVersion()],
    );
    return id;
  };
  const wholesalePrice = async (productId: string) =>
    (
      await db
        .select({ price: productPrices.priceUsdUnits })
        .from(productPrices)
        .where(
          and(eq(productPrices.productId, productId), eq(productPrices.priceListId, wholesale)),
        )
        .orderBy(desc(productPrices.createdAt))
        .limit(1)
    )[0]?.price as number;
  const saleOf = async (orderId: string) =>
    (await pool.query('select * from merchant_order_sales where order_id = $1', [orderId])).rows[0];
  const recompute = (customerId: string) =>
    db.transaction((tx) =>
      recomputeMerchantLevel(tx, { jobs: context().jobs, now: new Date() }, customerId),
    );
  // S23: one live level per tier; these tests use Silver and Gold (the repricing tests Diamond).
  const level = async (
    threshold: number,
    priceListId: string,
    tier: 'silver' | 'gold' = 'silver',
  ) => {
    const id = newId();
    await pool.query(
      `insert into merchant_levels (id, tier, name_ar, monthly_threshold_usd_units, price_list_id)
       values ($1, $2, $3, $4, $5)`,
      [id, tier, TIER_NAMES_AR[tier], threshold, priceListId],
    );
    return id;
  };
  const archiveLevels = () =>
    pool.query(
      `update merchant_levels set archived_at = now()
       where archived_at is null and tier in ('silver', 'gold')`,
    );
  const notifications = async (customerId: string, event: string) =>
    (
      await pool.query(
        `select params from customer_notifications where customer_id = $1 and event = $2
         order by created_at`,
        [customerId, event],
      )
    ).rows.map((row) => row.params);
  const credit = (customerId: string, amountUnits: number) =>
    db.transaction(async (tx) => {
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

  it("writes a merchant order's sale row in the purchase and the checkout (SP3, SP4)", async () => {
    const item = await product({ cost: usd(1) });
    const price = await wholesalePrice(item.id);
    const shop = await merchant(usd(20));
    await pool.query(
      'insert into merchant_selling_settings (customer_id, markup_bp) values ($1, 1000)',
      [shop],
    );
    const { order } = await buy(request(shop, { id: item.id, price }));
    expect(await saleOf(order.id)).toMatchObject({
      currency: 'usd',
      unit_amount_units: String(usd(1.16)),
      unit_usd_units: String(usd(1.16)),
      source: 'markup',
    });

    await pool.query(
      `insert into merchant_selling_prices (customer_id, product_id, currency, amount_units)
       values ($1, $2, 'usd', $3)`,
      [shop, item.id, usd(2)],
    );
    const input: CheckoutInput = {
      customerId: shop,
      idempotencyKey: newId(),
      requestHash: hash({ checkout: newId() }),
      fakeEnabled: true,
      purchasesStopped: false,
      channel: 'store',
      playerCheck: async () => null,
      lines: [
        {
          productId: item.id,
          quantity: 1,
          fields: { player_id: '5123456789' },
          expectedUnitPriceUsdUnits: price,
          confirmPlayer: false,
        },
      ],
    };
    const result = await db.transaction((tx) => checkoutOrders(tx, context(), input));
    expect(await saleOf(result.orders[0]?.id as string)).toMatchObject({
      unit_usd_units: String(usd(2)),
      source: 'product',
    });

    // A customer's order has none; a sale is never deleted and belongs to its order's customer.
    const buyer = await customer({ funds: usd(10) });
    const retailOrder = (await buy(request(buyer, item))).order;
    expect(await saleOf(retailOrder.id)).toBeUndefined();
    await expect(
      pool.query('delete from merchant_order_sales where order_id = $1', [order.id]),
    ).rejects.toThrow(/permission denied|never deleted/);
    await expect(
      pool.query(
        `insert into merchant_order_sales (order_id, customer_id, currency, unit_amount_units,
           unit_usd_units, source) values ($1, $2, 'usd', 10000, 10000, 'manual')`,
        [retailOrder.id, shop],
      ),
    ).rejects.toThrow(/not an order of its customer/);
  });

  it('counts delivered sales, profit and orders without a sale on the dashboard (DB2, DB4)', async () => {
    const item = await product({ cost: usd(1) });
    const price = await wholesalePrice(item.id);
    const shop = await merchant(usd(20));
    await pool.query(
      'insert into merchant_selling_settings (customer_id, markup_bp) values ($1, 2000)',
      [shop],
    );
    const sold = (await buy(request(shop, { id: item.id, price }))).order;
    await pool.query('delete from merchant_selling_settings where customer_id = $1', [shop]);
    const unpriced = (await buy(request(shop, { id: item.id, price }))).order;
    for (const order of [sold, unpriced]) {
      await apply(await send(order, item), {
        status: 'delivered',
        quantity: 1,
        supplierOrderId: `f-${newId()}`,
      });
    }
    const from = new Date(Date.now() - 60_000);
    const facts = await dashboardFacts(db, shop, from, new Date(Date.now() + 60_000), 5);
    const unit = markupPrice(price, 2000);
    expect(facts).toEqual({
      salesUsdUnits: unit,
      profitUsdUnits: unit - price,
      ordersWithoutSale: 1,
      topProducts: [expect.objectContaining({ productId: item.id, units: 2, salesUsdUnits: unit })],
    });
    expect(await netPurchases(db, shop, from, new Date(Date.now() + 60_000))).toBe(price * 2);
  });

  it('A06-36: leaves owner-funded orders and orders from before the grant off the dashboard', async () => {
    const item = await product({ cost: usd(1) });
    const price = await wholesalePrice(item.id);
    const shop = await merchant(usd(20));
    const early = (await buy(request(shop, { id: item.id, price }))).order;
    await pool.query('update merchant_profiles set granted_at = now() where customer_id = $1', [
      shop,
    ]);
    const counted = (await buy(request(shop, { id: item.id, price }))).order;
    const giftPrice = await listPriceOf(item.id, ROOT_PRICE_LIST_IDS.cost);
    const gift = (
      await db.transaction((tx) =>
        adminPurchaseOrder(tx, context(), {
          adminId: newId(),
          purpose: 'gift',
          customerId: shop,
          priceListId: null,
          productId: item.id,
          quantity: 1,
          fields: { player_id: '5123456789' },
          expectedUnitPriceUsdUnits: giftPrice,
          confirmPlayer: false,
          reason: 'A gift from the owner',
          customerNote: null,
          idempotencyKey: newId(),
          requestHash: hash({ gift: newId() }),
          fakeEnabled: true,
          purchasesStopped: false,
          playerCheck: async () => null,
        }),
      )
    ).order;
    expect(gift.payer).toBe('owner');
    for (const order of [early, counted, gift]) {
      await apply(await send(order, item), {
        status: 'delivered',
        quantity: 1,
        supplierOrderId: `f-${newId()}`,
      });
    }
    const facts = await dashboardFacts(
      db,
      shop,
      new Date(Date.now() - 60_000),
      new Date(Date.now() + 60_000),
      5,
    );
    expect(facts).toEqual({
      salesUsdUnits: 0,
      profitUsdUnits: 0,
      ordersWithoutSale: 1,
      topProducts: [expect.objectContaining({ productId: item.id, units: 1, salesUsdUnits: 0 })],
    });
  });

  it('A06-41: refuses a SYP sale price of an order without a rate, writing nothing', async () => {
    const item = await product({ cost: usd(1) });
    const shop = await merchant(usd(20));
    const { order } = await buy(
      request(shop, { id: item.id, price: await wholesalePrice(item.id) }),
    );
    const result = await db.transaction((tx) =>
      setOrderSale(
        tx,
        { id: order.id, customerId: shop, displayRateId: null },
        { currency: 'syp', amountUnits: 15_000_00 },
      ),
    );
    expect(result).toEqual({ ok: false, reason: 'no_rate' });
    expect(await saleOf(order.id)).toBeUndefined();
  });

  it('nets a refund against the month of the purchase it repays (Q26, audit A06-23)', async () => {
    const item = await product({ cost: usd(1) });
    const price = await wholesalePrice(item.id);
    const shop = await merchant(usd(20));
    const from = new Date(Date.now() - 60_000);
    const kept = (await buy(request(shop, { id: item.id, price }))).order;
    const failing = (await buy(request(shop, { id: item.id, price }))).order;
    // A month's end between the purchases and the refund: the refund posts in the next month.
    await new Promise((resolve) => setTimeout(resolve, 20));
    const midnight = new Date();
    await new Promise((resolve) => setTimeout(resolve, 20));
    const result = await apply(await send(failing, item), {
      status: 'failed',
      reason: 'Player not found',
      inputRejected: true,
      supplierErrorCode: 'PLAYER_NOT_FOUND',
    });
    expect(result.order.status).toBe('refunded');
    const end = new Date(Date.now() + 60_000);
    // The month that paid keeps only what stayed spent; the next month is not lowered by it.
    expect(await netPurchases(db, shop, from, midnight)).toBe(price);
    expect(await netPurchases(db, shop, midnight, end)).toBe(0);
    expect(kept.status).toBe('paid');
  });

  it("counts what a tier's list saved on the orders delivered this month (S23 PG6)", async () => {
    await archiveLevels();
    const item = await product({ cost: usd(1) });
    const shop = await merchant(usd(20));
    try {
      await level(usd(1), cost);
      const bronze = await wholesalePrice(item.id);
      await buy(request(shop, { id: item.id, price: bronze }));
      await recompute(shop);
      const month = damascusMonth(new Date());
      // Bought at wholesale and not delivered: nothing saved.
      expect(await tierSavings(db, shop, month)).toBe(0);
      const tierPrice = await listPriceOf(item.id, cost);
      expect(tierPrice).toBeLessThan(bronze);
      const { order } = await buy(request(shop, { id: item.id, price: tierPrice }));
      expect(await tierSavings(db, shop, month)).toBe(0);
      await apply(await send(order, item), { status: 'delivered', quantity: order.quantity });
      expect(await tierSavings(db, shop, month)).toBe(bronze - tierPrice);
      expect(await tierSavings(db, shop, previousMonth(month))).toBe(0);
    } finally {
      await archiveLevels();
    }
  });

  it('moves a merchant to the level their month reached, below an assigned list (LV3–LV5)', async () => {
    await archiveLevels();
    const item = await product({ cost: usd(1) });
    const shop = await merchant(usd(20));
    try {
      const silver = await level(usd(1), cost);
      expect(await recompute(shop)).toEqual({ changed: false });

      const before = sent.length;
      const { order } = await buy(
        request(shop, { id: item.id, price: await wholesalePrice(item.id) }),
      );
      expect(sent.slice(before).some((job) => job.queue === 'merchants.level')).toBe(true);
      expect(await recompute(shop)).toEqual({
        changed: true,
        levelIdBefore: null,
        levelIdAfter: silver,
        tierBefore: 'bronze',
        tierAfter: 'silver',
        listChanged: true,
        cancelledOrderIds: [],
      });
      expect(await recompute(shop)).toEqual({ changed: false });
      // S23 PX6: a tier list reads as wholesale, with the tier.
      expect(await notifications(shop, 'merchant_level_changed')).toEqual([
        {
          levelNameAr: 'فضي',
          priceKind: 'wholesale',
          direction: 'up',
          tier: 'silver',
          privileges: expect.objectContaining({ receiptWelcome: true, bulkLinesMax: 50 }),
        },
      ]);
      const { rows: audits } = await pool.query(
        `select actor_kind, details from audit_entries
         where entity_id = $1 and action = 'merchant.level_changed'`,
        [shop],
      );
      expect(audits).toEqual([
        {
          actor_kind: 'system',
          details: expect.objectContaining({
            levelIdAfter: silver,
            thisMonthUsdUnits: order.totalUsdUnits,
            listChanged: true,
          }),
        },
      ]);
      expect((await accountPriceList(db, shop))?.effectiveList.id).toBe(cost);
      expect((await db.transaction((tx) => lockActiveCustomer(tx, shop))).priceListId).toBe(cost);

      // An assigned list wins, the level stays (LV5, edge case 1).
      await db.update(customers).set({ priceListId: retail }).where(eq(customers.id, shop));
      expect((await accountPriceList(db, shop))?.effectiveList.id).toBe(retail);
      expect((await merchantProfileOf(db, shop))?.level?.id).toBe(silver);
      await db.update(customers).set({ priceListId: null }).where(eq(customers.id, shop));

      // An archived level leaves the merchant on wholesale (edge case 4).
      await pool.query('update merchant_levels set archived_at = now() where id = $1', [silver]);
      expect((await accountPriceList(db, shop))?.effectiveList.id).toBe(wholesale);
      expect(await recompute(shop)).toMatchObject({ changed: true, levelIdAfter: null });
      expect((await notifications(shop, 'merchant_level_changed')).at(-1)).toMatchObject({
        levelNameAr: null,
        direction: 'down',
      });
      await expect(
        pool.query('delete from merchant_levels where id = $1', [silver]),
      ).rejects.toThrow(/permission denied/);
    } finally {
      await archiveLevels();
    }
  });

  describe('tiers (S23 TR3–TR9, MG1–MG7, PG5)', () => {
    const actor = { adminId: newId(), ipAddress: null, userAgent: null };
    const DAY = 86_400_000;
    const grant = (shop: string, tier: 'silver' | 'gold' | 'diamond', days = 2, now = new Date()) =>
      db.transaction((tx) =>
        grantTier(tx, { jobs: context().jobs, now }, shop, {
          tier,
          endsAt: new Date(now.getTime() + days * DAY),
          reason: 'شريك جديد في المدينة',
          actor,
        }),
      );
    const profile = async (shop: string) =>
      (
        await pool.query(
          `select level_id, earned_level_id, level_source from merchant_profiles
           where customer_id = $1`,
          [shop],
        )
      ).rows[0];
    const celebration = async (shop: string) =>
      (
        await pool.query('select celebrate_pending from merchant_profiles where customer_id = $1', [
          shop,
        ])
      ).rows[0]?.celebrate_pending;
    const changes = async (shop: string) =>
      (
        await pool.query(
          `select from_tier, to_tier, source from merchant_tier_changes
           where customer_id = $1 order by created_at, id`,
          [shop],
        )
      ).rows;
    const telegram = async (shop: string, kind: string) =>
      (
        await pool.query(
          `select params, dedupe_key from telegram_messages
           where kind = $1 and params->>'customerId' = $2 order by id`,
          [kind, shop],
        )
      ).rows;

    it('grants a tier above the earned one, ends it early and lets the earned tier win (MG1–MG3, MG6, TR8)', async () => {
      await archiveLevels();
      const item = await product({ cost: usd(1) });
      const shop = await merchant(usd(20));
      try {
        const silver = await level(usd(1), cost, 'silver');
        const gold = await level(usd(1_000_000), retail, 'gold');
        await expect(grant(shop, 'diamond')).rejects.toMatchObject({
          code: 'MERCHANT_TIER_UNAVAILABLE',
        });
        const customerOnly = await customer({ funds: 0 });
        await expect(grant(customerOnly, 'gold')).rejects.toMatchObject({ code: 'NOT_MERCHANT' });

        const granted = await grant(shop, 'gold');
        expect(await profile(shop)).toEqual({
          level_id: gold,
          earned_level_id: null,
          level_source: 'granted',
        });
        // ID4: the rise makes the celebration due; the notice says what Gold grants.
        expect(await celebration(shop)).toBe(true);
        expect((await notifications(shop, 'merchant_level_changed')).at(-1)).toMatchObject({
          tier: 'gold',
          direction: 'up',
          privileges: { bulkLinesMax: 100, receiptLargeLogo: true },
        });
        expect((await accountPriceList(db, shop))?.effectiveList.id).toBe(retail);
        await expect(grant(shop, 'gold')).rejects.toMatchObject({
          code: 'MERCHANT_TIER_GRANT_OPEN',
          details: { grantId: granted.id },
        });
        // The merchant earns Silver meanwhile: the grant still wins (MG6).
        await buy(request(shop, { id: item.id, price: await listPriceOf(item.id, retail) }));
        await recompute(shop);
        expect(await profile(shop)).toEqual({
          level_id: gold,
          earned_level_id: silver,
          level_source: 'granted',
        });

        // MG3: ended early, back to the earned tier with a notification and a Telegram alert.
        const ended = await db.transaction((tx) =>
          endTierGrant(tx, { jobs: context().jobs, now: new Date() }, shop, 'ended_by_admin', {
            kind: 'admin',
            actor,
            reason: 'انتهت الشراكة',
          }),
        );
        expect(ended).toMatchObject({ id: granted.id, endReason: 'ended_by_admin' });
        expect(await profile(shop)).toEqual({
          level_id: silver,
          earned_level_id: silver,
          level_source: 'earned',
        });
        expect(await changes(shop)).toEqual([
          { from_tier: 'bronze', to_tier: 'gold', source: 'granted' },
          { from_tier: 'gold', to_tier: 'silver', source: 'grant_ended' },
        ]);
        const alerts = await telegram(shop, 'merchant_tier_changed');
        expect(alerts.map((row) => [row.params.from, row.params.to, row.params.source])).toEqual([
          ['bronze', 'gold', 'granted'],
          ['gold', 'silver', 'grant_ended'],
        ]);
        expect(alerts[0]?.dedupe_key).toMatch(new RegExp(`^tier-change:${shop}:`));
        expect((await notifications(shop, 'merchant_level_changed')).at(-1)).toMatchObject({
          tier: 'silver',
          direction: 'down',
        });
        // A fall clears a celebration the merchant never saw.
        expect(await celebration(shop)).toBe(false);
        // Not above the earned Silver now (MG1).
        await expect(grant(shop, 'silver')).rejects.toMatchObject({
          code: 'MERCHANT_TIER_GRANT_NOT_HIGHER',
          details: { earnedTier: 'silver' },
        });
        // A grant is closed once, never deleted, and only its end changes.
        await expect(
          pool.query(`update merchant_tier_grants set ended_at = now() where id = $1`, [
            granted.id,
          ]),
        ).rejects.toThrow(/ended already/);
        await expect(
          pool.query(`update merchant_tier_grants set reason = 'سبب آخر هنا' where id = $1`, [
            granted.id,
          ]),
        ).rejects.toThrow(/only its end changes/);
        await expect(
          pool.query('delete from merchant_tier_grants where id = $1', [granted.id]),
        ).rejects.toThrow(/permission denied/);
      } finally {
        await archiveLevels();
      }
    });

    it('gives every profile its own certificate code (ID7)', async () => {
      const [one, two] = [await merchant(usd(1)), await merchant(usd(1))];
      const { rows } = await pool.query(
        `select certificate_code, celebrate_pending, certificate_reissued_at from merchant_profiles
         where customer_id = any($1) order by customer_id`,
        [[one, two]],
      );
      expect(rows).toHaveLength(2);
      for (const row of rows) {
        expect(row.certificate_code).toMatch(/^[A-Za-z0-9_-]{22}$/);
        expect(row).toMatchObject({ celebrate_pending: false, certificate_reissued_at: null });
      }
      expect(rows[0].certificate_code).not.toBe(rows[1].certificate_code);
      await expect(
        pool.query('update merchant_profiles set certificate_code = $1 where customer_id = $2', [
          rows[0].certificate_code,
          two,
        ]),
      ).rejects.toThrow(/merchant_profiles_certificate_code_unique/);
    });

    it('reminds once, then expires a grant at its end, idempotently (MG4, MG5)', async () => {
      await archiveLevels();
      const shop = await merchant(usd(20));
      try {
        await level(usd(1_000_000), cost, 'silver');
        await level(usd(2_000_000), retail, 'gold');
        const now = new Date();
        const granted = await grant(shop, 'gold', 1, now);
        const remind = (at: Date) =>
          db.transaction((tx) => remindEndingTierGrants(tx, { jobs: context().jobs, now: at }));
        expect(await remind(now)).toBeGreaterThanOrEqual(1);
        expect(await telegram(shop, 'merchant_tier_grant_ending')).toEqual([
          {
            params: expect.objectContaining({ tier: 'gold', earnedTier: 'bronze' }),
            dedupe_key: `grant-ending:${granted.id}`,
          },
        ]);
        await remind(now);
        expect(await telegram(shop, 'merchant_tier_grant_ending')).toHaveLength(1);

        const expire = (at: Date) =>
          db.transaction((tx) => expireTierGrant(tx, { jobs: context().jobs, now: at }, granted));
        expect(await expire(now)).toBe(false);
        const later = new Date(now.getTime() + 2 * DAY);
        const [first, second] = await Promise.all([expire(later), expire(later)]);
        expect([first, second].sort()).toEqual([false, true]);
        expect(await profile(shop)).toEqual({
          level_id: null,
          earned_level_id: null,
          level_source: null,
        });
        expect((await changes(shop)).at(-1)).toEqual({
          from_tier: 'gold',
          to_tier: 'bronze',
          source: 'grant_ended',
        });
        const { rows } = await pool.query(
          `select action, actor_kind, details->>'endReason' as end_reason from audit_entries
           where entity_id = $1 and action like 'merchant.tier_%' order by occurred_at, id`,
          [shop],
        );
        expect(rows).toEqual([
          { action: 'merchant.tier_granted', actor_kind: 'admin', end_reason: null },
          { action: 'merchant.tier_grant_ended', actor_kind: 'system', end_reason: 'expired' },
        ]);
      } finally {
        await archiveLevels();
      }
    });

    it('ends the grant and leaves the tier on a revocation, without a tier notice (TR9)', async () => {
      await archiveLevels();
      const shop = await merchant(usd(20));
      try {
        await level(usd(1_000_000), cost, 'silver');
        await grant(shop, 'silver');
        const notices = (await notifications(shop, 'merchant_level_changed')).length;
        await db.transaction(async (tx) =>
          revokeMerchant(tx, context(), await lockCustomer(tx, shop), {
            reason: 'مخالفة الشروط',
            actor,
          }),
        );
        expect(await profile(shop)).toEqual({
          level_id: null,
          earned_level_id: null,
          level_source: null,
        });
        expect((await changes(shop)).at(-1)).toEqual({
          from_tier: 'silver',
          to_tier: 'bronze',
          source: 'revoked',
        });
        const { rows } = await pool.query(
          `select end_reason from merchant_tier_grants where customer_id = $1`,
          [shop],
        );
        expect(rows).toEqual([{ end_reason: 'merchant_revoked' }]);
        expect(await notifications(shop, 'merchant_level_changed')).toHaveLength(notices);
        expect(await recompute(shop)).toEqual({ changed: false });
      } finally {
        await archiveLevels();
      }
    });

    it("writes a merchant's month once, with the tiers earned and held (PG5)", async () => {
      await archiveLevels();
      const item = await product({ cost: usd(1) });
      const shop = await merchant(usd(20));
      try {
        await level(usd(1), cost, 'silver');
        await buy(request(shop, { id: item.id, price: await wholesalePrice(item.id) }));
        await recompute(shop);
        const month = damascusMonth(new Date());
        expect(await db.transaction((tx) => recordTierMonth(tx, shop, month))).toBe(true);
        expect(await db.transaction((tx) => recordTierMonth(tx, shop, month))).toBe(false);
        const { rows } = await pool.query(
          `select month::text, earned_tier, held_tier, held_source from merchant_tier_months
           where customer_id = $1`,
          [shop],
        );
        expect(rows).toEqual([
          {
            month: `${month}-01`,
            earned_tier: 'silver',
            held_tier: 'silver',
            held_source: 'earned',
          },
        ]);
        await expect(
          pool.query('update merchant_tier_months set held_tier = $2 where customer_id = $1', [
            shop,
            'gold',
          ]),
        ).rejects.toThrow(/permission denied/);
      } finally {
        await archiveLevels();
      }
    });

    it("reads a merchant's tier quantities under the purchase lock (TS5)", async () => {
      await archiveLevels();
      const shop = await merchant(usd(20));
      try {
        const quantities = async () =>
          (await db.transaction((tx) => lockActiveCustomer(tx, shop))).tierQuantities;
        expect(await quantities()).toEqual({ orderUnitsMax: 50, bulkLinesMax: 50 });
        await level(usd(1_000_000), cost, 'silver');
        await level(usd(2_000_000), retail, 'gold');
        await grant(shop, 'gold');
        expect(await quantities()).toEqual({ orderUnitsMax: 100, bulkLinesMax: 100 });
        const buyer = await customer({ funds: 0 });
        expect((await db.transaction((tx) => lockActiveCustomer(tx, buyer))).tierQuantities).toBe(
          null,
        );
      } finally {
        await archiveLevels();
      }
    });
  });

  it('serializes a level change and a purchase on the customer (LV4, AT3)', async () => {
    await archiveLevels();
    const item = await product({ cost: usd(1) });
    const shop = await merchant(usd(20));
    try {
      const price = await wholesalePrice(item.id);
      await buy(request(shop, { id: item.id, price }));
      await level(usd(1), cost);
      let release = () => {};
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      const change = db.transaction(async (tx) => {
        await recomputeMerchantLevel(tx, { jobs: context().jobs, now: new Date() }, shop);
        await gate;
      });
      await new Promise((resolve) => setTimeout(resolve, 200));
      const purchase = refusal(buy(request(shop, { id: item.id, price })));
      await new Promise((resolve) => setTimeout(resolve, 200));
      release();
      await change;
      // The purchase waited for the change, then met the level's list.
      expect(await purchase).toMatchObject({ code: 'PRICE_CHANGED' });
    } finally {
      await archiveLevels();
    }
  });

  it('cancels reservations off the list when a level is archived or its list changes (LV6, AT3)', async () => {
    await archiveLevels();
    const item = await product({ cost: usd(1) });
    const shop = await merchant(usd(20));
    try {
      await buy(request(shop, { id: item.id, price: await wholesalePrice(item.id) }));
      const silver = await level(usd(1), cost);
      expect(await recompute(shop)).toMatchObject({ changed: true, levelIdAfter: silver });
      const reserve = async () => {
        const listed = (
          await db
            .select({ price: productPrices.priceUsdUnits })
            .from(productPrices)
            .where(and(eq(productPrices.productId, item.id), eq(productPrices.priceListId, cost)))
            .orderBy(desc(productPrices.createdAt))
            .limit(1)
        )[0]?.price as number;
        return (
          await buy(
            request(
              shop,
              { id: item.id, price: listed },
              { whenBalanceShort: 'reserve', quantity: 1 },
            ),
          )
        ).order;
      };
      // A reservation the balance cannot pay yet, on the level's list.
      await pool.query(`update merchant_profiles set level_id = $2 where customer_id = $1`, [
        shop,
        silver,
      ]);
      const drain = await balance(shop);
      await credit(shop, -drain);
      const held = await reserve();
      expect(held).toMatchObject({ status: 'awaiting_balance', priceListId: cost });

      // The level's list changes: the level is the same, the reservation is cancelled.
      await pool.query('update merchant_levels set price_list_id = $2 where id = $1', [
        silver,
        wholesale,
      ]);
      expect(await recompute(shop)).toEqual({ changed: false });
      expect((await orderRow(held.id)).status).toBe('cancelled');

      // Archived with a reservation on its list: cancelled, and told as a move down.
      await pool.query('update merchant_levels set price_list_id = $2 where id = $1', [
        silver,
        cost,
      ]);
      const again = await reserve();
      await pool.query('update merchant_levels set archived_at = now() where id = $1', [silver]);
      expect(await recompute(shop)).toMatchObject({
        changed: true,
        levelIdAfter: null,
        listChanged: true,
        cancelledOrderIds: [again.id],
      });
      expect((await notifications(shop, 'merchant_level_changed')).at(-1)).toMatchObject({
        direction: 'down',
      });
    } finally {
      await archiveLevels();
    }
  });

  it('clears the level on a revocation (LV7)', async () => {
    await archiveLevels();
    const shop = await merchant(usd(20));
    try {
      const silver = await level(usd(1), cost);
      await pool.query('update merchant_profiles set level_id = $2 where customer_id = $1', [
        shop,
        silver,
      ]);
      await db.transaction(async (tx) =>
        revokeMerchant(tx, context(), await lockCustomer(tx, shop), {
          reason: 'لم يعد تاجراً',
          actor: { adminId: newId(), ipAddress: null, userAgent: null },
        }),
      );
      expect((await merchantProfileOf(db, shop))?.level).toBeNull();
      expect(await recompute(shop)).toEqual({ changed: false });
    } finally {
      await archiveLevels();
    }
  });

  it('sends the low-balance alert once until the balance is back (AL5, AL6)', async () => {
    const item = await product({ cost: usd(1) });
    const price = await wholesalePrice(item.id);
    const shop = await merchant(usd(3));
    await pool.query(
      'insert into merchant_alert_settings (customer_id, low_balance_usd_units) values ($1, $2)',
      [shop, usd(2)],
    );
    await buy(request(shop, { id: item.id, price }));
    await buy(request(shop, { id: item.id, price }));
    expect(await notifications(shop, 'merchant_low_balance')).toEqual([
      { balanceUsdUnits: usd(3) - price, thresholdUsdUnits: usd(2) },
    ]);
    // A credit that takes the balance back above the threshold re-arms it.
    await credit(shop, usd(1.5));
    await buy(request(shop, { id: item.id, price }));
    expect(await notifications(shop, 'merchant_low_balance')).toHaveLength(2);

    // A credit whose transaction began before the next alert, posted after it, re-arms it too
    // (the running balance follows the posting position, never the journal's start time).
    await credit(shop, usd(1.7));
    let release = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const late = db.transaction(async (tx) => {
      await tx.execute(sql`select 1`);
      await gate;
      await postJournal(tx, {
        idempotencyKey: `test:${newId()}`,
        kind: 'adjustment',
        postings: [
          { accountId: await ensureCustomerWallet(tx, shop), amountUnits: usd(3) },
          {
            accountId: await ensureSystemAccount(tx, {
              code: 'adjustments:test_funds',
              kind: 'adjustments',
              currency: 'USD',
            }),
            amountUnits: -usd(3),
          },
        ],
      });
    });
    await buy(request(shop, { id: item.id, price }));
    await buy(request(shop, { id: item.id, price }));
    expect(await notifications(shop, 'merchant_low_balance')).toHaveLength(3);
    release();
    await late;
    await buy(request(shop, { id: item.id, price }));
    await buy(request(shop, { id: item.id, price }));
    expect(await notifications(shop, 'merchant_low_balance')).toHaveLength(4);
  });

  it('tells a follower of a change once (AL2, AL3)', async () => {
    const item = await product({ cost: usd(1) });
    const shop = await merchant(usd(1));
    await pool.query(
      'insert into merchant_watches (id, customer_id, game_id) values ($1, $2, $3)',
      [newId(), shop, item.game],
    );
    const compare = () =>
      db.transaction((tx) =>
        compareMerchantWatches(
          tx,
          { jobs: context().jobs, now: new Date(), fakeEnabled: true },
          shop,
        ),
      );
    expect(await compare()).toEqual({ events: 0 });
    await pool.query('update supplier_offers set in_stock = false where id = $1', [item.offer]);
    await db.transaction((tx) =>
      repriceProducts(tx, {
        productIds: [item.id],
        cause: 'cost_sync',
        context: { now: new Date(), fakeEnabled: true },
      }),
    );
    expect(await compare()).toEqual({ events: 1 });
    expect(await compare()).toEqual({ events: 0 });
    const digests = await notifications(shop, 'merchant_watch_digest');
    expect(digests).toEqual([
      expect.objectContaining({
        outOfStock: 1,
        lines: [expect.objectContaining({ kind: 'out_of_stock' })],
      }),
    ]);

    // Events are never changed and kept 90 days.
    const { rows } = await pool.query(
      'select id from merchant_alert_events where customer_id = $1',
      [shop],
    );
    await expect(
      pool.query("update merchant_alert_events set kind = 'price_up' where id = $1", [rows[0]?.id]),
    ).rejects.toThrow(/permission denied|never changed/);
    await expect(
      pool.query('delete from merchant_alert_events where id = $1', [rows[0]?.id]),
    ).rejects.toThrow(/kept 90 days/);
  });

  it('A06-37: sends at most one watch digest an hour, still writing the events', async () => {
    const item = await product({ cost: usd(1) });
    const shop = await merchant(usd(1));
    await pool.query(
      'insert into merchant_watches (id, customer_id, game_id) values ($1, $2, $3)',
      [newId(), shop, item.game],
    );
    const compare = () =>
      db.transaction((tx) =>
        compareMerchantWatches(
          tx,
          { jobs: context().jobs, now: new Date(), fakeEnabled: true },
          shop,
        ),
      );
    const stock = async (inStock: boolean) => {
      await pool.query('update supplier_offers set in_stock = $2 where id = $1', [
        item.offer,
        inStock,
      ]);
      await db.transaction((tx) =>
        repriceProducts(tx, {
          productIds: [item.id],
          cause: 'cost_sync',
          context: { now: new Date(), fakeEnabled: true },
        }),
      );
    };
    expect(await compare()).toEqual({ events: 0 });
    await stock(false);
    expect(await compare()).toEqual({ events: 1 });
    // A manual run in the same hour: the change is recorded, no second digest is sent.
    await stock(true);
    expect(await compare()).toEqual({ events: 1 });
    expect(await notifications(shop, 'merchant_watch_digest')).toEqual([
      expect.objectContaining({ outOfStock: 1, backInStock: 0 }),
    ]);
    const { rows } = await pool.query(
      'select kind from merchant_alert_events where customer_id = $1 order by created_at',
      [shop],
    );
    expect(rows.map((row) => row.kind)).toEqual(['out_of_stock', 'back_in_stock']);
  });

  it('lets a merchant buy 50 codes and 50 checkout lines; customers keep their limits (QT1, BK3)', async () => {
    const codes = await product({ kind: 'code', cost: usd(1) });
    const price = await wholesalePrice(codes.id);
    const shop = await merchant(usd(500));
    const buyer = await customer({ funds: usd(500) });
    // The pack's own limit is 10: a customer stays under it, a merchant takes up to 50.
    expect(await refusal(buy(request(buyer, codes, { quantity: 11, fields: {} })))).toMatchObject({
      code: 'VALIDATION_FAILED',
    });
    const { order } = await buy(
      request(shop, { id: codes.id, price }, { quantity: 30, fields: {} }),
    );
    expect(order.quantity).toBe(30);
    expect(
      await refusal(buy(request(shop, { id: codes.id, price }, { quantity: 51, fields: {} }))),
    ).toMatchObject({ code: 'VALIDATION_FAILED' });

    const direct = await product({ cost: usd(1) });
    const line = (unit: number) => ({
      productId: direct.id,
      quantity: 1,
      fields: { player_id: '5123456789' },
      expectedUnitPriceUsdUnits: unit,
      confirmPlayer: false,
    });
    const checkout = (customerId: string, count: number, unit: number) =>
      db.transaction((tx) =>
        checkoutOrders(tx, context(), {
          customerId,
          idempotencyKey: newId(),
          requestHash: hash({ checkout: newId() }),
          fakeEnabled: true,
          purchasesStopped: false,
          channel: 'store',
          playerCheck: async () => null,
          source: 'bulk',
          lines: Array.from({ length: count }, () => line(unit)),
        }),
      );
    expect(await refusal(checkout(buyer, 11, direct.price))).toMatchObject({
      code: 'VALIDATION_FAILED',
      details: { lines: { max: 10 } },
    });
    const bulk = await checkout(shop, 12, await wholesalePrice(direct.id));
    expect(bulk.orders).toHaveLength(12);
    expect(bulk.checkout.source).toBe('bulk');
    expect(bulk.checkout.lineCount).toBe(12);
  });

  it('releases delivered codes with one log row per code, and shows the log (CR1, CR4)', async () => {
    const item = await product({ kind: 'code', cost: usd(1) });
    const shop = await merchant(usd(100));
    const { order } = await buy(
      request(
        shop,
        { id: item.id, price: await wholesalePrice(item.id) },
        { quantity: 3, fields: {} },
      ),
    );
    const release = (input: Partial<ReleaseInput> = {}) =>
      db.transaction((tx) =>
        releaseCodes(tx, codesKey, {
          orderId: order.id,
          customerId: shop,
          purpose: 'print',
          ipAddress: '203.0.113.9',
          userAgent: 'Printer',
          ...input,
        }),
      );
    expect(await refusal(release())).toMatchObject({ code: 'CODES_NOT_DELIVERED' });
    const attemptId = await send(order, item);
    await apply(attemptId, {
      status: 'delivered',
      quantity: 3,
      codes: ['AAAA-1', 'BBBB-2', 'CCCC-3'],
    });

    expect(await release({ customerId: await customer() })).toBeNull();
    const all = await release();
    expect(all?.codes.map((code) => [code.position, code.code])).toEqual([
      [1, 'AAAA-1'],
      [2, 'BBBB-2'],
      [3, 'CCCC-3'],
    ]);
    const second = all?.codes[1]?.id as string;
    expect((await release({ purpose: 'copy', codeIds: [second] }))?.codes).toHaveLength(1);
    expect(await refusal(release({ codeIds: [second, newId()] }))).toMatchObject({
      code: 'CODES_NOT_DELIVERED',
    });
    const view = await customerOrder(db, shop, order.id);
    expect(view?.codeReleases.map((entry) => [entry.purpose, entry.positions])).toEqual([
      ['copy', [2]],
      ['print', [1, 2, 3]],
    ]);
    const admin = await adminOrder(db, order.id);
    expect(admin?.codes[0]?.reveals).toEqual([
      expect.objectContaining({ purpose: 'print', ipAddress: '203.0.113.9' }),
    ]);
  });

  it('gives every order a fixed verification code, and shows no price or identity (VF1–VF3)', async () => {
    const item = await product({ cost: usd(1) });
    const shop = await merchant(usd(50));
    await pool.query(
      'insert into merchant_selling_prices (customer_id, product_id, currency, amount_units) values ($1, $2, $3, $4)',
      [shop, item.id, 'syp', 15_000_00],
    );
    const { order } = await buy(
      request(shop, { id: item.id, price: await wholesalePrice(item.id) }),
    );
    expect(order.verificationCode).toMatch(/^[A-Za-z0-9_-]{22}$/);
    const buyer = await customer({ funds: usd(10) });
    const retailOrder = (await buy(request(buyer, item))).order;
    expect(retailOrder.verificationCode).not.toBe(order.verificationCode);
    await expect(
      pool.query("update orders set verification_code = 'x' where id = $1", [order.id]),
    ).rejects.toThrow(/fixed/);

    const page = await publicVerification(db, order.verificationCode);
    expect(page).toMatchObject({
      issuer: { kind: 'merchant', tradeName: 'محل النور', tier: 'bronze' },
      orderNumber: order.number,
      stage: 'processing',
      deliveredAt: null,
      fields: [{ value: '••••6789' }],
    });
    expect(JSON.stringify(page)).not.toMatch(/5123456789|Units|email/);
    expect((await publicVerification(db, retailOrder.verificationCode))?.issuer).toEqual({
      kind: 'store',
    });
    expect(await publicVerification(db, 'A'.repeat(22))).toBeNull();

    // The printed receipt: the shop's selling price, never the price paid (BR1); the retail price
    // on a customer's order; nothing for another customer.
    expect((await orderPrint(db, shop, order.id))?.price).toEqual({
      kind: 'selling',
      currency: 'syp',
      unitAmountUnits: 15_000_00,
      totalAmountUnits: 15_000_00,
    });
    expect((await orderPrint(db, buyer, retailOrder.id))?.price).toMatchObject({
      kind: 'retail',
      unitAmountUnits: item.price,
    });
    expect(await orderPrint(db, buyer, order.id)).toBeNull();

    // S23 RC1, RC2: Bronze keeps a welcome line but prints it only from a tier that grants it.
    await pool.query(
      `insert into merchant_receipt_settings (customer_id, welcome_text) values ($1, 'أهلاً بكم')`,
      [shop],
    );
    expect(await orderPrint(db, shop, order.id)).toMatchObject({
      welcomeText: null,
      largeLogo: false,
    });
    // ID5: a merchant revoked since shows the shop without a tier line.
    await pool.query('update merchant_profiles set revoked_at = now() where customer_id = $1', [
      shop,
    ]);
    expect((await publicVerification(db, order.verificationCode))?.issuer).toEqual({
      kind: 'merchant',
      tradeName: 'محل النور',
      tier: null,
    });
  });

  it('lists the 20 newest distinct ids of a game with their checked name (PS2)', async () => {
    const item = await product({ cost: usd(1) });
    const price = await wholesalePrice(item.id);
    const shop = await merchant(usd(50));
    await buy(request(shop, { id: item.id, price }, { fields: { player_id: '5100000001' } }));
    await buy(
      request(
        shop,
        { id: item.id, price },
        {
          fields: { player_id: '5100000002' },
          playerCheck: async () => ({ result: 'valid', playerName: 'Nour', region: null }),
        },
      ),
    );
    await buy(request(shop, { id: item.id, price }, { fields: { player_id: '5100000001' } }));
    const recent = await recentPlayers(db, shop, item.game);
    expect(recent.map((row) => [row.fields.player_id, row.playerName])).toEqual([
      ['5100000001', null],
      ['5100000002', 'Nour'],
    ]);
    expect(await recentPlayers(db, await customer(), item.game)).toEqual([]);
  });

  it("reads a month's statement in write order, its balance equation and one email (ST2, ST4)", async () => {
    const item = await product({ cost: usd(1) });
    const price = await wholesalePrice(item.id);
    const shop = await merchant(usd(10));
    const month = damascusMonth(new Date());
    const { order: single } = await buy(
      request(shop, { id: item.id, price }, { fields: { player_id: '5100000009' } }),
    );
    await credit(shop, usd(2));
    const line = (playerId: string) => ({
      productId: item.id,
      quantity: 1,
      fields: { player_id: playerId },
      expectedUnitPriceUsdUnits: price,
      confirmPlayer: false,
    });
    const paid = await db.transaction((tx) =>
      checkoutOrders(tx, context(), {
        customerId: shop,
        idempotencyKey: newId(),
        requestHash: hash({ checkout: newId() }),
        fakeEnabled: true,
        purchasesStopped: false,
        channel: 'store',
        playerCheck: async () => null,
        source: 'bulk',
        lines: [line('5100000011'), line('5100000012')],
      }),
    );
    await db.transaction(async (tx: Transaction) =>
      refundRemaining(tx, context(), (await lockOrder(tx, single.id)) as OrderRow, 'no_route', {
        actor: 'system',
        actorId: null,
      }),
    );
    const facts = await statementFacts(db, shop, month);
    expect(facts.entries.map((entry) => entry.kind)).toEqual([
      'adjustment',
      'purchase',
      'adjustment',
      'purchase',
      'refund',
    ]);
    expect(facts.openingUsdUnits).toBe(0);
    expect(facts.closingUsdUnits).toBe(usd(12) - 2 * price);
    expect(facts.closingUsdUnits).toBe(await balance(shop));
    // A checkout's orders in line order, each with its full player ID; the refund names its order.
    expect(facts.entries[3]?.checkout).toMatchObject({
      id: paid.checkout.id,
      orders: [
        { id: paid.orders[0]?.id, fields: [{ value: '5100000011' }] },
        { id: paid.orders[1]?.id, fields: [{ value: '5100000012' }] },
      ],
    });
    expect(facts.entries[4]?.order).toMatchObject({ id: single.id, number: single.number });
    expect(statementBalances(facts.openingUsdUnits, facts.entries, facts.closingUsdUnits)).toBe(
      true,
    );
    expect(facts.entries.at(-1)?.balanceAfterUnits).toBe(facts.closingUsdUnits);
    // The merchant's own statement shows the full player ID (ST2).
    expect(facts.entries[1]?.order).toMatchObject({
      quantity: 1,
      fields: [{ value: '5100000009' }],
    });
    // A month before any entry opens and closes at zero.
    expect(await statementFacts(db, shop, previousMonth(month))).toEqual({
      openingUsdUnits: 0,
      closingUsdUnits: 0,
      entries: [],
    });
    expect(await statementFacts(db, await customer(), month)).toMatchObject({ entries: [] });
    // A later month opens and closes at the balance, with no entries (edge case 19).
    const later = damascusMonth(new Date(Date.now() + 40 * 24 * 60 * 60 * 1000));
    expect(await statementFacts(db, shop, later)).toEqual({
      openingUsdUnits: facts.closingUsdUnits,
      closingUsdUnits: facts.closingUsdUnits,
      entries: [],
    });

    expect(await statementEmailMerchants(db, month)).toContain(shop);
    expect(await statementEmailMerchants(db, previousMonth(month))).not.toContain(shop);
    const send = () => db.transaction((tx) => sendStatementReady(tx, context().jobs, shop, month));
    expect(await Promise.all([send(), send()])).toEqual(expect.arrayContaining([true, false]));
    expect(await send()).toBe(false);
    expect(await notifications(shop, 'merchant_statement_ready')).toEqual([{ month }]);
  });
});

describe('quick buy (S22 DL1–DL5, QB2, BG1)', () => {
  const codeOf = async (productId: string) =>
    (
      await pool.query<{ quick_code: string }>(
        'select quick_code from catalog_products where id = $1',
        [productId],
      )
    ).rows[0]?.quick_code as string;
  const events = async (productId: string) =>
    (
      await pool.query<{ kind: string; campaign: string | null; order_id: string | null }>(
        'select kind, campaign, order_id from quick_link_events where product_id = $1 order by created_at',
        [productId],
      )
    ).rows;

  it('gives every product a unique code of the alphabet that never changes', async () => {
    const [a, b] = await Promise.all([product(), product()]);
    const [codeA, codeB] = await Promise.all([codeOf(a.id), codeOf(b.id)]);
    expect(codeA).toMatch(/^[2-9A-HJKMNP-Z]{6}$/);
    expect(codeA).not.toBe(codeB);
    const { rows } = await pool.query<{ duplicates: number; invalid: number }>(
      `select (count(*) - count(distinct quick_code))::int as duplicates,
         count(*) filter (where quick_code !~ '^[2-9A-HJKMNP-Z]{6}$')::int as invalid
       from catalog_products`,
    );
    expect(rows[0]).toEqual({ duplicates: 0, invalid: 0 });
    for (const client of [pool, owner.pool]) {
      await expect(
        client.query('update catalog_products set quick_code = $2 where id = $1', [a.id, codeB]),
      ).rejects.toMatchObject({ code: '23001' });
    }
    await pool.query("update catalog_products set name_ar = name_ar || '٢' where id = $1", [a.id]);
  });

  it('resolves a code to its pack, its game or the home page', async () => {
    const item = await product();
    const code = await codeOf(item.id);
    const { rows } = await pool.query<{ slug: string }>(
      'select slug from catalog_games where id = $1',
      [item.game],
    );
    const slug = rows[0]?.slug;
    expect(await resolveQuickCode(db, code)).toEqual({
      resolve: { target: 'pack', gameSlug: slug, productId: item.id },
      productId: item.id,
    });
    await pool.query("update catalog_products set status = 'paused' where id = $1", [item.id]);
    expect(await resolveQuickCode(db, code)).toEqual({
      resolve: { target: 'game', gameSlug: slug },
      productId: null,
    });
    await pool.query("update catalog_games set status = 'paused' where id = $1", [item.game]);
    expect(await resolveQuickCode(db, code)).toEqual({
      resolve: { target: 'home' },
      productId: null,
    });
    expect(await resolveQuickCode(db, 'unknown')).toBeNull();
  });

  it('counts one open per address, code and hour', async () => {
    const item = await product();
    const code = await codeOf(item.id);
    const address = `10.${unique()}`;
    const open = (from: string, campaign: string | null = null) =>
      recordQuickLinkOpen(db, { productId: item.id, code, campaign, address: from });
    expect(await open(address, 'whatsapp')).toBe(true);
    expect(await open(address)).toBe(false);
    expect(await open(`${address}.2`)).toBe(true);
    expect(await events(item.id)).toEqual([
      { kind: 'open', campaign: 'whatsapp', order_id: null },
      { kind: 'open', campaign: null, order_id: null },
    ]);
  });

  it('attributes an order of the link once, ignoring another code and replays', async () => {
    const [item, other] = await Promise.all([product(), product()]);
    const code = await codeOf(item.id);
    const buyer = await customer({ funds: usd(20) });
    const input = request(buyer, item, { quickLink: { code, campaign: 'shop' } });
    const { order } = await buy(input);
    await buy(input);
    await buy(request(buyer, item, { quickLink: { code: await codeOf(other.id) } }));
    expect(await events(item.id)).toEqual([
      { kind: 'order', campaign: 'shop', order_id: order.id },
    ]);
    await expect(
      pool.query("update quick_link_events set campaign = 'x' where order_id = $1", [order.id]),
    ).rejects.toMatchObject({ code: '23001' });
    await expect(
      pool.query('delete from quick_link_events where order_id = $1', [order.id]),
    ).rejects.toMatchObject({ code: '23001' });
    await expect(
      pool.query(
        "insert into quick_link_events (id, product_id, kind, order_id) values ($1, $2, 'open', $3)",
        [newId(), item.id, order.id],
      ),
    ).rejects.toMatchObject({ code: '23514' });
  });

  it('counts paid orders net of refunds, a reservation once paid, never a test customer', async () => {
    const item = await product();
    const code = await codeOf(item.id);
    const from = new Date(Date.now() - 60_000).toISOString();
    const link = { code, campaign: 'ads' };
    await buy(request(await customer({ funds: usd(20) }), item, { quickLink: link }));
    await buy(request(await customer({ funds: usd(20), isTest: true }), item, { quickLink: link }));
    const { order: reserved } = await buy(
      request(await customer(), item, { quickLink: link, whenBalanceShort: 'reserve' }),
    );
    expect(reserved.status).toBe('awaiting_balance');
    await recordQuickLinkOpen(db, { productId: item.id, code, campaign: 'ads', address: unique() });
    const to = new Date(Date.now() + 60_000).toISOString();
    expect((await quickLinkStats(db, { from, to, productId: item.id })).items).toEqual([
      expect.objectContaining({
        productId: item.id,
        quickCode: code,
        campaign: 'ads',
        opens: 1,
        orders: 1,
        revenueUsdUnits: item.price,
      }),
    ]);
  });

  it('deletes link events only after 90 days', async () => {
    const item = await product();
    await owner.pool.query(
      `insert into quick_link_events (id, product_id, kind, created_at)
       values ($1, $2, 'open', now() - interval '91 days')`,
      [newId(), item.id],
    );
    expect(await deleteOldQuickLinkEvents(db)).toBeGreaterThanOrEqual(1);
    expect(await events(item.id)).toEqual([]);
  });

  it('builds the cards from the latest paid order of each saved ID, skipping hidden ones', async () => {
    const item = await product();
    const buyer = await customer({ funds: usd(20) });
    await buy(request(buyer, item, { savePlayer: { label: 'أخي' } }));
    await buy(
      request(buyer, item, { savePlayer: { label: 'أنا' }, fields: { player_id: '5999999999' } }),
    );
    await buy(
      request(buyer, item, { whenBalanceShort: 'reserve', fields: { player_id: '5888888888' } }),
    );
    const cards = await quickBuyRows(db, buyer);
    expect(cards.map((card) => [card.savedPlayer.label, card.product.id, card.quantity])).toEqual([
      ['أنا', item.id, 1],
      ['أخي', item.id, 1],
    ]);
    expect(cards[0]?.product.live).toBe(true);
    await pool.query(
      "update saved_players set quick_buy_hidden = true where customer_id = $1 and label = 'أنا'",
      [buyer],
    );
    expect((await quickBuyRows(db, buyer)).map((card) => card.savedPlayer.label)).toEqual(['أخي']);
    expect(await quickBuyRows(db, await customer())).toEqual([]);
  });

  it('sums the open reservations', async () => {
    const item = await product();
    const buyer = await customer();
    expect(await reservedUsdUnits(db, buyer)).toBe(0);
    await buy(request(buyer, item, { whenBalanceShort: 'reserve' }));
    await buy(
      request(buyer, item, { whenBalanceShort: 'reserve', fields: { player_id: '5777777777' } }),
    );
    expect(await reservedUsdUnits(db, buyer)).toBe(2 * item.price);
  });
});

describe('order problems and product alerts (S22 OP5, PA1–PA6)', () => {
  const routing = () => ({ now: new Date(), fakeEnabled: true });
  const ticketNumber = () =>
    `VT-${Array.from({ length: 6 }, () => TICKET_ALPHABET[(randomBytes(1)[0] as number) % TICKET_ALPHABET.length]).join('')}`;
  const run = () => runProductAlerts(db, { ...routing(), jobs: context().jobs }, new Date());
  const alertRow = async (id: string) =>
    (await db.select().from(productAlerts).where(eq(productAlerts.id, id)))[0];
  const notices = async (customerId: string) =>
    (
      await db
        .select({ event: customerNotifications.event, params: customerNotifications.params })
        .from(customerNotifications)
        .where(eq(customerNotifications.customerId, customerId))
    ).filter((row) => row.event.startsWith('product_'));
  const create = (customerId: string, productId: string, kind: 'available' | 'price_drop') =>
    db.transaction((tx) =>
      createProductAlert(tx, routing(), customerId, { productId, kind }, new Date()),
    );
  const reprice = (productId: string) =>
    db.transaction((tx) =>
      repriceProducts(tx, { productIds: [productId], cause: 'cost_sync', context: routing() }),
    );

  it('keeps the problem on order tickets only, fixed once opened (OP5)', async () => {
    const buyer = await customer();
    await expect(
      pool.query(
        `insert into support_tickets (id, number, customer_id, category, subject, status, opened_by,
           order_problem) values ($1, $2, $3, 'other', 'مشكلة أخرى', 'open', 'customer', 'other')`,
        [newId(), ticketNumber(), buyer],
      ),
    ).rejects.toThrow(/support_tickets_order_problem_check/);
    const item = await product();
    const funded = await customer({ funds: usd(10) });
    const { order } = await buy(request(funded, item));
    const id = newId();
    await pool.query(
      `insert into support_tickets (id, number, customer_id, category, order_id, subject, status,
         opened_by, order_problem) values ($1, $2, $3, 'order', $4, 'تأخر الطلب', 'open', 'customer',
         'not_arrived')`,
      [id, ticketNumber(), funded, order.id],
    );
    await expect(
      pool.query(`update support_tickets set order_problem = 'other' where id = $1`, [id]),
    ).rejects.toThrow(/what it is about is fixed/);
  });

  it('sets an alert that fits the pack, once per kind, within the limit (PA1)', async () => {
    const buyer = await customer();
    const gone = await product({ inStock: false });
    const live = await product();
    expect(await refusal(create(buyer, live.id, 'available'))).toEqual({
      code: 'PRODUCT_ALERT_INVALID',
      details: { reason: 'available' },
    });
    expect(await refusal(create(buyer, gone.id, 'price_drop'))).toEqual({
      code: 'PRODUCT_ALERT_INVALID',
      details: { reason: 'unavailable' },
    });
    const drop = await create(buyer, live.id, 'price_drop');
    expect(drop.created).toBe(true);
    expect(drop.alert.baselinePriceUsdUnits).toBe(live.price);
    // Two presses at once write one alert.
    const [first, second] = await Promise.all([
      create(buyer, gone.id, 'available'),
      create(buyer, gone.id, 'available'),
    ]);
    expect([first.created, second.created].sort()).toEqual([false, true]);
    expect(first.alert.id).toBe(second.alert.id);
    expect(await waitingAlertCounts(db, [gone.id, live.id])).toEqual(new Map([[gone.id, 1]]));
    expect((await customerProductAlerts(db, buyer, { status: 'active' })).length).toBe(2);
    expect(await activeAlertCount(db, buyer)).toBe(2);

    // The 30th active alert is the last (rows written directly: the limit is what is tested).
    const others = await Promise.all(Array.from({ length: 14 }, () => product({ inStock: false })));
    await db.insert(productAlerts).values(
      others.flatMap((item) =>
        (['available', 'price_drop'] as const).map((kind) => ({
          customerId: buyer,
          productId: item.id,
          kind,
          baselinePriceUsdUnits: kind === 'price_drop' ? item.price : null,
          priceListId: ROOT_PRICE_LIST_IDS.retail,
          expiresAt: new Date(Date.now() + 86_400_000),
        })),
      ),
    );
    const extra = await product({ inStock: false });
    expect(await refusal(create(buyer, extra.id, 'available'))).toEqual({
      code: 'PRODUCT_ALERTS_LIMIT_REACHED',
      details: { limit: 30 },
    });

    expect(await cancelProductAlert(db, await customer(), drop.alert.id)).toBe(false);
    expect(await cancelProductAlert(db, buyer, drop.alert.id)).toBe(true);
    expect((await alertRow(drop.alert.id))?.status).toBe('cancelled');
    expect(
      (await customerProductAlerts(db, buyer, { status: 'ended' })).map((alert) => alert.id),
    ).toEqual([drop.alert.id]);
    // The extra rows would otherwise be read by every later run.
    await pool.query(
      `update product_alerts set status = 'cancelled', ended_at = now() where customer_id = $1
         and status = 'active'`,
      [buyer],
    );
  });

  it('sends a due alert once, on the customer list, and ends the others (PA3–PA6)', async () => {
    const buyer = await customer();
    const back = await product({ inStock: false });
    const cheaper = await product({ cost: usd(2) });
    const same = await product();
    const archived = await product({ inStock: false });
    const old = await product({ inStock: false });
    const availability = await create(buyer, back.id, 'available');
    const drop = await create(buyer, cheaper.id, 'price_drop');
    const steady = await create(buyer, same.id, 'price_drop');
    const gone = await create(buyer, archived.id, 'available');
    const expiring = await create(buyer, old.id, 'available');

    // Nothing is due yet.
    await run();
    expect(await notices(buyer)).toEqual([]);

    await pool.query('update supplier_offers set in_stock = true where id = $1', [back.offer]);
    await reprice(back.id);
    // 5% cheaper: under the review threshold, so the new price applies at once.
    await pool.query('update supplier_offers set cost_usd_units = $1 where id = $2', [
      usd(1.9),
      cheaper.offer,
    ]);
    await reprice(cheaper.id);
    await pool.query('update catalog_products set archived_at = now() where id = $1', [
      archived.id,
    ]);
    await pool.query(
      `update product_alerts set expires_at = now() - interval '1 minute' where id = $1`,
      [expiring.alert.id],
    );
    await run();
    await run();

    expect((await alertRow(availability.alert.id))?.status).toBe('sent');
    expect((await alertRow(drop.alert.id))?.status).toBe('sent');
    expect((await alertRow(steady.alert.id))?.status).toBe('active');
    expect((await alertRow(gone.alert.id))?.status).toBe('cancelled');
    expect((await alertRow(expiring.alert.id))?.status).toBe('expired');
    const sent = await notices(buyer);
    expect(sent.map((row) => row.event).sort()).toEqual([
      'product_available',
      'product_price_dropped',
    ]);
    expect(sent.find((row) => row.event === 'product_price_dropped')?.params).toMatchObject({
      alertId: drop.alert.id,
      oldUnitPriceUsdUnits: cheaper.price,
      newUnitPriceUsdUnits: priceFromCost(usd(1.9), rule),
    });
    await pool.query(
      `update product_alerts set status = 'cancelled', ended_at = now() where customer_id = $1
         and status = 'active'`,
      [buyer],
    );
  });

  it('rebases an alert to a new list without sending; ended ones go after 90 days (PA5)', async () => {
    const buyer = await customer();
    const item = await product();
    const alert = await create(buyer, item.id, 'price_drop');
    await pool.query('update customers set price_list_id = $1 where id = $2', [
      ROOT_PRICE_LIST_IDS.wholesale,
      buyer,
    ]);
    await run();
    expect(await alertRow(alert.alert.id)).toMatchObject({
      status: 'active',
      priceListId: ROOT_PRICE_LIST_IDS.wholesale,
    });
    expect(await notices(buyer)).toEqual([]);

    await pool.query(
      `update product_alerts set status = 'cancelled', ended_at = now() - interval '91 days'
       where id = $1`,
      [alert.alert.id],
    );
    expect(await deleteOldProductAlerts(db, new Date())).toBeGreaterThanOrEqual(1);
    expect(await alertRow(alert.alert.id)).toBeUndefined();
  });

  const listPrice = async (productId: string, priceListId: string) =>
    (
      await pool.query<{ units: string }>(
        `select price_usd_units as units from product_prices
          where product_id = $1 and price_list_id = $2
          order by created_at desc, id desc limit 1`,
        [productId, priceListId],
      )
    ).rows[0]?.units;
  const endAll = (customerId: string) =>
    pool.query(
      `update product_alerts set status = 'cancelled', ended_at = now() where customer_id = $1
         and status = 'active'`,
      [customerId],
    );

  it('keeps a private list’s price as the baseline and in the notice, never retail (abuse table)', async () => {
    const merchant = await customer();
    await pool.query('update customers set price_list_id = $1 where id = $2', [
      ROOT_PRICE_LIST_IDS.wholesale,
      merchant,
    ]);
    const item = await product({ cost: usd(2) });
    const before = Number(await listPrice(item.id, ROOT_PRICE_LIST_IDS.wholesale));
    expect(before).not.toBe(item.price);
    const drop = await create(merchant, item.id, 'price_drop');
    expect(drop.alert.baselinePriceUsdUnits).toBe(before);
    await pool.query('update supplier_offers set cost_usd_units = $1 where id = $2', [
      usd(1.9),
      item.offer,
    ]);
    await reprice(item.id);
    const after = Number(await listPrice(item.id, ROOT_PRICE_LIST_IDS.wholesale));
    await run();
    expect((await notices(merchant))[0]?.params).toMatchObject({
      oldUnitPriceUsdUnits: before,
      newUnitPriceUsdUnits: after,
    });
  });

  it('rebases to the new list’s price (PA5)', async () => {
    const buyer = await customer();
    const item = await product();
    const alert = await create(buyer, item.id, 'price_drop');
    expect(alert.alert.baselinePriceUsdUnits).toBe(item.price);
    await pool.query('update customers set price_list_id = $1 where id = $2', [
      ROOT_PRICE_LIST_IDS.wholesale,
      buyer,
    ]);
    await run();
    expect((await alertRow(alert.alert.id))?.baselinePriceUsdUnits).toBe(
      Number(await listPrice(item.id, ROOT_PRICE_LIST_IDS.wholesale)),
    );
    await endAll(buyer);
  });

  it('refuses a paused game’s pack, and a paused game keeps its alerts unsent (PA1, edge case 17)', async () => {
    const buyer = await customer();
    const item = await product({ inStock: false });
    const alert = await create(buyer, item.id, 'available');
    await pool.query(`update catalog_games set status = 'paused' where id = $1`, [item.game]);
    const other = await product();
    await pool.query(`update catalog_games set status = 'paused' where id = $1`, [other.game]);
    expect(await refusal(create(buyer, other.id, 'price_drop'))).toEqual({
      code: 'PRODUCT_ALERT_INVALID',
      details: { reason: 'hidden' },
    });
    await pool.query('update supplier_offers set in_stock = true where id = $1', [item.offer]);
    await reprice(item.id);
    await run();
    expect((await alertRow(alert.alert.id))?.status).toBe('active');
    expect(await notices(buyer)).toEqual([]);
    await endAll(buyer);
  });

  it('cancels an archived customer’s alerts without a notice (PA6, edge case 18)', async () => {
    const buyer = await customer();
    const item = await product({ inStock: false });
    const alert = await create(buyer, item.id, 'available');
    await pool.query('update supplier_offers set in_stock = true where id = $1', [item.offer]);
    await reprice(item.id);
    await pool.query('update customers set archived_at = now() where id = $1', [buyer]);
    await run();
    expect((await alertRow(alert.alert.id))?.status).toBe('cancelled');
    expect(await notices(buyer)).toEqual([]);
  });

  it('lets one of two parallel creations take the 30th place (PA1)', async () => {
    const buyer = await customer();
    const items = await Promise.all(Array.from({ length: 15 }, () => product({ inStock: false })));
    await db.insert(productAlerts).values(
      items.slice(0, 14).flatMap((item) =>
        (['available', 'price_drop'] as const).map((kind) => ({
          customerId: buyer,
          productId: item.id,
          kind,
          baselinePriceUsdUnits: kind === 'price_drop' ? item.price : null,
          priceListId: ROOT_PRICE_LIST_IDS.retail,
          expiresAt: new Date(Date.now() + 86_400_000),
        })),
      ),
    );
    await create(buyer, (items[14] as { id: string }).id, 'available');
    const [a, b] = [await product({ inStock: false }), await product({ inStock: false })];
    const outcomes = await Promise.allSettled([
      create(buyer, a.id, 'available'),
      create(buyer, b.id, 'available'),
    ]);
    expect(outcomes.map((outcome) => outcome.status).sort()).toEqual(['fulfilled', 'rejected']);
    const refused = outcomes.find((outcome) => outcome.status === 'rejected');
    expect((refused as PromiseRejectedResult).reason).toMatchObject({
      code: 'PRODUCT_ALERTS_LIMIT_REACHED',
    });
    expect(await activeAlertCount(db, buyer)).toBe(30);
    await endAll(buyer);
  });
});
