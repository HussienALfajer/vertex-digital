import { z } from 'zod';

/** Order statuses (ADR 0004). */
export const ORDER_STATUSES = [
  'awaiting_balance',
  'paid',
  'sent_to_supplier',
  'failed',
  'needs_review',
  'delivered',
  'partially_refunded',
  'refunded',
  'cancelled',
] as const;

export const orderStatusSchema = z.enum(ORDER_STATUSES).meta({ id: 'OrderStatus' });

export type OrderStatus = z.infer<typeof orderStatusSchema>;

/**
 * The only allowed status changes: ADR 0004's table, plus `paid → refunded` when no profitable
 * route is left (ADR 0013). A status with no next status is terminal. The write path in
 * `packages/db` applies a change with `WHERE status = <from>`.
 */
export const ORDER_TRANSITIONS: Readonly<Record<OrderStatus, readonly OrderStatus[]>> = {
  awaiting_balance: ['paid', 'cancelled'],
  paid: ['sent_to_supplier', 'refunded'],
  sent_to_supplier: ['delivered', 'failed', 'needs_review'],
  failed: ['sent_to_supplier', 'refunded', 'partially_refunded'],
  needs_review: ['delivered', 'sent_to_supplier', 'refunded', 'partially_refunded'],
  delivered: [],
  partially_refunded: [],
  refunded: [],
  cancelled: [],
};

export function canTransitionOrder(from: OrderStatus, to: OrderStatus): boolean {
  return ORDER_TRANSITIONS[from].includes(to);
}

/** True for `delivered`, `partially_refunded`, `refunded` and `cancelled`: the order is over. */
export function isTerminalOrderStatus(status: OrderStatus): boolean {
  return ORDER_TRANSITIONS[status].length === 0;
}
