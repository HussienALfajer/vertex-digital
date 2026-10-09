import { describe, expect, it } from 'vitest';
import type { InputField } from './catalog.js';
import {
  ADMIN_ORDER_TAB_STATUSES,
  adminOrderListQuerySchema,
  availabilityForCustomer,
  type CandidateOrder,
  type CandidateRoute,
  canTransitionOrder,
  cleanPlayerName,
  codeHint,
  costOfGoods,
  createOrderSchema,
  deliveredCodeSchema,
  deliveryStats,
  firstPollAt,
  isOpenAttempt,
  isTerminalOrderStatus,
  manualReminderAt,
  maskCode,
  nextPollAt,
  ORDER_POLICY_DEFAULTS,
  ORDER_STATUSES,
  ORDER_TRANSITIONS,
  type OrderStatus,
  orderCandidates,
  orderCustomerStage,
  orderDecisions,
  orderFieldValuesSchema,
  orderNumberSchema,
  orderPolicySchema,
  orderStatusSchema,
  orderTimeline,
  orderTotal,
  pastHardLimit,
  playerCheckRequestSchema,
  playerCheckSchema,
  refundAmount,
  reservationCharge,
  resolveAttemptSchema,
  routeProfitable,
} from './orders.js';

/** ADR 0004's transition table, plus `paid → refunded` (ADR 0013), written out independently. */
const ALLOWED = new Set([
  'awaiting_balance → paid',
  'awaiting_balance → cancelled',
  'paid → sent_to_supplier',
  'paid → refunded',
  'sent_to_supplier → delivered',
  'sent_to_supplier → failed',
  'sent_to_supplier → needs_review',
  'failed → sent_to_supplier',
  'failed → refunded',
  'failed → partially_refunded',
  'needs_review → delivered',
  'needs_review → sent_to_supplier',
  'needs_review → refunded',
  'needs_review → partially_refunded',
]);

describe('order transitions', () => {
  it('allows exactly the transitions of ADR 0004 and ADR 0013, across all 81 pairs', () => {
    const mismatches = ORDER_STATUSES.flatMap((from) =>
      ORDER_STATUSES.filter(
        (to) => canTransitionOrder(from, to) !== ALLOWED.has(`${from} → ${to}`),
      ).map((to) => `${from} → ${to}`),
    );
    expect(ORDER_STATUSES).toHaveLength(9);
    expect(mismatches).toEqual([]);
  });

  it('ends in delivered, partially_refunded, refunded or cancelled', () => {
    expect(ORDER_STATUSES.filter(isTerminalOrderStatus)).toEqual([
      'delivered',
      'partially_refunded',
      'refunded',
      'cancelled',
    ]);
  });

  it('can reach a terminal status from every status: no order is stuck by design', () => {
    const reachesEnd = (status: OrderStatus, seen: Set<OrderStatus>): boolean =>
      isTerminalOrderStatus(status) ||
      ORDER_TRANSITIONS[status].some(
        (next) => !seen.has(next) && reachesEnd(next, new Set([...seen, next])),
      );
    expect(ORDER_STATUSES.filter((status) => !reachesEnd(status, new Set([status])))).toEqual([]);
  });

  it('never returns an order to awaiting_balance or to cancelled once paid', () => {
    const sources = ORDER_STATUSES.filter(
      (from) =>
        canTransitionOrder(from, 'awaiting_balance') ||
        (from !== 'awaiting_balance' && canTransitionOrder(from, 'cancelled')),
    );
    expect(sources).toEqual([]);
  });

  it('knows only the order statuses', () => {
    expect(orderStatusSchema.safeParse('paid').success).toBe(true);
    expect(orderStatusSchema.safeParse('shipped').success).toBe(false);
  });
});

describe('customer stages (rule O13)', () => {
  it('maps every status to a stage, hiding the internal ones', () => {
    expect(Object.fromEntries(ORDER_STATUSES.map((s) => [s, orderCustomerStage(s)]))).toEqual({
      awaiting_balance: 'awaiting_balance',
      paid: 'processing',
      sent_to_supplier: 'processing',
      failed: 'processing',
      needs_review: 'delayed',
      delivered: 'delivered',
      partially_refunded: 'partially_refunded',
      refunded: 'refunded',
      cancelled: 'cancelled',
    });
  });
});

