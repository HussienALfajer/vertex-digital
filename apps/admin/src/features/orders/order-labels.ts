import type { AdminOrder, AttemptStatus, OrderStatus } from '@vertex-digital/contracts';
import type { TFunction } from 'i18next';

/** Order and attempt status tones (brand/identity.md §2). */
export const STATUS_TONES = {
  awaiting_balance: 'warning',
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

/** S09 rule AD3: how the player id was checked before the order was paid or reserved. */
export function playerCheckText(
  t: TFunction,
  order: Pick<AdminOrder, 'playerCheck' | 'playerName'>,
): string {
  if (order.playerCheck !== 'valid') return t(`orders.playerChecks.${order.playerCheck}`);
  return order.playerName
    ? t('orders.playerChecks.valid', { name: order.playerName })
    : t('orders.playerChecks.validNoName');
}
