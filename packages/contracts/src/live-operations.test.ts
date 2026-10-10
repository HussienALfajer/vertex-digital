import { describe, expect, it } from 'vitest';
import {
  ATTENTION_KINDS,
  attentionItemSchema,
  compared,
  damascusDayBounds,
  deltaPercent,
  marginPercent,
} from './dashboard.js';
import { zoneDayStart } from './deposits.js';
import { CURRENCY_SCALE } from './money.js';
import {
  FULFIL_COST_MAX_USD_UNITS,
  fulfilIsLoss,
  fulfilOrderSchema,
  LIVE_FINISHED_MINUTES,
  liveBoardQuerySchema,
  liveColumn,
  ORDER_STATUSES,
  rerouteOrderSchema,
  SLOW_DEFAULT_SECONDS,
  SLOW_FLOOR_SECONDS,
  slowAfterSeconds,
} from './orders.js';

const now = new Date('2030-03-10T12:00:00Z');
const manual = { supplierCode: 'manual' as const };
const fake = { supplierCode: 'fake' as const };

describe('live columns (S11 rule LR1)', () => {
  it('places every status', () => {
    const recent = new Date(now.getTime() - 5 * 60_000);
    const expected = {
      awaiting_balance: null,
      paid: 'at_supplier',
      sent_to_supplier: 'at_supplier',
      failed: 'at_supplier',
      needs_review: 'review',
      delivered: 'finished',
      partially_refunded: 'finished',
      refunded: 'finished',
      cancelled: null,
    } as const;
    for (const status of ORDER_STATUSES) {
      expect(liveColumn({ status, finishedAt: recent }, fake, now), status).toBe(expected[status]);
    }
  });

  it('puts an open manual attempt in its own column', () => {
    expect(liveColumn({ status: 'sent_to_supplier', finishedAt: null }, manual, now)).toBe(
      'manual',
    );
    expect(liveColumn({ status: 'sent_to_supplier', finishedAt: null }, null, now)).toBe(
      'at_supplier',
    );
    expect(liveColumn({ status: 'needs_review', finishedAt: null }, manual, now)).toBe('review');
  });

  it('keeps finished orders for an hour', () => {
    const at = (minutes: number) => new Date(now.getTime() - minutes * 60_000);
    expect(
      liveColumn({ status: 'delivered', finishedAt: at(LIVE_FINISHED_MINUTES) }, null, now),
    ).toBe('finished');
    expect(
      liveColumn({ status: 'delivered', finishedAt: at(LIVE_FINISHED_MINUTES + 1) }, null, now),
    ).toBeNull();
    expect(liveColumn({ status: 'refunded', finishedAt: null }, null, now)).toBeNull();
  });
});

describe('slow orders (S11 rule LR3)', () => {
  it('waits 10 minutes without stats', () => {
    expect(slowAfterSeconds(null)).toBe(SLOW_DEFAULT_SECONDS);
  });

  it('uses the p90, rounded up, with a floor of 2 minutes', () => {
    expect(slowAfterSeconds({ medianMs: 1_000, p90Ms: 5_000, count: 10 })).toBe(SLOW_FLOOR_SECONDS);
    expect(slowAfterSeconds({ medianMs: 1_000, p90Ms: 120_000, count: 10 })).toBe(120);
    expect(slowAfterSeconds({ medianMs: 1_000, p90Ms: 180_001, count: 10 })).toBe(181);
  });
});

describe('live board query', () => {
  it('defaults to every order and refuses unknown filters', () => {
    expect(liveBoardQuerySchema.parse({})).toEqual({ test: 'all' });
    expect(liveBoardQuerySchema.safeParse({ test: 'some' }).success).toBe(false);
    expect(liveBoardQuerySchema.safeParse({ supplier: 'nobody' }).success).toBe(false);
  });
});