describe('order timeline (S09 rule LT1)', () => {
  const at = (minute: number) => new Date(Date.UTC(2026, 9, 9, 10, minute));

  it('turns a reservation paid and delivered into its steps', () => {
    expect(
      orderTimeline([
        { status: 'awaiting_balance', at: at(0) },
        { status: 'paid', at: at(5) },
        { status: 'sent_to_supplier', at: at(6) },
        { status: 'delivered', at: at(7) },
      ]),
    ).toEqual([
      { step: 'reserved', at: at(0) },
      { step: 'paid', at: at(5) },
      { step: 'sent', at: at(6) },
      { step: 'delivered', at: at(7) },
    ]);
  });

  it('collapses retries to the newest, hides failed and moves a repeated delay', () => {
    expect(
      orderTimeline([
        { status: 'paid', at: at(0) },
        { status: 'sent_to_supplier', at: at(1) },
        { status: 'failed', at: at(2) },
        { status: 'sent_to_supplier', at: at(3) },
        { status: 'needs_review', at: at(30) },
        { status: 'sent_to_supplier', at: at(40) },
        { status: 'needs_review', at: at(70) },
        { status: 'partially_refunded', at: at(90) },
      ]),
    ).toEqual([
      { step: 'paid', at: at(0) },
      { step: 'sent', at: at(1) },
      { step: 'retrying', at: at(40) },
      { step: 'delayed', at: at(70) },
      { step: 'partially_refunded', at: at(90) },
    ]);
  });

  it('gives each terminal status its own step', () => {
    expect(
      orderTimeline([
        { status: 'awaiting_balance', at: at(0) },
        { status: 'cancelled', at: at(9) },
      ]),
    ).toEqual([
      { step: 'reserved', at: at(0) },
      { step: 'cancelled', at: at(9) },
    ]);
    expect(
      orderTimeline([
        { status: 'paid', at: at(0) },
        { status: 'refunded', at: at(1) },
      ]),
    ).toEqual([
      { step: 'paid', at: at(0) },
      { step: 'refunded', at: at(1) },
    ]);
    expect(orderTimeline([])).toEqual([]);
  });
});

describe('reservations and player checks (S09)', () => {
  it('charges the lower unit price, the saved one on a tie (rule RS6)', () => {
    expect(reservationCharge(1_000_000, 900_000)).toEqual({
      unitPriceUsdUnits: 900_000,
      source: 'current',
    });
    expect(reservationCharge(1_000_000, 1_100_000)).toEqual({
      unitPriceUsdUnits: 1_000_000,
      source: 'saved',
    });
    expect(reservationCharge(1_000_000, 1_000_000)).toEqual({
      unitPriceUsdUnits: 1_000_000,
      source: 'saved',
    });
  });

  it('keeps a supplier name printable, trimmed and at most 64 characters', () => {
    expect(cleanPlayerName('  Hero\u0000 \u200e Ace\n ')).toBe('Hero Ace');
    expect(cleanPlayerName('ب'.repeat(70))).toBe('ب'.repeat(64));
    expect(cleanPlayerName('\u0007')).toBeNull();
    expect(cleanPlayerName(null)).toBeNull();
    expect(cleanPlayerName(undefined)).toBeNull();
  });

  it('defaults the purchase to refusing a short balance without a confirmation', () => {
    const request = {
      productId: '0199a000-0000-7000-8000-000000000001',
      quantity: 1,
      expectedUnitPriceUsdUnits: 1_000_000,
    };
    expect(createOrderSchema.parse(request)).toMatchObject({
      whenBalanceShort: 'refuse',
      confirmPlayer: false,
    });
    expect(
      createOrderSchema.parse({ ...request, whenBalanceShort: 'reserve', confirmPlayer: true }),
    ).toMatchObject({
      whenBalanceShort: 'reserve',
      confirmPlayer: true,
    });
    expect(createOrderSchema.safeParse({ ...request, whenBalanceShort: 'hold' }).success).toBe(
      false,
    );
  });

  it('checks a player with the product and its fields, and answers by result (rule PV6)', () => {
    expect(
      playerCheckRequestSchema.parse({ productId: '0199a000-0000-7000-8000-000000000001' }),
    ).toEqual({ productId: '0199a000-0000-7000-8000-000000000001', fields: {} });
    expect(playerCheckSchema.safeParse({ result: 'valid', playerName: null }).success).toBe(true);
    expect(playerCheckSchema.safeParse({ result: 'unavailable', reason: 'quota' }).success).toBe(
      true,
    );
    expect(playerCheckSchema.safeParse({ result: 'unavailable', reason: 'busy' }).success).toBe(
      false,
    );
  });
});

