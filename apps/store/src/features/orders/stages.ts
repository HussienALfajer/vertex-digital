import type { Order, OrderStage } from '@vertex-digital/contracts';
import { t } from '@/lib/i18n';

/*
 * What the customer reads about an order (rule O13): its stage, never the supplier, costs,
 * attempts or internal reasons.
 */

export const STAGE_TONES = {
  processing: 'info',
  delayed: 'warning',
  delivered: 'success',
  partially_refunded: 'warning',
  refunded: 'neutral',
  cancelled: 'neutral',
} as const satisfies Record<OrderStage, string>;

export function stageText(stage: OrderStage): string {
  return t(`orders.stages.${stage}`);
}

/** The plain sentence under the stage on the order page. */
export function stageSentence(order: Pick<Order, 'stage' | 'refundReason'>): string {
  if (order.stage === 'refunded' && order.refundReason) {
    return t('orders.sentences.refundedBecause', {
      reason: t(`orders.refundReasons.${order.refundReason}`),
    });
  }
  return t(`orders.sentences.${order.stage}`);
}
