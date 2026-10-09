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

/** The stages during which the order still moves (rule LT1: upcoming steps are shown). */
const OPEN_STAGES: readonly OrderStage[] = ['awaiting_balance', 'processing', 'delayed'];

/** The happy path the customer waits along: paid → قيد الشحن → تم التسليم. */
const PATH = ['paid', 'sent', 'delivered'] as const satisfies readonly OrderTimelineStep[];

/** How far along the path a reached step is. */
const PATH_INDEX: Partial<Record<OrderTimelineStep, number>> = {
  reserved: -1,
  paid: 0,
  sent: 1,
  retrying: 1,
  delayed: 1,
  delivered: 2,
};

export type TimelineEntry =
  | { step: OrderTimelineStep; at: string; state: 'done' | 'current' }
  | { step: OrderTimelineStep; at: null; state: 'upcoming' };

/**
 * Rule LT1 on the order page: the steps reached, the newest one current while the order is open,
 * then the path's steps still ahead, greyed.
 */
export function timelineEntries(order: Pick<Order, 'stage' | 'timeline'>): TimelineEntry[] {
  const open = OPEN_STAGES.includes(order.stage);
  const reached: TimelineEntry[] = order.timeline.map((entry, index) => ({
    step: entry.step,
    at: entry.at,
    state: open && index === order.timeline.length - 1 ? 'current' : 'done',
  }));
  if (!open) return reached;
  const furthest = Math.max(-1, ...order.timeline.map((entry) => PATH_INDEX[entry.step] ?? -1));
  return [
    ...reached,
    ...PATH.slice(furthest + 1).map(
      (step): TimelineEntry => ({ step, at: null, state: 'upcoming' }),
    ),
  ];
}