describe('reroute and manual fulfil requests (S11 rules RR3, MF2–MF4)', () => {
  const proofFileId = '0199a000-0000-7000-8000-000000000010';
  const base = { quantity: 1, unitCostUsdUnits: 800_000, proofFileId, reason: 'سلّمت من مصدر آخر' };

  it('needs a reason of 5–500 characters', () => {
    const routeId = '0199a000-0000-7000-8000-000000000011';
    expect(rerouteOrderSchema.safeParse({ routeId, reason: 'قصير' }).success).toBe(false);
    expect(rerouteOrderSchema.safeParse({ routeId, reason: 'المورد متوقف' }).success).toBe(true);
    expect(rerouteOrderSchema.safeParse({ routeId, reason: 'x'.repeat(501) }).success).toBe(false);
  });

  it('takes a cost in whole cents from 0 to $100,000', () => {
    expect(fulfilOrderSchema.parse({ ...base, unitCostUsdUnits: 0 })).toMatchObject({
      unitCostUsdUnits: 0,
      acceptLoss: false,
      codes: [],
    });
    expect(
      fulfilOrderSchema.safeParse({ ...base, unitCostUsdUnits: FULFIL_COST_MAX_USD_UNITS }).success,
    ).toBe(true);
    expect(
      fulfilOrderSchema.safeParse({ ...base, unitCostUsdUnits: FULFIL_COST_MAX_USD_UNITS + 10_000 })
        .success,
    ).toBe(false);
    expect(fulfilOrderSchema.safeParse({ ...base, unitCostUsdUnits: 800_001 }).success).toBe(false);
    expect(fulfilOrderSchema.safeParse({ ...base, unitCostUsdUnits: -10_000 }).success).toBe(false);
  });

  it('takes a reference of 1–200 printable characters and codes of 1–200', () => {
    expect(fulfilOrderSchema.parse({ ...base, reference: ' OP-123 ' }).reference).toBe('OP-123');
    expect(fulfilOrderSchema.safeParse({ ...base, reference: 'x'.repeat(201) }).success).toBe(
      false,
    );
    expect(fulfilOrderSchema.safeParse({ ...base, reference: 'a\nb' }).success).toBe(false);
    expect(fulfilOrderSchema.safeParse({ ...base, codes: ['x'.repeat(201)] }).success).toBe(false);
    expect(fulfilOrderSchema.safeParse({ ...base, proofFileId: 'nope' }).success).toBe(false);
  });

  it('asks to confirm a cost above the price', () => {
    const price = CURRENCY_SCALE.USD;
    expect(fulfilIsLoss(price + 10_000, price)).toBe(true);
    expect(fulfilIsLoss(price, price)).toBe(false);
    expect(fulfilIsLoss(0, price)).toBe(false);
  });
});

describe('Damascus days (S11 rule DB1)', () => {
  it('starts the day at midnight Damascus (UTC+3)', () => {
    const bounds = damascusDayBounds(now);
    expect(bounds.todayStart.toISOString()).toBe('2030-03-09T21:00:00.000Z');
    expect(bounds.yesterdayStart.toISOString()).toBe('2030-03-08T21:00:00.000Z');
    expect(bounds.sameTimeYesterday.toISOString()).toBe('2030-03-09T12:00:00.000Z');
    expect(bounds.days.map((day) => day.toISOString())).toEqual([
      '2030-03-03T21:00:00.000Z',
      '2030-03-04T21:00:00.000Z',
      '2030-03-05T21:00:00.000Z',
      '2030-03-06T21:00:00.000Z',
      '2030-03-07T21:00:00.000Z',
      '2030-03-08T21:00:00.000Z',
      '2030-03-09T21:00:00.000Z',
    ]);
  });

  it('turns the day at midnight, not at midnight UTC', () => {
    const before = damascusDayBounds(new Date('2030-03-31T20:59:59Z'));
    const after = damascusDayBounds(new Date('2030-03-31T21:00:00Z'));
    expect(before.todayStart.toISOString()).toBe('2030-03-30T21:00:00.000Z');
    expect(after.todayStart.toISOString()).toBe('2030-03-31T21:00:00.000Z');
    expect(after.sameTimeYesterday.toISOString()).toBe('2030-03-30T21:00:00.000Z');
    // Across the month's start.
    expect(zoneDayStart(new Date('2030-04-01T06:00:00Z'), 1).toISOString()).toBe(
      '2030-03-30T21:00:00.000Z',
    );
  });
});

describe('dashboard numbers (S11 rule DB2)', () => {
  it('compares with yesterday in percent, one decimal', () => {
    expect(deltaPercent(150, 100)).toBe(50);
    expect(deltaPercent(50, 100)).toBe(-50);
    expect(deltaPercent(1, 3)).toBe(-66.7);
    expect(deltaPercent(5, 0)).toBeNull();
    expect(deltaPercent(-50, -100)).toBe(50);
    expect(compared(2, 1)).toEqual({ today: 2, yesterday: 1, deltaPercent: 100 });
  });

  it('gives the margin of the sales', () => {
    expect(marginPercent(200_000, 1_000_000)).toBe(20);
    expect(marginPercent(-100_000, 1_000_000)).toBe(-10);
    expect(marginPercent(0, 0)).toBeNull();
  });

  it('lists attention items with a positive count', () => {
    const item = {
      kind: ATTENTION_KINDS[0],
      count: 1,
      oldestAt: null,
      target: '/',
      params: {},
      orders: [],
    };
    expect(attentionItemSchema.safeParse(item).success).toBe(true);
    expect(attentionItemSchema.safeParse({ ...item, count: 0 }).success).toBe(false);
  });
});
