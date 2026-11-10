import { createHash, randomBytes } from 'node:crypto';
import {
  CURRENCY_SCALE,
  priceFromCost,
  QUEUES,
  ROOT_PRICE_LIST_IDS,
} from '@vertex-digital/contracts';
import { and, eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDatabase } from '../client.js';
import { freezeCustomer, lockCustomer } from '../customers/state.js';
import { newId } from '../id.js';
import { accountBalance } from '../ledger/balance.js';
import {
  ensureCustomerWallet,
  ensureSystemAccount,
  findShopCustomerWallet,
} from '../ledger/index.js';
import { postJournal } from '../ledger/post-journal.js';
import { revokeMerchant } from '../merchants/accounts.js';
import { applyOutcome, refundRemaining } from '../orders/outcome.js';
import type { OrderError } from '../orders/purchase.js';
import { revealCode, shopCustomerOrder, shopCustomerOrderPage } from '../orders/reads.js';
import {
  lockOrder,
  type OrderContext,
  type OrderRow,
  transitionOrder,
} from '../orders/transition.js';
import { repriceProducts } from '../pricing/index.js';
import { internalChecks } from '../reconciliation/internal.js';
import {
  auditEntries,
  customerNotifications,
  customers,
  emailOutbox,
  fulfilmentAttempts,
  ledgerPostings,
  merchantSellingPrices,
  merchantSellingSettings,
  merchantShopHiddenGames,
  merchantShops,
  orders,
  shopCompensations,
  shopCustomerNotifications,
  shopCustomers,
  shopOrderSales,
} from '../schema/index.js';
import { compensateShopOrder } from './compensation.js';
import { endShopReturn, requestShopReturn } from './returns.js';
import { purchaseShopOrder, SHOP_MARGIN_HELD_CODE, type ShopPurchaseInput } from './selling.js';
import type { ShopError } from './state.js';
import { transferToShopCustomer } from './transfers.js';

/*
 * S26 PR 2 write paths and the guards of migration 0115, on PostgreSQL as the app role (the owner
 * only to prove a guard refuses it too): the shop purchase (PR5–PR7), the finish of a shop order
 * (PR8: refund at the selling price, margin released to the merchant), the compensation (PR10),
 * the reconciliation of their journals (C6, C7, C9, C10) and the races of the spec's edge cases.
 * Every product has its own category, game, rule and `fake` route; every test its own accounts.
 */

const connection = createDatabase(process.env.DATABASE_URL as string);
const owner = createDatabase(process.env.DATABASE_OWNER_URL as string);
const { db, pool } = connection;
const USD = CURRENCY_SCALE.USD;
const CENT = USD / 100;
const unique = () => newId().replaceAll('-', '').slice(-12);
const rule = { percentBp: 1000, fixedUsdUnits: 0, minMarginUsdUnits: 100_000 };
const sent: { queue: string; data: object }[] = [];
const jobs: OrderContext['jobs'] = {
  send: async (_tx, queue, data) => {
    sent.push({ queue, data });
    return null;
  },
};
const context = (): OrderContext => ({ jobs, codesKey: randomBytes(32), now: new Date() });
const admin = () => ({ adminId: newId(), ipAddress: null, userAgent: null });
const hash = (value: object) => createHash('sha256').update(JSON.stringify(value)).digest('hex');

let fakeSupplier: string;
const categories: string[] = [];

beforeAll(async () => {
  const { rows } = await pool.query<{ id: string }>(`select id from suppliers where code = 'fake'`);
  fakeSupplier = rows[0]?.id as string;
  await pool.query(
    `insert into supplier_credentials (id, supplier_id, ciphertext, hints, admin_id)
     select $1, $2, '\\x00', '{}', $3
     where not exists (select 1 from supplier_credentials where supplier_id = $2)`,
    [newId(), fakeSupplier, newId()],
  );
});

afterAll(async () => {
  await pool.query('update catalog_categories set archived_at = now() where id = any($1::uuid[])', [
    categories,
  ]);
  await Promise.all([connection.close(), owner.close()]);
});

