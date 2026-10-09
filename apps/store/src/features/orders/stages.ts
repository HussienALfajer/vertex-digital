import type { Order, OrderStage, OrderTimelineStep } from '@vertex-digital/contracts';
import { t } from '@/lib/i18n';

/*
 * What the customer reads about an order (rule O13): its stage, never the supplier, costs,
 * attempts or internal reasons.
 */

export const STAGE_TONES = {
  awaiting_balance: 'warning',
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

/** A step of the order's timeline (S09 rule LT1). */
export function stepText(step: OrderTimelineStep): string {
  return t(`orders.steps.${step}`);
}

/** The plain sentence under the stage on the order page. */
export function stageSentence(
  order: Pick<Order, 'stage' | 'refundReason'> & Partial<Pick<Order, 'cancelReason'>>,
): string {
  if (order.stage === 'cancelled' && order.cancelReason) {
    return t(`orders.cancelReasons.${order.cancelReason}`);
  }
  if (order.stage === 'refunded' && order.refundReason) {
    return t('orders.sentences.refundedBecause', {
      reason: t(`orders.refundReasons.${order.refundReason}`),
    });
  }
  return t(`orders.sentences.${order.stage}`);
}