describe('money of an order (rules M1–M3)', () => {
  it('multiplies exactly and refuses what is not a safe integer', () => {
    expect(orderTotal(1_230_000, 3)).toBe(3_690_000);
    expect(refundAmount(1_230_000, 0)).toBe(0);
    expect(costOfGoods(880_123, 7)).toBe(6_160_861);
    expect(() => orderTotal(Number.MAX_SAFE_INTEGER, 2)).toThrow(RangeError);
    expect(() => orderTotal(-1, 1)).toThrow(RangeError);
    expect(() => orderTotal(1.5, 1)).toThrow(RangeError);
    expect(() => refundAmount(1, -1)).toThrow(RangeError);
    expect(() => costOfGoods(1, 0.5)).toThrow(RangeError);
  });

  it('keeps the margin guard at its boundary (ADR 0020)', () => {
    expect(routeProfitable(1_000_000, 900_000, 100_000)).toBe(true);
    expect(routeProfitable(1_000_000, 900_001, 100_000)).toBe(false);
    expect(routeProfitable(1_000_000, 1_000_000, 0)).toBe(true);
  });
});

describe('routing candidates (rules R2, R4)', () => {
  const route = (id: string, overrides: Partial<CandidateRoute> = {}): CandidateRoute => ({
    id: `0199a000-0000-7000-8000-00000000000${id}`,
    supplierCode: 'fake',
    health: 'healthy',
    costUsdUnits: 800_000,
    priority: 1,
    unusableReason: null,
    balanceUsdUnits: null,
    ...overrides,
  });
  const order: CandidateOrder = {
    unitPriceUsdUnits: 1_000_000,
    minMarginUsdUnits: 100_000,
    remainingUnits: 2,
    isTestCustomer: false,
    triedRouteIds: [],
  };

  it('ranks by tier then cost, and gives every other route its reason', () => {
    const routes = [
      route('1', { supplierCode: 'manual', costUsdUnits: 500_000 }),
      route('2', { supplierCode: 'wdgzone', health: 'degraded', costUsdUnits: 700_000 }),
      route('3', { supplierCode: 'shop2topup', costUsdUnits: 850_000 }),
      route('4', { supplierCode: 'fake', unusableReason: 'archived' }),
      route('5', { supplierCode: 'fake', costUsdUnits: 950_000 }),
    ];
    const result = orderCandidates(routes, order);
    expect(result.map((c) => [c.routeId.slice(-1), c.rank, c.tier, c.skipReason])).toEqual([
      ['3', 1, 'healthy', null],
      ['2', 2, 'degraded', null],
      ['1', 3, 'manual', null],
      ['4', null, null, 'archived'],
      ['5', null, 'healthy', 'unprofitable'],
    ]);
  });

  it('skips tried routes, routes a supplier cannot pay for, and real suppliers for test customers', () => {
    const routes = [
      route('1'),
      route('2', { supplierCode: 'shop2topup' }),
      route('3', { supplierCode: 'wdgzone', balanceUsdUnits: 1_599_999 }),
      route('4', { supplierCode: 'manual', balanceUsdUnits: 1_600_000 }),
    ];
    const tried = { ...order, triedRouteIds: [routes[0]?.id as string] };
    expect(orderCandidates(routes, tried).map((c) => c.skipReason)).toEqual([
      null,
      null,
      'already_tried',
      'balance_below_order',
    ]);
    const test = { ...order, isTestCustomer: true };
    expect(orderCandidates(routes, test).map((c) => [c.routeId.slice(-1), c.skipReason])).toEqual([
      ['1', null],
      ['4', null],
      ['2', 'test_customer'],
      ['3', 'test_customer'],
    ]);
    expect(orderCandidates([], order)).toEqual([]);
  });

  it("computes a test customer's availability over the test routes only (rule O3)", () => {
    const facts = {
      categoryArchived: false,
      gameArchived: false,
      productArchived: false,
      gameStatus: 'active' as const,
      productStatus: 'active' as const,
      price: { priceUsdUnits: 1_000_000, minMarginUsdUnits: 100_000 },
    };
    const routes = [{ supplierCode: 'shop2topup' as const, costUsdUnits: 800_000 }];
    expect(availabilityForCustomer(facts, routes, false)).toBe('available');
    expect(availabilityForCustomer(facts, routes, true)).toBe('out_of_stock');
  });
});

