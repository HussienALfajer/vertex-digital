import { describe, expect, it } from 'vitest';
import {
  canTransitionOrder,
  isTerminalOrderStatus,
  ORDER_STATUSES,
  ORDER_TRANSITIONS,
  type OrderStatus,
  orderStatusSchema,
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
