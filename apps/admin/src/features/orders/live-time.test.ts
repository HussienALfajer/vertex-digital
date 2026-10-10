import type { LiveOrderCard } from '@vertex-digital/contracts';
import { describe, expect, it } from 'vitest';
import {
  elapsedMs,
  finishedInMs,
  formatElapsed,
  hasNewWaiting,
  isSlow,
  waitingIds,
} from './live-time';

const PAID = '2026-10-10T10:00:00.000Z';
const at = (seconds: number) => new Date(PAID).getTime() + seconds * 1000;

const card = (fields: Partial<LiveOrderCard> = {}): LiveOrderCard => ({
  id: '0199b000-0000-7000-8000-000000000001',
  number: 'VO-ABCD23',
  status: 'sent_to_supplier',
  game: { id: '0199b000-0000-7000-8000-000000000080', nameAr: 'ببجي موبايل' },
  product: { id: '0199b000-0000-7000-8000-000000000070', nameAr: '60 UC' },
  quantity: 1,
  totalUsdUnits: 990_000,
  isTest: false,
  customerEmail: 'sara@example.com',
  attempt: null,
  paidAt: PAID,
  sentAt: PAID,
  reviewSince: null,
  finishedAt: null,
  slowAfterSeconds: 120,
  ...fields,
});

describe('formatElapsed', () => {
  it('reads minutes and seconds under an hour, hours from an hour', () => {
    expect(formatElapsed(0)).toBe('00:00');
    expect(formatElapsed(65_400)).toBe('01:05');
    expect(formatElapsed(3_599_999)).toBe('59:59');
    expect(formatElapsed(3_600_000)).toBe('1:00:00');
    expect(formatElapsed(37_230_000)).toBe('10:20:30');
  });

  it('never shows a negative time (a clock slightly behind the server)', () => {
    expect(formatElapsed(-5_000)).toBe('00:00');
  });
});

describe('isSlow (rule LR3)', () => {
  it('turns amber only past the threshold', () => {
    expect(elapsedMs(card(), at(90))).toBe(90_000);
    expect(isSlow(card(), at(120))).toBe(false);
    expect(isSlow(card(), at(121))).toBe(true);
  });

  it('never marks a card without a threshold (manual, review, finished)', () => {
    expect(isSlow(card({ slowAfterSeconds: null }), at(10_000))).toBe(false);
  });
});

describe('finishedInMs', () => {
  it('measures from payment to the end, null while open', () => {
    expect(finishedInMs(card({ finishedAt: '2026-10-10T10:00:45.000Z' }))).toBe(45_000);
    expect(finishedInMs(card())).toBeNull();
  });
});

describe('new waiting orders (rule LR6)', () => {
  const columns = (review: string[], manual: string[]) => ({
    at_supplier: { cards: [card({ id: 'a' })] },
    manual: { cards: manual.map((id) => card({ id })) },
    review: { cards: review.map((id) => card({ id })) },
    finished: { cards: [] },
  });

  it('collects review and manual ids only', () => {
    expect(waitingIds(columns(['r1'], ['m1']))).toEqual(new Set(['r1', 'm1']));
  });

  it('is silent on the first read and when nothing new arrived', () => {
    expect(hasNewWaiting(null, new Set(['r1']))).toBe(false);
    expect(hasNewWaiting(new Set(['r1', 'm1']), new Set(['r1']))).toBe(false);
  });

  it('rings for an id the previous read did not have', () => {
    expect(hasNewWaiting(new Set(['r1']), new Set(['r1', 'm2']))).toBe(true);
  });
});