describe('polling times (rule F7, MN2)', () => {
  const sent = new Date(Date.UTC(2026, 9, 9, 10, 0));
  const plus = (ms: number) => new Date(sent.getTime() + ms);
  const minute = 60_000;
  const policy = ORDER_POLICY_DEFAULTS;

  it('polls first after firstPollSeconds, then fast, slow and review intervals', () => {
    expect(firstPollAt(sent, policy)).toEqual(plus(minute));
    expect(nextPollAt(sent, plus(minute), policy)).toEqual(plus(2 * minute));
    expect(nextPollAt(sent, plus(10 * minute - 1), policy)).toEqual(plus(11 * minute - 1));
    expect(nextPollAt(sent, plus(10 * minute), policy)).toEqual(plus(15 * minute));
    expect(nextPollAt(sent, plus(30 * minute - 1), policy)).toEqual(plus(35 * minute - 1));
    expect(nextPollAt(sent, plus(30 * minute), policy)).toEqual(plus(60 * minute));
    const end = 30 * minute + 24 * 60 * minute;
    expect(nextPollAt(sent, plus(end - 1), policy)).toEqual(plus(end - 1 + 30 * minute));
    expect(nextPollAt(sent, plus(end), policy)).toBeNull();
  });

  it('holds an attempt at the hard limit, not before', () => {
    expect(pastHardLimit(sent, plus(30 * minute - 1), policy)).toBe(false);
    expect(pastHardLimit(sent, plus(30 * minute), policy)).toBe(true);
  });

  it('reminds of a manual attempt once, after manualReminderMinutes', () => {
    expect(manualReminderAt(sent, policy)).toEqual(plus(15 * minute));
  });

  it('accepts the policy within its bounds', () => {
    expect(orderPolicySchema.parse(policy)).toEqual(policy);
    expect(orderPolicySchema.safeParse({ ...policy, firstPollSeconds: 14 }).success).toBe(false);
    expect(orderPolicySchema.safeParse({ ...policy, reviewPollHours: 73 }).success).toBe(false);
  });
});

describe('delivery time (rule T1)', () => {
  it('is null under five orders, then median and p90 by nearest rank', () => {
    expect(deliveryStats([1, 2, 3, 4])).toBeNull();
    expect(deliveryStats([5, 1, 4, 2, 3])).toEqual({ medianMs: 3, p90Ms: 5, count: 5 });
    const ten = Array.from({ length: 10 }, (_, index) => (index + 1) * 1_000);
    expect(deliveryStats(ten)).toEqual({ medianMs: 5_000, p90Ms: 9_000, count: 10 });
  });
});

describe('order numbers and codes', () => {
  it('accepts an order number in any case, with or without its dash', () => {
    expect(orderNumberSchema.parse('vo-7kq2mx')).toBe('VO-7KQ2MX');
    expect(orderNumberSchema.parse(' VO7KQ2MX ')).toBe('VO-7KQ2MX');
    expect(orderNumberSchema.safeParse('VO-7KQ2M0').success).toBe(false);
    expect(orderNumberSchema.safeParse('VD-7KQ2MX').success).toBe(false);
  });

  it('masks a code with its hint only when it is long enough (rule C3)', () => {
    expect(codeHint('ABCD-EFGH-1234')).toBe('1234');
    expect(codeHint('SHORT-CODE1')).toBeNull();
    expect(maskCode('1234')).toBe('••••••1234');
    expect(maskCode(null)).toBe('••••••••');
  });

  it('takes typed codes of printable characters (rule D2)', () => {
    expect(deliveredCodeSchema.parse('  XYZ-1  ')).toBe('XYZ-1');
    expect(deliveredCodeSchema.safeParse('a\nb').success).toBe(false);
    expect(deliveredCodeSchema.safeParse('').success).toBe(false);
  });
});

