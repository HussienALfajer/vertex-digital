import { createHash, randomBytes } from 'node:crypto';
import {
  CREDIT_POLICY_DEFAULTS,
  type CreditPolicy,
  CURRENCY_SCALE,
  QUEUES,
  ROOT_PRICE_LIST_IDS,
} from '@vertex-digital/contracts';
import { and, desc, eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDatabase } from '../client.js';
import { newId } from '../id.js';
import { accountBalance } from '../ledger/balance.js';
import { ensureCustomerWallet, ensureSystemAccount, findCustomerWallet } from '../ledger/index.js';
import { postJournal } from '../ledger/post-journal.js';
import { repriceProducts } from '../pricing/index.js';
import {
  auditEntries,
  creditPolicy,
  customers,
  fulfilmentAttempts,
  orders,
  telegramMessages,
} from '../schema/index.js';
import { fulfilOrderManually } from './admin-actions.js';
import { checkoutOrders } from './checkout.js';
import { creditLimitsFor, currentCreditPolicy, decideCashHold, expireCashHolds } from './credit.js';
import { liveBoard } from './live.js';
import { OrderError, type PurchaseInput, purchaseOrder } from './purchase.js';
import { adminOrder, adminOrderCounts, customerOrder } from './reads.js';
import { payWaitingOrders } from './reservations.js';
import { lockOrder, type OrderContext, type OrderRow, transitionOrder } from './transition.js';

/*
 * The credit section (S25 AM1–AM4, CL2–CL6, CS1–CS5) on PostgreSQL as the app role: amount
 * products, the limits under the recipients' and the wallet's locks, the cash hold and its
 * decisions. Each test has its own customers and numbers; a policy change appends a row and the
 * test appends the defaults again before it ends.
 */

const connection = createDatabase(process.env.DATABASE_URL as string);
const { db, pool } = connection;
const DOLLAR = CURRENCY_SCALE.USD;
const usd = (dollars: number) => Math.round(dollars * DOLLAR);
const unique = () => newId().replaceAll('-', '').slice(-12);
/** 10%, $0.01 margin: one unit of 100 new SYP costs $0.88 and sells at $0.97. */
const rule = { percentBp: 1000, fixedUsdUnits: 0, minMarginUsdUnits: 10_000 };
const codesKey = randomBytes(32);
const sent: { queue: string; data: Record<string, unknown> }[] = [];
const context = (): OrderContext => ({
  jobs: {
    send: async (_tx, queue, data) => {
      sent.push({ queue, data: data as Record<string, unknown> });
      return null;
    },
  },
  codesKey,
  now: new Date(),
});

let fake: string;
const categories: string[] = [];

beforeAll(async () => {
  const { rows } = await pool.query<{ id: string }>(`select id from suppliers where code = 'fake'`);
  fake = rows[0]?.id as string;
  await pool.query(
    `insert into supplier_credentials (id, supplier_id, ciphertext, hints, admin_id)
     select $1, $2, '\\x00', '{}', $3
     where not exists (select 1 from supplier_credentials where supplier_id = $2)`,
    [newId(), fake, newId()],
  );
});

afterAll(async () => {
  await pool.query('update catalog_categories set archived_at = now() where id = any($1::uuid[])', [
    categories,
  ]);
  await connection.close();
});

