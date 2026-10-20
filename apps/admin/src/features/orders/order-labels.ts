import type {
  AdminOrder,
  AdminOrderPurpose,
  AttemptStatus,
  OrderStatus,
} from '@vertex-digital/contracts';
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

/** S16 AP14: the chip of an order placed from the panel; owner-funded modes stand out. */
export const PURPOSE_TONES = {
  walk_in: 'gold',
  on_behalf: 'info',
  gift: 'gold',
  compensation: 'gold',
} as const satisfies Record<AdminOrderPurpose, string>;

/** S09 rule AD3: how the player id was checked before the order was paid or reserved. */
export function playerCheckText(
  t: TFunction,
  order: Pick<AdminOrder, 'playerCheck' | 'playerName' | 'playerRegion'>,
): string {
  if (order.playerCheck !== 'valid') return t(`orders.playerChecks.${order.playerCheck}`);
  const named = order.playerName
    ? t('orders.playerChecks.valid', { name: order.playerName })
    : t('orders.playerChecks.validNoName');
  // S19 PC9: the region beside the name.
  return order.playerRegion
    ? `${named} · ${t('orders.playerChecks.region', { region: order.playerRegion })}`
    : named;
}