describe('order field values (rule O5, S06 CT7)', () => {
  const field = (overrides: Partial<InputField>): InputField => ({
    id: '0199a000-0000-7000-8000-000000000001',
    gameId: '0199a000-0000-7000-8000-000000000002',
    key: 'player_id',
    labelAr: 'معرف اللاعب',
    helpAr: null,
    type: 'digits',
    required: true,
    minLength: null,
    maxLength: null,
    options: null,
    sortOrder: 1,
    archivedAt: null,
    createdAt: '2026-10-09T10:00:00.000Z',
    updatedAt: '2026-10-09T10:00:00.000Z',
    ...overrides,
  });
  const schema = orderFieldValuesSchema([
    field({ minLength: 5, maxLength: 12 }),
    field({ key: 'nickname', type: 'text', required: false }),
    field({ key: 'phone', type: 'phone', required: false }),
    field({
      key: 'server',
      type: 'select',
      options: [
        { value: 'eu', labelAr: 'أوروبا' },
        { value: 'asia', labelAr: 'آسيا' },
      ],
    }),
  ]);

  it('trims, normalizes and leaves out empty optional fields', () => {
    expect(
      schema.parse({
        player_id: ' 5123456789 ',
        nickname: '  ',
        phone: '0944 123 456',
        server: 'eu',
      }),
    ).toEqual({ player_id: '5123456789', phone: '+963944123456', server: 'eu' });
    expect(schema.parse({ player_id: '51234', server: 'asia', nickname: ' Abu ' })).toEqual({
      player_id: '51234',
      server: 'asia',
      nickname: 'Abu',
    });
  });

  it('refuses a missing required field, a wrong value and an unknown key, by key', () => {
    const paths = (values: Record<string, string>) =>
      schema.safeParse(values).error?.issues.map((issue) => issue.path[0] ?? issue.code);
    expect(paths({ server: 'eu' })).toEqual(['player_id']);
    expect(paths({ player_id: '12a45', server: 'eu' })).toEqual(['player_id']);
    expect(paths({ player_id: '1234', server: 'eu' })).toEqual(['player_id']);
    expect(paths({ player_id: '12345', server: 'us' })).toEqual(['server']);
    expect(paths({ player_id: '12345', server: 'eu', nickname: 'a\u0007' })).toEqual(['nickname']);
    expect(paths({ player_id: '12345', server: 'eu', zone: '1' })).toEqual(['unrecognized_keys']);
    expect(
      orderFieldValuesSchema([field({ type: 'select', options: null })]).safeParse({
        player_id: 'x',
      }).success,
    ).toBe(false);
  });

  it('bounds the purchase request', () => {
    const request = {
      productId: '0199a000-0000-7000-8000-000000000003',
      quantity: 1,
      expectedUnitPriceUsdUnits: 1_230_000,
    };
    expect(createOrderSchema.parse(request)).toEqual({
      ...request,
      fields: {},
      whenBalanceShort: 'refuse',
      confirmPlayer: false,
    });
    expect(createOrderSchema.safeParse({ ...request, quantity: 51 }).success).toBe(false);
    expect(createOrderSchema.safeParse({ ...request, expectedUnitPriceUsdUnits: 1 }).success).toBe(
      false,
    );
    const eleven = Object.fromEntries(Array.from({ length: 11 }, (_, i) => [`f${i}`, 'x']));
    expect(createOrderSchema.safeParse({ ...request, fields: eleven }).success).toBe(false);
  });
});

describe('admin decisions (rule D1)', () => {
  const automatic = { id: '0199a000-0000-7000-8000-000000000004', supplierCode: 'fake' as const };
  const manual = { ...automatic, supplierCode: 'manual' as const };

  it('allows polling, resolving and refunding a held order', () => {
    expect(orderDecisions('needs_review', automatic)).toEqual({
      attemptId: automatic.id,
      poll: true,
      resolve: true,
      refund: true,
    });
    expect(orderDecisions('needs_review', null)).toEqual({
      attemptId: null,
      poll: false,
      resolve: false,
      refund: true,
    });
  });

  it('allows resolving an open manual attempt, and nothing else', () => {
    expect(orderDecisions('sent_to_supplier', manual)).toEqual({
      attemptId: manual.id,
      poll: false,
      resolve: true,
      refund: false,
    });
    expect(orderDecisions('sent_to_supplier', automatic)).toEqual({
      attemptId: automatic.id,
      poll: false,
      resolve: false,
      refund: false,
    });
    expect(orderDecisions('delivered', null).refund).toBe(false);
  });

  it('parses a resolution by its outcome', () => {
    expect(
      resolveAttemptSchema.parse({ outcome: 'delivered', quantity: 2, reason: 'سلّمت يدوياً' }),
    ).toEqual({
      outcome: 'delivered',
      quantity: 2,
      codes: [],
      reason: 'سلّمت يدوياً',
    });
    expect(resolveAttemptSchema.safeParse({ outcome: 'failed', reason: 'قصير' }).success).toBe(
      false,
    );
  });

  it('knows open attempts and the tabs of the list', () => {
    expect(isOpenAttempt('unknown')).toBe(true);
    expect(isOpenAttempt('failed')).toBe(false);
    expect(ADMIN_ORDER_TAB_STATUSES.refunded).toEqual(['partially_refunded', 'refunded']);
    expect(adminOrderListQuerySchema.parse({})).toEqual({ tab: 'all', page: 1, pageSize: 50 });
  });
});