/** A customer; `funds` are credited as an old-enough refund (CS1 counts deposits only). */
async function customer(funds = 0, kind: 'refund' | 'adjustment' = 'refund') {
  const id = newId();
  await db.insert(customers).values({
    id,
    name: 'Buyer',
    email: `${id}@test.vertex-digital.local`,
    phone: '+963900000000',
    emailVerified: true,
  });
  if (funds > 0) {
    await db.transaction(async (tx) => {
      await postJournal(tx, {
        idempotencyKey: `test:${newId()}`,
        kind,
        postings: [
          { accountId: await ensureCustomerWallet(tx, id), amountUnits: funds },
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
  return id;
}

const balance = async (customerId: string) =>
  accountBalance(db, (await findCustomerWallet(db, customerId)) as string);

/**
 * A section game (`credit` or `cash`) with one `mtn_number` field and one product routed to the
 * fake supplier: an `amount` product (10–1000 units, the offer's bounds) or a `direct` pack.
 */
async function sectionProduct(
  options: {
    serviceClass?: 'credit' | 'cash';
    kind?: 'amount' | 'direct';
    cost?: number;
    offerBounds?: [number, number] | null;
  } = {},
) {
  const [category, game, id, offer, route] = [newId(), newId(), newId(), newId(), newId()];
  const kind = options.kind ?? 'amount';
  const cost = options.cost ?? 880_000;
  categories.push(category);
  await pool.query(
    'insert into catalog_categories (id, slug, name_ar, sort_order) values ($1, $2, $3, 99)',
    [category, `c-${unique()}`, `فئة ${unique()}`],
  );
  await pool.query(
    `insert into catalog_games (id, category_id, slug, name_ar, name_en, status, sort_order,
       service_class) values ($1, $2, $3, $4, 'Credit', 'active', 1, $5)`,
    [game, category, `g-${unique()}`, `رصيد ${unique()}`, options.serviceClass ?? 'credit'],
  );
  await pool.query(
    `insert into catalog_input_fields (id, game_id, key, label_ar, type, required, sort_order)
     values ($1, $2, 'recipient', 'الرقم', 'mtn_number', true, 1)`,
    [newId(), game],
  );
  await pool.query(
    kind === 'amount'
      ? `insert into catalog_products (id, game_id, kind, name_ar, max_quantity, min_quantity,
           amount_unit_ar, amount_step, sort_order) values ($1, $2, 'amount', $3, 1000, 10, 'ل.س', 100, 1)`
      : `insert into catalog_products (id, game_id, kind, name_ar, max_quantity, sort_order)
           values ($1, $2, 'direct', $3, 1, 1)`,
    [id, game, `باقة ${unique()}`],
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
  const bounds = options.offerBounds === undefined ? [10, 1000] : options.offerBounds;
  await pool.query(
    `insert into supplier_offers (id, supplier_id, offer_id, name, in_stock, cost_usd_units,
       cost_confirmed_at, last_seen_at, kind, min_quantity, max_quantity)
     values ($1, $2, $3, 'Offer', true, $4, now(), now(), $5, $6, $7)`,
    [offer, fake, `o-${unique()}@100`, cost, kind, bounds?.[0] ?? null, bounds?.[1] ?? null],
  );
  await pool.query(
    `insert into product_routes (id, product_id, supplier_id, offer_id, field_map)
     values ($1, $2, $3, $4, $5)`,
    [route, id, fake, offer, { playerId: 'recipient' }],
  );
  await db.transaction((tx) =>
    repriceProducts(tx, {
      productIds: [id],
      cause: 'route_change',
      context: { now: new Date(), fakeEnabled: true },
    }),
  );
  const { rows } = await pool.query<{ price: string }>(
    `select price_usd_units::text as price from product_prices
     where product_id = $1 and price_list_id = $2 order by created_at desc, id desc limit 1`,
    [id, ROOT_PRICE_LIST_IDS.retail],
  );
  return { id, game, offer, route, cost, price: Number(rows[0]?.price) };
}

const hash = (value: object) => createHash('sha256').update(JSON.stringify(value)).digest('hex');

/** A fresh MTN number per test, so the counts of other tests never reach it. */
const number = () => `095${String(Math.floor(Math.random() * 10_000_000)).padStart(7, '0')}`;

function request(
  customerId: string,
  item: { id: string; price: number },
  recipient: string,
  overrides: Partial<PurchaseInput> = {},
): PurchaseInput {
  return {
    customerId,
    productId: item.id,
    quantity: 10,
    fields: { recipient },
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
    if (error instanceof OrderError) return { code: error.code, details: error.details };
    throw error;
  }
  throw new Error('Expected a refusal');
};

const orderRow = async (id: string) =>
  (await db.select().from(orders).where(eq(orders.id, id)))[0] as OrderRow;

const fulfilJobs = (orderId: string) =>
  sent.filter((job) => job.queue === QUEUES.ordersFulfil && job.data.orderId === orderId);

/** Appends a policy row (the newest is in force). */
async function setPolicy(changes: Partial<CreditPolicy>) {
  const policy = { ...CREDIT_POLICY_DEFAULTS, ...changes };
  await db.insert(creditPolicy).values({ id: newId(), ...policy });
}

describe('amount products (AM1–AM4)', () => {
  it('sells the typed amount as units of 100 at the unit price, to a normalised number', async () => {
    const item = await sectionProduct();
    expect(item.price).toBe(usd(0.97));
    const buyer = await customer(usd(30));
    const { order } = await buy(request(buyer, item, '+963 955-123-456', { quantity: 20 }));
    expect(order).toMatchObject({
      kind: 'amount',
      quantity: 20,
      totalUsdUnits: usd(19.4),
      recipient: '0955123456',
      fields: { recipient: '0955123456' },
      cashHold: null,
    });
    expect(await balance(buyer)).toBe(usd(30) - usd(19.4));
    expect(fulfilJobs(order.id)).toHaveLength(1);
    const view = await customerOrder(db, buyer, order.id, 'https://store.test');
    expect(view?.product).toMatchObject({ kind: 'amount', amountStep: 100, amountUnitAr: 'ل.س' });
    expect(view?.recipient).toBe('0955123456');
  });

  it('refuses an amount below the product, beyond every route, or a number of the other operator', async () => {
    const item = await sectionProduct({ offerBounds: [10, 100] });
    const buyer = await customer(usd(20));
    expect(await refusal(buy(request(buyer, item, number(), { quantity: 9 })))).toMatchObject({
      code: 'VALIDATION_FAILED',
      details: { fields: { quantity: 'too_small' } },
    });
    expect(await refusal(buy(request(buyer, item, number(), { quantity: 101 })))).toEqual({
      code: 'PRODUCT_UNAVAILABLE',
      details: { availability: 'out_of_stock', maxQuantity: 100 },
    });
    expect(await refusal(buy(request(buyer, item, '0933123456')))).toMatchObject({
      code: 'VALIDATION_FAILED',
      details: { fields: { recipient: 'wrong_operator' } },
    });
    expect(await balance(buyer)).toBe(usd(20));
  });
});

describe('section limits (CL2–CL5)', () => {
  it('counts one number across accounts, and lets one of two racing accounts take the last order', async () => {
    const item = await sectionProduct();
    const line = number();
    for (let index = 0; index < 4; index += 1) {
      await buy(request(await customer(usd(10)), item, line));
    }
    const [first, second] = [await customer(usd(10)), await customer(usd(10))];
    const results = await Promise.allSettled([
      buy(request(first, item, line)),
      buy(request(second, item, line)),
    ]);
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    const refused = results.find((result) => result.status === 'rejected') as PromiseRejectedResult;
    expect(refused.reason).toBeInstanceOf(OrderError);
    expect(refused.reason).toMatchObject({
      code: 'RECIPIENT_DAILY_LIMIT',
      details: { recipient: line, limit: 5 },
    });
    const { rows } = await pool.query(
      `select count(*)::int as n from orders where recipient = $1`,
      [line],
    );
    expect(rows[0]?.n).toBe(5);
  });

  it("caps the customer's section at $50 a day and says what is left", async () => {
    const item = await sectionProduct();
    const buyer = await customer(usd(100));
    for (let index = 0; index < 5; index += 1) {
      await buy(request(buyer, item, number()));
    }
    expect(await refusal(buy(request(buyer, item, number())))).toEqual({
      code: 'CREDIT_DAILY_LIMIT',
      details: { remainingUsdUnits: usd(1.5) },
    });
    expect(await creditLimitsFor(db, buyer)).toMatchObject({
      sectionRemainingUsdUnits: usd(1.5),
      cashRemainingUsdUnits: usd(1.5),
    });
    expect(await balance(buyer)).toBe(usd(100) - usd(48.5));
  });

  it('counts every spelling of one number under one key (CL3)', async () => {
    const item = await sectionProduct();
    const line = number();
    const spellings = [line, line.slice(1), `963${line.slice(1)}`, `00963${line.slice(1)}`];
    for (const spelling of spellings) await buy(request(await customer(usd(10)), item, spelling));
    await buy(request(await customer(usd(10)), item, `+963 ${line.slice(1)}`));
    expect(await refusal(buy(request(await customer(usd(10)), item, line)))).toMatchObject({
      code: 'RECIPIENT_DAILY_LIMIT',
    });
  });

  it('delivers an amount order whole from the admin (AM3)', async () => {
    const item = await sectionProduct();
    const { order } = await buy(request(await customer(usd(10)), item, number()));
    await db.transaction(async (tx) => {
      const locked = (await lockOrder(tx, order.id)) as OrderRow;
      const attemptId = newId();
      await tx.insert(fulfilmentAttempts).values({
        id: attemptId,
        orderId: order.id,
        routeId: item.route,
        supplierId: fake,
        offerId: item.offer,
        supplierOfferId: 'o-test',
        quantity: locked.quantity,
        unitCostUsdUnits: item.cost,
        status: 'unknown',
        candidates: [],
        sentAt: new Date(),
      });
      const sentRow = await transitionOrder(tx, locked, 'sent_to_supplier', {
        actor: 'system',
        attemptId,
      });
      await transitionOrder(tx, sentRow as OrderRow, 'needs_review', {
        actor: 'system',
        attemptId,
      });
    });
    const partial = refusal(
      db.transaction((tx) =>
        fulfilOrderManually(tx, context(), {
          orderId: order.id,
          quantity: 5,
          codes: [],
          unitCostUsdUnits: item.cost,
          acceptLoss: false,
          proofFileId: newId(),
          reference: null,
          admin: { id: newId(), reason: 'Delivered by hand', idempotencyKey: newId() },
        }),
      ),
    );
    expect(await partial).toMatchObject({ code: 'VALIDATION_FAILED' });
  });

  it('counts a checkout as a whole', async () => {
    const item = await sectionProduct();
    const buyer = await customer(usd(60));
    const line = number();
    const lines = Array.from({ length: 6 }, () => ({
      productId: item.id,
      quantity: 10,
      fields: { recipient: line },
      expectedUnitPriceUsdUnits: item.price,
      confirmPlayer: false,
    }));
    const checkout = (count: number) =>
      db.transaction((tx) =>
        checkoutOrders(tx, context(), {
          customerId: buyer,
          lines: lines.slice(0, count),
          idempotencyKey: newId(),
          requestHash: hash({ count }),
          fakeEnabled: true,
          purchasesStopped: false,
          channel: 'store',
          playerCheck: async () => null,
        }),
      );
    expect(await refusal(checkout(6))).toMatchObject({ code: 'RECIPIENT_DAILY_LIMIT' });
    expect((await checkout(5)).orders.every((order) => order.recipient === line)).toBe(true);
  });

  it('alerts once a day when a third account tops up one number (CL4)', async () => {
    const item = await sectionProduct();
    const line = number();
    for (let index = 0; index < 4; index += 1) {
      await buy(request(await customer(usd(10)), item, line));
    }
    const alerts = await db
      .select()
      .from(telegramMessages)
      .where(
        and(
          eq(telegramMessages.kind, 'credit_recipient_alert'),
          sql`${telegramMessages.params}->>'recipientMasked' = ${`09X XXX XX${line.slice(-2)}`}`,
        ),
      );
    expect(alerts).toHaveLength(1);
    const params = alerts[0]?.params as { days: number; accounts: unknown[] };
    expect(params.days).toBe(7);
    expect(params.accounts).toHaveLength(3);
    expect(alerts[0]?.dedupeKey).not.toContain(line);
  });
});

describe('cash (CS1–CS5)', () => {
  it('pays only from balance credited before the age, and is never reserved', async () => {
    const item = await sectionProduct({ serviceClass: 'cash' });
    const fresh = await customer(usd(10), 'adjustment');
    const refused = await refusal(buy(request(fresh, item, number())));
    expect(refused).toMatchObject({
      code: 'CASH_BALANCE_TOO_RECENT',
      details: { eligibleUsdUnits: 0, eligibleMoreAt: expect.any(String) },
    });
    const poor = await customer();
    expect(
      await refusal(buy(request(poor, item, number(), { whenBalanceShort: 'reserve' }))),
    ).toMatchObject({ code: 'CASH_BALANCE_TOO_RECENT' });
  });

  it('holds nothing at $10 and caps cash at $20 a day', async () => {
    const item = await sectionProduct({ serviceClass: 'cash' });
    const buyer = await customer(usd(40));
    const small = await buy(request(buyer, item, number()));
    expect(small.order).toMatchObject({ cashHold: null, totalUsdUnits: usd(9.7) });
    expect(fulfilJobs(small.order.id)).toHaveLength(1);
    const second = await buy(request(buyer, item, number()));
    expect(second.order.cashHold).toBeNull();
    expect(await refusal(buy(request(buyer, item, number())))).toEqual({
      code: 'CASH_DAILY_LIMIT',
      details: { remainingUsdUnits: usd(0.6) },
    });
  });

  it('holds a cash order above the threshold, then approves or rejects it once', async () => {
    const item = await sectionProduct({ serviceClass: 'cash' });
    const buyer = await customer(usd(40));
    const { order } = await buy(request(buyer, item, number(), { quantity: 11 }));
    expect(order).toMatchObject({ cashHold: 'held', totalUsdUnits: usd(10.67) });
    expect(fulfilJobs(order.id)).toHaveLength(0);
    const [audit] = await db
      .select()
      .from(auditEntries)
      .where(and(eq(auditEntries.entityId, order.id), eq(auditEntries.action, 'order.paid')));
    expect(audit?.details).toMatchObject({ cashHeld: true });
    const [card] = await db
      .select()
      .from(telegramMessages)
      .where(eq(telegramMessages.dedupeKey, `cash-hold:${order.id}`));
    expect(card?.params).toMatchObject({
      orderId: order.id,
      totalUsdUnits: usd(10.67),
      telegramDecides: true,
    });
    expect((await adminOrderCounts(db)).cashHeld).toBeGreaterThan(0);
    const board = await liveBoard(db, { test: 'all' }, new Date());
    expect(board.columns.cash_hold.cards.map((card) => card.id)).toContain(order.id);
    expect((await adminOrder(db, order.id))?.cashHold).toMatchObject({
      state: 'held',
      decidedAt: null,
      telegramDecides: true,
    });

    const admin = { kind: 'admin', adminId: newId(), channel: 'admin' } as const;
    const decide = (decision: 'approve' | 'reject') =>
      db.transaction((tx) =>
        decideCashHold(tx, context(), { orderId: order.id, decision, by: admin }),
      );
    const results = await Promise.allSettled([decide('approve'), decide('reject')]);
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    const decided = await orderRow(order.id);
    if (decided.cashHold === 'approved') {
      expect(decided.status).toBe('paid');
      expect(fulfilJobs(order.id)).toHaveLength(1);
      expect(await balance(buyer)).toBe(usd(40) - usd(10.67));
    } else {
      expect(decided).toMatchObject({ cashHold: 'rejected', status: 'refunded' });
      expect(decided.refundReason).toBe('cash_rejected');
      expect(await balance(buyer)).toBe(usd(40));
    }
    expect(await refusal(decide('approve'))).toMatchObject({ code: 'ORDER_NOT_DECIDABLE' });
  });

  it('rejects a hold with its refund journal and audit entry', async () => {
    const item = await sectionProduct({ serviceClass: 'cash' });
    const buyer = await customer(usd(20));
    const { order } = await buy(request(buyer, item, number(), { quantity: 11 }));
    const adminId = newId();
    const rejected = await db.transaction((tx) =>
      decideCashHold(tx, context(), {
        orderId: order.id,
        decision: 'reject',
        reason: 'حساب جديد',
        by: { kind: 'admin', adminId, channel: 'telegram' },
      }),
    );
    expect(rejected).toMatchObject({
      status: 'refunded',
      cashHold: 'rejected',
      cashHoldAdminId: adminId,
    });
    expect(await balance(buyer)).toBe(usd(20));
    const [audit] = await db
      .select()
      .from(auditEntries)
      .where(
        and(eq(auditEntries.entityId, order.id), eq(auditEntries.action, 'order.cash_rejected')),
      );
    expect(audit).toMatchObject({
      channel: 'telegram',
      reason: 'حساب جديد',
      details: { expired: false, journalId: rejected.refundJournalId },
    });
  });
});

describe('the Telegram ceiling (CS4)', () => {
  it('lets Telegram decide only up to the ceiling; above it the hold waits for the panel', async () => {
    const item = await sectionProduct({ serviceClass: 'cash' });
    const buyer = await customer(usd(20));
    const { order } = await buy(request(buyer, item, number(), { quantity: 11 }));
    const telegram = { kind: 'admin', adminId: newId(), channel: 'telegram' } as const;
    try {
      await setPolicy({ cashTelegramCeilingUsdUnits: usd(10) });
      sent.length = 0;
      expect(
        await refusal(
          db.transaction((tx) =>
            decideCashHold(tx, context(), { orderId: order.id, decision: 'approve', by: telegram }),
          ),
        ),
      ).toEqual({ code: 'ORDER_NOT_DECIDABLE', details: { reason: 'panel_only' } });
      expect(await orderRow(order.id)).toMatchObject({ status: 'paid', cashHold: 'held' });
      expect(fulfilJobs(order.id)).toHaveLength(0);
    } finally {
      await setPolicy({});
    }
    const approved = await db.transaction((tx) =>
      decideCashHold(tx, context(), { orderId: order.id, decision: 'approve', by: telegram }),
    );
    expect(approved.cashHold).toBe('approved');
  });
});

describe('policy changes (CS5, CL6)', () => {
  it('expires holds past the policy hours, and cancels a reservation a limit now refuses', async () => {
    const cash = await sectionProduct({ serviceClass: 'cash' });
    const buyer = await customer(usd(20));
    const { order } = await buy(request(buyer, cash, number(), { quantity: 11 }));

    const credit = await sectionProduct();
    const waiting = await customer();
    const reserved = await buy(request(waiting, credit, number(), { whenBalanceShort: 'reserve' }));
    expect(reserved.order.status).toBe('awaiting_balance');

    try {
      await setPolicy({ cashHoldHours: 0, retailDailyUsdUnits: usd(4) });
      expect(await currentCreditPolicy(db)).toMatchObject({ cashHoldHours: 0 });
      expect(await expireCashHolds(db, context(), 50)).toContain(order.id);
      expect(await orderRow(order.id)).toMatchObject({
        cashHold: 'expired',
        status: 'refunded',
        cashHoldAdminId: null,
      });
      expect(await balance(buyer)).toBe(usd(20));
      expect(await expireCashHolds(db, context(), 50)).not.toContain(order.id);

      await db.transaction(async (tx) => {
        await postJournal(tx, {
          idempotencyKey: `test:${newId()}`,
          kind: 'refund',
          postings: [
            { accountId: await ensureCustomerWallet(tx, waiting), amountUnits: usd(10) },
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
      const paid = await payWaitingOrders(
        db,
        { jobs: context().jobs, now: () => new Date(), fakeEnabled: true },
        waiting,
      );
      expect(paid.outcomes).toEqual([
        { orderId: reserved.order.id, outcome: 'cancelled_limit_reached' },
      ]);
      expect(await orderRow(reserved.order.id)).toMatchObject({
        status: 'cancelled',
        cancelReason: 'limit_reached',
      });
    } finally {
      await setPolicy({});
    }
    const [newest] = await db
      .select()
      .from(creditPolicy)
      .orderBy(desc(creditPolicy.createdAt))
      .limit(1);
    expect(newest?.cashHoldHours).toBe(CREDIT_POLICY_DEFAULTS.cashHoldHours);
  });
});
