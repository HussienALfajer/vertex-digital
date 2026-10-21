import {
  NOTIFICATION_PARAMS,
  type NotificationParams,
  type PushNotificationEvent,
} from '@vertex-digital/contracts';

/**
 * The lock-screen texts of web push (S15 PT1–PT3), in Arabic, next to the email templates and
 * under the same rules: Latin digits, no exclamation marks. A push never carries an amount, a
 * code, a player ID or any account field, a rejection reason, a ticket message, an admin note, or
 * the customer's name or email (PT2): only the order number, the pack's name and quantity, the
 * deposit's reference code, the ticket number and counts. `test/push.test.ts` checks every event.
 */

export interface PushPayload {
  title: string;
  body: string;
  /** A path of the store (SW7 opens only same-origin paths). */
  url: string;
  /** Replaces an earlier notification of the same record on the device (PT3). */
  tag: string;
}

/** The title of every push (PT3). */
export const PUSH_TITLE = 'VERTEX DIGITAL';

type Renderers = {
  [Event in PushNotificationEvent]: (
    params: NotificationParams<Event>,
  ) => Omit<PushPayload, 'title'>;
};

const order = (params: { orderId: string }) => ({
  url: `/orders/${params.orderId}`,
  tag: `order-${params.orderId}`,
});

const deposit = (params: { depositId: string }) => ({
  url: `/wallet/deposits/${params.depositId}`,
  tag: `deposit-${params.depositId}`,
});

const merchant = { url: '/account/merchant', tag: 'merchant' };

const PLACED_FOR_YOU = {
  on_behalf: 'أنشأ المتجر طلباً بطلبك',
  gift: 'هدية من المتجر',
  compensation: 'تعويض من المتجر',
} as const;

const RENDERERS: Renderers = {
  order_delivered: (params) => ({
    body: `تم تسليم طلبك ${params.orderNumber}: ${params.productNameAr}${
      params.quantity > 1 ? ` × ${params.quantity}` : ''
    }`,
    ...order(params),
  }),
  order_partially_refunded: (params) => ({
    body:
      params.refundedUsdUnits === null
        ? `سُلّم جزء من طلبك ${params.orderNumber} وتعذّر تنفيذ الباقي`
        : `سُلّم جزء من طلبك ${params.orderNumber} وأُعيد الباقي إلى رصيدك`,
    ...order(params),
  }),
  order_refunded: (params) => ({
    // S16 AP11: an order the store paid returns nothing to the wallet.
    body:
      params.refundedUsdUnits === null
        ? `تعذّر تنفيذ الطلب ${params.orderNumber}`
        : `لم نتمكن من تسليم طلبك ${params.orderNumber}، وأُعيد المبلغ إلى رصيدك`,
    ...order(params),
  }),
  // S16 AP11: the order number and the pack's name only, never the store's note.
  order_placed_for_you: (params) => ({
    body: `${PLACED_FOR_YOU[params.purpose]} ${params.orderNumber}: ${params.productNameAr}`,
    ...order(params),
  }),
  order_cancelled: (params) => ({
    body: `أُلغي حجزك ${params.orderNumber}. لم يُخصم شيء من رصيدك`,
    ...order(params),
  }),
  checkout_finished: (params) => ({
    body: `اكتملت طلبات سلتك: ${params.delivered} من ${params.orderCount} سُلّمت${
      params.refundedUsdUnits > 0 ? ' وأُعيد الباقي إلى رصيدك' : ''
    }`,
    url: `/orders?checkout=${params.checkoutId}`,
    tag: `checkout-${params.checkoutId}`,
  }),
  deposit_credited: (params) => ({
    body: `أُضيف إيداعك ${params.referenceCode} إلى رصيدك`,
    ...deposit(params),
  }),
  deposit_rejected: (params) => ({
    body: `لم نتمكن من قبول إيداعك ${params.referenceCode}. افتحه لمعرفة السبب`,
    ...deposit(params),
  }),
  deposit_receipt_requested: (params) => ({
    body: `نحتاج صورة أوضح لإيصال إيداعك ${params.referenceCode}`,
    ...deposit(params),
  }),
  wallet_adjusted: () => ({
    body: 'تغيّر رصيدك. افتح المحفظة لمعرفة التفاصيل',
    url: '/wallet',
    tag: 'wallet',
  }),
  ticket_replied: (params) => ({
    body: `ردّ فريق الدعم على تذكرتك ${params.number}`,
    url: `/support/${params.ticketId}`,
    tag: `ticket-${params.ticketId}`,
  }),
  // S20: never the admin's message or reason (PT2).
  merchant_info_requested: () => ({
    body: 'نحتاج معلومات إضافية لطلب حساب التاجر',
    ...merchant,
  }),
  merchant_approved: () => ({ body: 'تمت الموافقة على حساب التاجر', ...merchant }),
  merchant_rejected: () => ({
    body: 'لم تتم الموافقة على طلب حساب التاجر. افتحه لمعرفة السبب',
    ...merchant,
  }),
  merchant_revoked: () => ({
    body: 'تغيّر نوع حسابك إلى حساب عميل',
    url: '/account',
    tag: 'merchant',
  }),
  // S21: the level's name, never the list's; no amount (PT2).
  merchant_level_changed: (params) => ({
    body:
      params.levelNameAr === null
        ? 'تغيّر مستوى حساب التاجر'
        : `مستوى حسابك الآن: ${params.levelNameAr}`,
    url: '/merchant',
    tag: 'merchant-level',
  }),
  merchant_low_balance: () => ({
    body: 'رصيدك أقل من الحد الذي حددته. اشحن رصيدك لتتابع البيع',
    url: '/wallet',
    tag: 'merchant-low-balance',
  }),
  merchant_watch_digest: (params) => ({
    body: `تغيّرت ${params.priceDown + params.priceUp + params.backInStock + params.outOfStock} باقات تتابعها`,
    url: '/merchant/alerts',
    tag: 'merchant-alerts',
  }),
};

/** PT1: the payload of a push event's notification, its stored params checked again. */
export function renderPush(event: PushNotificationEvent, params: unknown): PushPayload {
  const render = RENDERERS[event] as (params: object) => Omit<PushPayload, 'title'>;
  return { title: PUSH_TITLE, ...render(NOTIFICATION_PARAMS[event].parse(params)) };
}
