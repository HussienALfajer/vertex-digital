import type { AttemptStatus, OrderStatus } from '@vertex-digital/contracts';

/** Order and attempt status tones (brand/identity.md §2). */
export const STATUS_TONES = {
  awaiting_balance: 'neutral',
  paid: 'info',
  sent_to_supplier: 'info',
  failed: 'warning',
  needs_review: 'danger',
  delivered: 'success',
  partially_refunded: 'warning',
  refunded: 'neutral',
  cancelled: 'neutral',
} as const satisfies Record<OrderStatus, string>;

export const ATTEMPT_TONES = {
  sending: 'info',
  pending: 'info',
  unknown: 'warning',
  delivered: 'success',
  failed: 'danger',
} as const satisfies Record<AttemptStatus, string>;