/** An active pack with a route to the fake supplier, priced on the retail list (cost $0.88). */
async function product(options: { kind?: 'direct' | 'code' } = {}) {
  const [category, game, id, offer, route] = [newId(), newId(), newId(), newId(), newId()];
  const kind = options.kind ?? 'direct';
  const cost = 88 * CENT;
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
       cost_confirmed_at, last_seen_at) values ($1, $2, $3, 'Offer', true, $4, now(), now())`,
    [offer, fakeSupplier, `o-${unique()}`, cost],
  );
  await pool.query(
    `insert into product_routes (id, product_id, supplier_id, offer_id, field_map)
     values ($1, $2, $3, $4, $5)`,
    [route, id, fakeSupplier, offer, kind === 'direct' ? { playerId: 'player_id' } : {}],
  );
  await db.transaction((tx) =>
    repriceProducts(tx, {
      productIds: [id],
      cause: 'route_change',
      context: { now: new Date(), fakeEnabled: true },
    }),
  );
  return { id, game, kind, offer, route, cost, price: priceFromCost(cost, rule) };
}

type Pack = Awaited<ReturnType<typeof product>>;

/** Merchant funds as an adjustment (the merchant then funds the shop wallet by a transfer). */
async function fund(customerId: string, units: number) {
  await db.transaction(async (tx) => {
    await postJournal(tx, {
      idempotencyKey: `test:${newId()}`,
      kind: 'adjustment',
      postings: [
        { accountId: await ensureCustomerWallet(tx, customerId), amountUnits: units },
        {
          accountId: await ensureSystemAccount(tx, {
            code: 'adjustments:test_funds',
            kind: 'adjustments',
            currency: 'USD',
          }),
          amountUnits: -units,
        },
      ],
    });
  });
}

/**
 * A merchant on the retail list (its purchase price is the pack's retail price), an active shop
 * and a verified shop customer whose wallet the merchant funded with a real transfer.
 */
async function setting(options: { merchantUsd?: number; shopUnits?: number } = {}) {
  const merchantId = newId();
  await db.insert(customers).values({
    id: merchantId,
    name: 'Merchant',
    email: `${merchantId}@test.vertex-digital.local`,
    phone: '+963900000001',
    emailVerified: true,
    accountType: 'merchant',
    priceListId: ROOT_PRICE_LIST_IDS.retail,
  });
  const shopId = newId();
  await db.insert(merchantShops).values({
    id: shopId,
    merchantId,
    slug: `s${unique()}`,
    displayName: 'متجر النور',
    brandColor: '#1f7a6c',
  });
  await db
    .update(merchantShops)
    .set({ status: 'active', decidedAt: sql`now()` })
    .where(eq(merchantShops.id, shopId));
  const shopCustomerId = newId();
  await db.insert(shopCustomers).values({
    id: shopCustomerId,
    shopId,
    name: 'سامي',
    email: `${shopCustomerId}@test.vertex-digital.local`,
    phone: '+963900000002',
    emailVerified: true,
    createdBy: 'merchant',
  });
  const merchantUsd = options.merchantUsd ?? 50;
  const shopUnits = options.shopUnits ?? 20 * USD;
  await fund(merchantId, merchantUsd * USD + shopUnits);
  if (shopUnits > 0) {
    await db.transaction((tx) =>
      transferToShopCustomer(tx, jobs, {
        shopId,
        merchantId,
        shopCustomerId,
        currency: 'usd',
        amountUnits: shopUnits,
        expectedUsdUnits: shopUnits,
        idempotencyKey: newId(),
        actor: { kind: 'customer', id: merchantId, channel: 'store' },
      }),
    );
  }
  return { merchantId, shopId, shopCustomerId };
}

type Setting = Awaited<ReturnType<typeof setting>>;

/** A 20% markup over the purchase price (rounded up to whole cents, PR2). */
async function markup(merchantId: string, markupBp = 2_000) {
  await db
    .insert(merchantSellingSettings)
    .values({ customerId: merchantId, markupBp, sypStepUnits: null });
}

const sellAt = (price: number, markupBp = 2_000) =>
  Math.ceil((price * (10_000 + markupBp)) / 10_000 / CENT) * CENT;

function purchase(
  ids: Setting,
  item: Pack,
  sell: number,
  overrides: Partial<ShopPurchaseInput> = {},
): ShopPurchaseInput {
  return {
    shopId: ids.shopId,
    shopCustomerId: ids.shopCustomerId,
    productId: item.id,
    quantity: 1,
    fields: item.kind === 'direct' ? { player_id: '5123456789' } : {},
    expectedUnitSellUsdUnits: sell,
    confirmPlayer: false,
    idempotencyKey: newId(),
    requestHash: hash({ productId: item.id }),
    fakeEnabled: true,
    purchasesStopped: false,
    playerCheck: async () => null,
    ...overrides,
  };
}

const buy = (input: ShopPurchaseInput) =>
  db.transaction((tx) => purchaseShopOrder(tx, context(), input));

const refusal = async (promise: Promise<unknown>) => {
  try {
    await promise;
  } catch (error) {
    const coded = error as OrderError & ShopError;
    return { code: coded.code, details: coded.details };
  }
  throw new Error('Expected a refusal');
};

const balanceOf = async (ids: { customerId?: string; shopCustomerId?: string }) => {
  const wallet = ids.customerId
    ? await ensureCustomerWalletRead(ids.customerId)
    : await findShopCustomerWallet(db, ids.shopCustomerId as string);
  return wallet === null ? 0 : accountBalance(db, wallet);
};

async function ensureCustomerWalletRead(customerId: string) {
  return db.transaction((tx) => ensureCustomerWallet(tx, customerId));
}

const heldTotal = async () => {
  const { rows } = await pool.query<{ total: string }>(
    `select coalesce(sum(p.amount_units), 0)::text as total from ledger_postings p
     join ledger_accounts a on a.id = p.account_id where a.code = $1`,
    [SHOP_MARGIN_HELD_CODE],
  );
  return Number(rows[0]?.total);
};

/** Sends the order's remaining units to its route, as `orders.fulfil` does. */
async function send(order: OrderRow, item: Pack) {
  return db.transaction(async (tx) => {
    const locked = (await lockOrder(tx, order.id)) as OrderRow;
    const id = newId();
    await tx.insert(fulfilmentAttempts).values({
      id,
      orderId: order.id,
      routeId: item.route,
      supplierId: fakeSupplier,
      offerId: item.offer,
      supplierOfferId: 'o-test',
      quantity: locked.quantity - locked.deliveredQuantity - locked.refundedQuantity,
      unitCostUsdUnits: item.cost,
      status: 'sending',
      candidates: [],
      sentAt: new Date(),
    });
    await transitionOrder(tx, locked, 'sent_to_supplier', { actor: 'system', attemptId: id });
    return id;
  });
}

const apply = (attemptId: string, outcome: Parameters<typeof applyOutcome>[3]) =>
  db.transaction((tx) => applyOutcome(tx, context(), attemptId, outcome, { by: 'supplier' }));

const saleOf = async (orderId: string) =>
  (await db.select().from(shopOrderSales).where(eq(shopOrderSales.orderId, orderId)))[0];

/** The offending ids of the internal checks that name these orders. */
async function offending(ids: readonly string[]) {
  const { results } = await db.transaction((tx) => internalChecks(tx), {
    isolationLevel: 'repeatable read',
    accessMode: 'read only',
  });
  return results
    .filter((result) =>
      (result.details.offending ?? []).some((entry: { id: string }) => ids.includes(entry.id)),
    )
    .map((result) => result.check);
}

describe('the shop purchase (PR5–PR7)', () => {
  it('charges the selling price, credits the merchant price and holds the margin', async () => {
    const item = await product();
    const ids = await setting();
    await markup(ids.merchantId);
    const sell = sellAt(item.price);
    const { order, sale, created } = await buy(purchase(ids, item, sell));
    expect(created).toBe(true);
    expect(order).toMatchObject({
      status: 'paid',
      customerId: ids.merchantId,
      shopCustomerId: ids.shopCustomerId,
      unitPriceUsdUnits: item.price,
      totalUsdUnits: item.price,
      priceListId: ROOT_PRICE_LIST_IDS.retail,
    });
    expect(sale).toMatchObject({
      shopId: ids.shopId,
      unitSellUsdUnits: sell,
      unitBuyUsdUnits: item.price,
      quantity: 1,
      sellCurrency: 'usd',
      marginReleasedUsdUnits: null,
    });
    expect(await balanceOf({ shopCustomerId: ids.shopCustomerId })).toBe(20 * USD - sell);
    // The merchant's wallet is not touched by a purchase (PR6).
    expect(await balanceOf({ customerId: ids.merchantId })).toBe(50 * USD);
    const postings = await db
      .select({ amount: ledgerPostings.amountUnits })
      .from(ledgerPostings)
      .where(eq(ledgerPostings.journalId, order.purchaseJournalId as string));
    expect(postings.map((p) => p.amount).sort((a, b) => a - b)).toEqual(
      [-sell, item.price, sell - item.price].sort((a, b) => a - b),
    );
    const [audit] = await db
      .select()
      .from(auditEntries)
      .where(and(eq(auditEntries.entityId, order.id), eq(auditEntries.action, 'shop.order_paid')));
    expect(audit).toMatchObject({ actorKind: 'shop_customer', actorId: ids.shopCustomerId });
    expect(audit?.details).toMatchObject({ sellUsdUnits: sell, buyUsdUnits: item.price });
    expect(sent).toContainEqual({ queue: QUEUES.ordersFulfil, data: { orderId: order.id } });
    expect(await offending([order.id])).toEqual([]);
  });

  it('sells at the purchase price without a markup, and at an own SYP price rounded up', async () => {
    const item = await product();
    const ids = await setting();
    const plain = await buy(purchase(ids, item, item.price));
    expect(plain.sale.unitSellUsdUnits).toBe(item.price);
    // 20,000 SYP at the shop's own rate 13,000 = $1.538… → $1.54 (PR2).
    await db.insert(merchantSellingPrices).values({
      customerId: ids.merchantId,
      productId: item.id,
      currency: 'syp',
      amountUnits: 20_000 * 100,
    });
    await db.update(merchantShops).set({ rateMode: 'own' }).where(eq(merchantShops.id, ids.shopId));
    await pool.query(
      `insert into merchant_shop_rates (id, shop_id, rate_syp_per_usd, confirmed_far)
       values ($1, $2, '13000', false)`,
      [newId(), ids.shopId],
    );
    const syp = await buy(purchase(ids, item, 154 * CENT));
    expect(syp.sale).toMatchObject({
      unitSellUsdUnits: 154 * CENT,
      sellCurrency: 'syp',
      unitSellEnteredUnits: 20_000 * 100,
      unitSellSypUnits: 20_000 * 100,
    });
  });

  it('refuses another selling price, a price below cost, and an empty wallet, charging nothing', async () => {
    const item = await product();
    const ids = await setting({ shopUnits: USD });
    await markup(ids.merchantId);
    const sell = sellAt(item.price);
    expect(await refusal(buy(purchase(ids, item, sell + CENT)))).toEqual({
      code: 'PRICE_CHANGED',
      details: { unitPriceUsdUnits: sell },
    });
    expect((await refusal(buy(purchase(ids, item, sell)))).code).toBe('INSUFFICIENT_BALANCE');
    // PR3: an own price under the merchant's purchase price is not sold.
    await db.insert(merchantSellingPrices).values({
      customerId: ids.merchantId,
      productId: item.id,
      currency: 'usd',
      amountUnits: item.price - CENT,
    });
    expect(await refusal(buy(purchase(ids, item, item.price - CENT)))).toEqual({
      code: 'PRODUCT_UNAVAILABLE',
      details: { availability: 'paused_by_margin_guard' },
    });
    expect(await balanceOf({ shopCustomerId: ids.shopCustomerId })).toBe(USD);
  });

  it('replays the same key and body, and refuses the key with another body', async () => {
    const item = await product();
    const ids = await setting();
    const input = purchase(ids, item, item.price);
    const [first, second] = await Promise.all([buy(input), buy(input)]);
    expect(first.order.id).toBe(second.order.id);
    expect([first.created, second.created].sort()).toEqual([false, true]);
    expect(await balanceOf({ shopCustomerId: ids.shopCustomerId })).toBe(20 * USD - item.price);
    expect((await refusal(buy({ ...input, requestHash: hash({ other: 1 }) }))).code).toBe(
      'IDEMPOTENCY_KEY_REUSED',
    );
  });

  it('refuses a hidden game, a suspended shop, a frozen shop customer and a stop', async () => {
    const item = await product();
    const ids = await setting();
    expect(
      (await refusal(buy(purchase(ids, item, item.price, { purchasesStopped: true })))).code,
    ).toBe('PURCHASES_STOPPED');
    await db.insert(merchantShopHiddenGames).values({ shopId: ids.shopId, gameId: item.game });
    expect((await refusal(buy(purchase(ids, item, item.price)))).code).toBe('NOT_FOUND');
    await pool.query('delete from merchant_shop_hidden_games where shop_id = $1', [ids.shopId]);
    await db
      .update(shopCustomers)
      .set({ frozenAt: sql`now()`, frozenReason: 'test' })
      .where(eq(shopCustomers.id, ids.shopCustomerId));
    expect((await refusal(buy(purchase(ids, item, item.price)))).code).toBe('ACCOUNT_FROZEN');
    await db
      .update(shopCustomers)
      .set({ frozenAt: null, frozenReason: null })
      .where(eq(shopCustomers.id, ids.shopCustomerId));
    await db
      .update(merchantShops)
      .set({ status: 'suspended', suspendReason: 'review', suspendNote: 'test' })
      .where(eq(merchantShops.id, ids.shopId));
    expect((await refusal(buy(purchase(ids, item, item.price)))).code).toBe('SHOP_UNAVAILABLE');
  });

  it("keeps selling while the merchant is frozen (SH4), never touching the merchant's wallet", async () => {
    const item = await product();
    const ids = await setting();
    await db.transaction((tx) =>
      freezeCustomer(tx, { jobs }, { customerId: ids.merchantId, reason: 'test', actor: admin() }),
    );
    const { order } = await buy(purchase(ids, item, item.price));
    expect(order.status).toBe('paid');
  });
});

describe('the finish of a shop order (PR8, PR9)', () => {
  it('releases the margin of a delivered order to the merchant and tells the shop customer', async () => {
    const item = await product();
    const ids = await setting();
    await markup(ids.merchantId);
    const sell = sellAt(item.price);
    const held = await heldTotal();
    const { order } = await buy(purchase(ids, item, sell));
    expect(await heldTotal()).toBe(held + sell - item.price);
    const attemptId = await send(order, item);
    const result = await apply(attemptId, { status: 'delivered', quantity: 1 });
    expect(result.order.status).toBe('delivered');
    expect(await heldTotal()).toBe(held);
    expect(await balanceOf({ customerId: ids.merchantId })).toBe(50 * USD + sell - item.price);
    expect((await saleOf(order.id))?.marginReleasedUsdUnits).toBe(sell - item.price);
    const notes = await db
      .select()
      .from(shopCustomerNotifications)
      .where(eq(shopCustomerNotifications.shopCustomerId, ids.shopCustomerId));
    expect(notes.map((note) => note.event)).toEqual(['transfer_received', 'order_delivered']);
    // PR9: the merchant is not told per order.
    const merchantNotes = await db
      .select()
      .from(customerNotifications)
      .where(eq(customerNotifications.customerId, ids.merchantId));
    expect(merchantNotes).toEqual([]);
    const [email] = await db
      .select()
      .from(emailOutbox)
      .where(eq(emailOutbox.template, 'shop_customer_order_delivered'))
      .orderBy(sql`${emailOutbox.createdAt} desc`)
      .limit(1);
    expect(email?.params).toMatchObject({ orderNumber: order.number, shopName: 'متجر النور' });
    expect(await offending([order.id])).toEqual([]);
  });

  it('refunds a failed order at the selling price, releasing nothing', async () => {
    const item = await product();
    const ids = await setting();
    await markup(ids.merchantId);
    const sell = sellAt(item.price);
    const held = await heldTotal();
    const { order } = await buy(purchase(ids, item, sell));
    const attemptId = await send(order, item);
    const result = await apply(attemptId, {
      status: 'failed',
      reason: 'Player not found',
      inputRejected: true,
      supplierErrorCode: 'PLAYER_NOT_FOUND',
    });
    expect(result.order).toMatchObject({ status: 'refunded', refundedUsdUnits: item.price });
    expect(await balanceOf({ shopCustomerId: ids.shopCustomerId })).toBe(20 * USD);
    expect(await balanceOf({ customerId: ids.merchantId })).toBe(50 * USD);
    expect(await heldTotal()).toBe(held);
    expect((await saleOf(order.id))?.marginReleasedUsdUnits).toBe(0);
    const [note] = await db
      .select()
      .from(shopCustomerNotifications)
      .where(
        and(
          eq(shopCustomerNotifications.shopCustomerId, ids.shopCustomerId),
          eq(shopCustomerNotifications.event, 'order_refunded'),
        ),
      );
    expect(note?.params).toMatchObject({ refundedUsdUnits: sell, reason: 'input_rejected' });
    expect(await offending([order.id])).toEqual([]);
  });

  it('releases the delivered units only and refunds the rest at the selling price (edge case 7)', async () => {
    const item = await product({ kind: 'code' });
    const ids = await setting();
    await markup(ids.merchantId);
    const sell = sellAt(item.price);
    const held = await heldTotal();
    const { order } = await buy(purchase(ids, item, sell, { quantity: 3 }));
    const attemptId = await send(order, item);
    await apply(attemptId, { status: 'delivered', quantity: 1, codes: ['CODE-1'] });
    const refunded = await db.transaction(async (tx) =>
      refundRemaining(tx, context(), (await lockOrder(tx, order.id)) as OrderRow, 'no_route', {
        actor: 'system',
        actorId: null,
      }),
    );
    expect(refunded).toMatchObject({
      status: 'partially_refunded',
      deliveredQuantity: 1,
      refundedQuantity: 2,
      refundedUsdUnits: 2 * item.price,
    });
    expect(await balanceOf({ shopCustomerId: ids.shopCustomerId })).toBe(20 * USD - sell);
    expect(await balanceOf({ customerId: ids.merchantId })).toBe(50 * USD + sell - item.price);
    expect(await heldTotal()).toBe(held);
    expect(await offending([order.id])).toEqual([]);

    // PR4, PR12: the shop customer reads it at the selling price and reveals the code.
    const read = await shopCustomerOrder(db, ids.shopCustomerId, order.number);
    expect(read).toMatchObject({
      unitSellUsdUnits: sell,
      totalSellUsdUnits: 3 * sell,
      refundedUsdUnits: 2 * sell,
      compensatedUsdUnits: 0,
    });
    expect(JSON.stringify(read)).not.toContain(String(item.price));
    const page = await shopCustomerOrderPage(db, ids.shopCustomerId, { after: null, limit: 5 });
    expect(page.items.map((row) => row.id)).toEqual([order.id]);
    const codeId = read?.codes[0]?.id as string;
    const meta = { actor: 'customer' as const, ipAddress: null, userAgent: null };
    const asMerchant = await db.transaction((tx) =>
      revealCode(tx, context().codesKey, {
        ...meta,
        orderId: order.id,
        codeId,
        customerId: ids.merchantId,
        actorId: ids.merchantId,
      }),
    );
    expect(asMerchant).toBeNull();
    expect(await shopCustomerOrder(db, newId(), order.number)).toBeNull();
  });
});

describe('compensation (PR10)', () => {
  async function delivered(quantity = 2) {
    const item = await product({ kind: 'code' });
    const ids = await setting();
    await markup(ids.merchantId);
    const sell = sellAt(item.price);
    const { order } = await buy(purchase(ids, item, sell, { quantity }));
    const attemptId = await send(order, item);
    await apply(attemptId, {
      status: 'delivered',
      quantity,
      codes: Array.from({ length: quantity }, (_, index) => `CODE-${index}`),
    });
    return { ids, order, sell, price: item.price };
  }

  const compensate = (
    orderId: string,
    extra: Partial<Parameters<typeof compensateShopOrder>[2]> = {},
  ) =>
    db.transaction((tx) =>
      compensateShopOrder(tx, jobs, {
        orderId,
        units: 1,
        marginFrom: 'merchant',
        reason: 'code used',
        idempotencyKey: newId(),
        adminId: newId(),
        ...extra,
      }),
    );

  it("returns Vertex's part and takes the margin back from the merchant", async () => {
    const { ids, order, sell, price } = await delivered();
    const before = await balanceOf({ customerId: ids.merchantId });
    const { compensation } = await compensate(order.id);
    expect(compensation).toMatchObject({
      units: 1,
      vertexUsdUnits: price,
      marginUsdUnits: sell - price,
      marginFrom: 'merchant',
    });
    expect(await balanceOf({ customerId: ids.merchantId })).toBe(before - (sell - price));
    expect(await balanceOf({ shopCustomerId: ids.shopCustomerId })).toBe(20 * USD - sell);
    const [note] = await db
      .select()
      .from(customerNotifications)
      .where(eq(customerNotifications.customerId, ids.merchantId));
    expect(note?.event).toBe('merchant_shop_margin_returned');
    expect(await offending([order.id, compensation.adjustmentJournalId])).toEqual([]);
    const read = await shopCustomerOrder(db, ids.shopCustomerId, order.number);
    expect(read?.compensatedUsdUnits).toBe(sell);
  });

  it('lets the store cover the margin or leave it, and refuses an uncovered merchant', async () => {
    const { ids, order, sell, price } = await delivered();
    // The merchant spends everything first: the margin part is refused (PR10).
    const balance = await balanceOf({ customerId: ids.merchantId });
    await db.transaction(async (tx) => {
      await postJournal(tx, {
        idempotencyKey: `test:${newId()}`,
        kind: 'adjustment',
        postings: [
          { accountId: await ensureCustomerWallet(tx, ids.merchantId), amountUnits: -balance },
          {
            accountId: await ensureSystemAccount(tx, {
              code: 'adjustments:test_funds',
              kind: 'adjustments',
              currency: 'USD',
            }),
            amountUnits: balance,
          },
        ],
      });
    });
    expect(await refusal(compensate(order.id))).toMatchObject({
      code: 'INSUFFICIENT_BALANCE',
      details: { marginUsdUnits: sell - price },
    });
    const store = await compensate(order.id, { marginFrom: 'store' });
    expect(store.compensation).toMatchObject({ marginFrom: 'store', marginJournalId: null });
    const none = await compensate(order.id, { marginFrom: 'none' });
    expect(none.compensation.marginFrom).toBe('none');
    expect(await balanceOf({ shopCustomerId: ids.shopCustomerId })).toBe(
      20 * USD - 2 * sell + sell + price,
    );
    expect((await refusal(compensate(order.id))).details).toEqual({ reason: 'units' });
    expect(
      await offending([
        order.id,
        store.compensation.adjustmentJournalId,
        none.compensation.adjustmentJournalId,
      ]),
    ).toEqual([]);
  });

  it('replays its key, and refuses a non-shop order or a closed window', async () => {
    const { order } = await delivered(1);
    const key = newId();
    const first = await compensate(order.id, { idempotencyKey: key });
    const again = await compensate(order.id, { idempotencyKey: key });
    expect(again).toEqual({ compensation: first.compensation, replayed: true });
    expect((await refusal(compensate(order.id))).details).toEqual({ reason: 'units' });
    const later = new Date(Date.now() + 8 * 24 * 60 * 60 * 1000);
    const fresh = await delivered(1);
    expect((await refusal(compensate(fresh.order.id, { now: later }))).details).toEqual({
      reason: 'window_closed',
    });
    expect((await refusal(compensate(newId()))).code).toBe('NOT_FOUND');
  });
});

describe('a closed shop (SH7)', () => {
  it('keeps selling at the list stored at the close', async () => {
    const item = await product();
    const ids = await setting();
    await db.transaction(async (tx) => {
      const customer = await lockCustomer(tx, ids.merchantId);
      await revokeMerchant(tx, { jobs }, customer, { reason: 'Revoked in a test', actor: admin() });
    });
    const [shop] = await db.select().from(merchantShops).where(eq(merchantShops.id, ids.shopId));
    expect(shop).toMatchObject({
      status: 'closed',
      priceListIdAtClose: ROOT_PRICE_LIST_IDS.retail,
    });
    const { order } = await buy(purchase(ids, item, item.price));
    expect(order.priceListId).toBe(ROOT_PRICE_LIST_IDS.retail);
  });
});

describe('races (edge cases 3, 4, 5)', () => {
  it('serializes a transfer and a purchase on the shop wallet', async () => {
    const item = await product();
    const ids = await setting({ shopUnits: 4 * USD });
    await db
      .update(merchantShops)
      .set({ customerBalanceCapUsdUnits: 5 * USD })
      .where(eq(merchantShops.id, ids.shopId));
    const transfer = db.transaction((tx) =>
      transferToShopCustomer(tx, jobs, {
        shopId: ids.shopId,
        merchantId: ids.merchantId,
        shopCustomerId: ids.shopCustomerId,
        currency: 'usd',
        amountUnits: USD,
        expectedUsdUnits: USD,
        idempotencyKey: newId(),
        actor: { kind: 'customer', id: ids.merchantId, channel: 'store' },
      }),
    );
    const [moved, bought] = await Promise.allSettled([
      transfer,
      buy(purchase(ids, item, item.price)),
    ]);
    expect(bought.status).toBe('fulfilled');
    // The cap counts the balance after the purchase if it committed first; at most $5 either way.
    const balance = await balanceOf({ shopCustomerId: ids.shopCustomerId });
    expect(balance).toBeLessThanOrEqual(5 * USD);
    expect(balance).toBe(4 * USD - item.price + (moved.status === 'fulfilled' ? USD : 0));
  });

  it('never overdraws the shop wallet with parallel purchases', async () => {
    const item = await product();
    const ids = await setting({ shopUnits: item.price });
    const outcomes = await Promise.allSettled([
      buy(purchase(ids, item, item.price)),
      buy(purchase(ids, item, item.price)),
      buy(purchase(ids, item, item.price)),
    ]);
    expect(outcomes.filter((outcome) => outcome.status === 'fulfilled')).toHaveLength(1);
    expect(await balanceOf({ shopCustomerId: ids.shopCustomerId })).toBe(0);
  });

  it('refuses a return confirmed after a purchase took the balance (WL6)', async () => {
    const item = await product();
    const ids = await setting({ shopUnits: item.price });
    const request = await db.transaction((tx) =>
      requestShopReturn(tx, jobs, {
        shopId: ids.shopId,
        merchantId: ids.merchantId,
        shopCustomerId: ids.shopCustomerId,
        amountUsdUnits: item.price,
        idempotencyKey: newId(),
        actor: { kind: 'customer', id: ids.merchantId, channel: 'store' },
      }),
    );
    const confirm = db.transaction((tx) =>
      endShopReturn(
        tx,
        jobs,
        request.request.id,
        { action: 'confirm', shopCustomerId: ids.shopCustomerId, idempotencyKey: newId() },
        { kind: 'shop_customer', id: ids.shopCustomerId, channel: 'store' },
      ),
    );
    const outcomes = await Promise.allSettled([confirm, buy(purchase(ids, item, item.price))]);
    expect(outcomes.filter((outcome) => outcome.status === 'fulfilled')).toHaveLength(1);
    expect(await balanceOf({ shopCustomerId: ids.shopCustomerId })).toBe(0);
  });
});

describe('guards (migration 0115)', () => {
  it('fixes a sale row but its released margin, once, and keeps compensations append-only', async () => {
    const item = await product();
    const ids = await setting();
    const { order } = await buy(purchase(ids, item, item.price));
    await expect(
      pool.query('update shop_order_sales set unit_sell_usd_units = 1 where order_id = $1', [
        order.id,
      ]),
    ).rejects.toThrow();
    await expect(
      pool.query('delete from shop_order_sales where order_id = $1', [order.id]),
    ).rejects.toThrow();
    await pool.query(
      'update shop_order_sales set margin_released_usd_units = 0 where order_id = $1',
      [order.id],
    );
    await expect(
      owner.pool.query(
        'update shop_order_sales set margin_released_usd_units = 10000 where order_id = $1',
        [order.id],
      ),
    ).rejects.toThrow(/released once/);
    await expect(
      pool.query('update orders set shop_customer_id = null where id = $1', [order.id]),
    ).rejects.toThrow();
    await expect(pool.query('update shop_compensations set units = 2')).rejects.toThrow();
    await expect(pool.query('delete from shop_customer_notifications')).rejects.toThrow();
  });

  it('keeps a shop order on its shop customer: never a gift, a checkout or the owner', async () => {
    const item = await product();
    const ids = await setting();
    const { order } = await buy(purchase(ids, item, item.price));
    const [row] = await db.select().from(orders).where(eq(orders.id, order.id));
    expect(row).toMatchObject({ payer: 'customer', placedBy: 'customer', isGift: false });
    expect(
      await db
        .select({ id: shopCompensations.id })
        .from(shopCompensations)
        .where(eq(shopCompensations.orderId, order.id)),
    ).toEqual([]);
  });
});
