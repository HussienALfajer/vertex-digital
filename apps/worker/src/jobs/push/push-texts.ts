import {
  NOTIFICATION_PARAMS,
  type NotificationParams,
  type PushNotificationEvent,
  SHOP_NOTIFICATION_PARAMS,
  type ShopNotificationEvent,
  type ShopNotificationParams,
  type ShopStatus,
  TIER_NAMES_AR,
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

/** S26: the merchant's shop states as a push says them. */
const SHOP_STATE_PUSH: Record<ShopStatus, string> = {
  requested: 'وصل طلب متجرك وهو قيد المراجعة',
  active: 'تمت الموافقة على متجرك',
  rejected: 'لم تتم الموافقة على طلب متجرك',
  suspended: 'أُوقف متجرك مؤقتاً',
  closed: 'أُغلق متجرك',
};

const SHOP_RETURN_PUSH: Record<'confirmed' | 'declined' | 'expired', string> = {
  confirmed: 'أكّد زبون إرجاع رصيد إلى محفظتك',
  declined: 'رفض زبون طلب إرجاع رصيد',
  expired: 'انتهى طلب إرجاع رصيد دون رد',
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

const productAlert = (params: { alertId: string; gameSlug: string; productId: string }) => ({
  url: `/games/${params.gameSlug}?pack=${params.productId}`,
  tag: `product-alert-${params.alertId}`,
});

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
      params.tier !== undefined
        ? `فئة حسابك الآن: تاجر ${TIER_NAMES_AR[params.tier]}`
        : params.levelNameAr === null
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
  // S23 PG3: the tier only; the amount stays in the app and the email (PT2).
  merchant_tier_reminder: (params) => ({
    body:
      params.kind === 'reach'
        ? `اقتربت من الفئة ال${TIER_NAMES_AR[params.tier]}ة قبل نهاية الشهر`
        : `اشترِ قبل نهاية الشهر لتحتفظ بالفئة ال${TIER_NAMES_AR[params.tier]}ة`,
    url: '/merchant/tier',
    tag: 'merchant-tier',
  }),
  merchant_statement_ready: (params) => ({
    body: 'كشف حساب الشهر الماضي جاهز',
    url: `/merchant/statements/${params.month}`,
    tag: 'merchant-statement',
  }),
  merchant_watch_digest: (params) => ({
    body: `تغيّرت ${params.priceDown + params.priceUp + params.backInStock + params.outOfStock} باقات تتابعها`,
    url: '/merchant/alerts',
    tag: 'merchant-alerts',
  }),
  // S23 OP5: the game or pack opened early, never a price.
  merchant_early_access: (params) => ({
    body: params.productNameAr
      ? `وصول مبكر: ${params.productNameAr} في ${params.gameNameAr} متاحة لك قبل الجميع`
      : `وصول مبكر: ${params.gameNameAr} متاحة لك قبل الجميع`,
    url: `/games/${params.gameSlug}`,
    tag: `early-access-${params.gameSlug}`,
  }),
  // S22 PA4: the pack's name, never its price (PT2).
  product_available: (params) => ({
    body: `عادت باقة ${params.productNameAr} في ${params.gameNameAr} إلى التوفر`,
    ...productAlert(params),
  }),
  product_price_dropped: (params) => ({
    body: `انخفض سعر ${params.productNameAr} في ${params.gameNameAr}`,
    ...productAlert(params),
  }),
  // S26: the shop's new state, never the rejection's reason (PT2).
  merchant_shop_changed: (params) => ({
    body: params.resumed ? 'عاد متجرك إلى العمل' : SHOP_STATE_PUSH[params.status],
    url: '/merchant/shop',
    tag: 'merchant-shop',
  }),
  // S26 WL5: never the customer's name or the amount (PT2).
  merchant_shop_return_ended: (params) => ({
    body: SHOP_RETURN_PUSH[params.status],
    url: '/merchant/shop/customers',
    tag: `shop-return-${params.shopCustomerId}`,
  }),
  // S26 TK1, TK2: the ticket's number, never the customer's name or the message (PT2).
  merchant_shop_ticket: (params) => ({
    body: `${SHOP_TICKET_PUSH[params.kind]} ${params.number}`,
    url: `/merchant/shop/tickets/${params.ticketId}`,
    tag: `shop-ticket-${params.ticketId}`,
  }),
  // S26 PR10: the order, never the amount (PT2).
  merchant_shop_margin_returned: (params) => ({
    body: `أُعيد ربح الطلب ${params.orderNumber} إلى زبون متجرك ضمن تعويض`,
    url: '/merchant/shop/orders',
    tag: `shop-margin-${params.orderId}`,
  }),
};

const SHOP_TICKET_PUSH = {
  opened: 'تذكرة جديدة في متجرك',
  replied: 'رد جديد في تذكرة متجرك',
  escalated: 'طلب زبون تدخل الإدارة في التذكرة',
  support_replied: 'رد فريق الدعم في تذكرة متجرك',
} as const;

/** PT1: the payload of a push event's notification, its stored params checked again. */
export function renderPush(event: PushNotificationEvent, params: unknown): PushPayload {
  const render = RENDERERS[event] as (params: object) => Omit<PushPayload, 'title'>;
  return { title: PUSH_TITLE, ...render(NOTIFICATION_PARAMS[event].parse(params)) };
}

type ShopRenderers = {
  [Event in ShopNotificationEvent]: (
    params: ShopNotificationParams<Event>,
    slug: string,
  ) => Omit<PushPayload, 'title'>;
};

/** S26 PR9: a shop customer's lock-screen texts, with PT2's limits; the title is the shop's name. */
const SHOP_RENDERERS: ShopRenderers = {
  transfer_received: (_, slug) => ({
    body: 'أضاف المتجر رصيداً إلى محفظتك',
    url: `/s/${slug}/wallet`,
    tag: 'shop-wallet',
  }),
  return_requested: (_, slug) => ({
    body: 'يطلب المتجر إرجاع مبلغ من رصيدك: أكّد أو ارفض',
    url: `/s/${slug}/wallet`,
    tag: 'shop-return',
  }),
  return_done: (_, slug) => ({
    body: 'تم إرجاع المبلغ من رصيدك إلى المتجر',
    url: `/s/${slug}/wallet`,
    tag: 'shop-return',
  }),
  settled: (_, slug) => ({
    body: 'سُوّي رصيدك في المتجر',
    url: `/s/${slug}/wallet`,
    tag: 'shop-wallet',
  }),
  order_delivered: (params, slug) => ({
    body: `تم تسليم طلبك ${params.orderNumber}: ${params.productNameAr} × ${params.quantity}`,
    url: `/s/${slug}/orders/${params.orderNumber}`,
    tag: `shop-order-${params.orderId}`,
  }),
  order_partially_refunded: (params, slug) => ({
    body: `سُلّم ${params.deliveredQuantity} من طلبك ${params.orderNumber} وأُعيد الباقي إلى رصيدك`,
    url: `/s/${slug}/orders/${params.orderNumber}`,
    tag: `shop-order-${params.orderId}`,
  }),
  order_refunded: (params, slug) => ({
    body: `تعذّر تنفيذ طلبك ${params.orderNumber} وأُعيد المبلغ إلى رصيدك`,
    url: `/s/${slug}/orders/${params.orderNumber}`,
    tag: `shop-order-${params.orderId}`,
  }),
  order_compensated: (params, slug) => ({
    body: `أُضيف تعويض إلى رصيدك عن الطلب ${params.orderNumber}`,
    url: `/s/${slug}/wallet`,
    tag: `shop-order-${params.orderId}`,
  }),
  ticket_replied: (params, slug) => ({
    body: `${params.from === 'shop' ? 'ردّ المتجر' : 'ردّ فريق الدعم'} على تذكرتك ${params.number}`,
    url: `/s/${slug}/support/${params.ticketId}`,
    tag: `shop-ticket-${params.ticketId}`,
  }),
};

/** S26 PR9: a shop notification's push, its stored params checked again; titled by the shop. */
export function renderShopPush(
  event: ShopNotificationEvent,
  params: unknown,
  shop: { name: string; slug: string },
): PushPayload {
  const render = SHOP_RENDERERS[event] as (
    params: object,
    slug: string,
  ) => Omit<PushPayload, 'title'>;
  return {
    title: shop.name,
    ...render(SHOP_NOTIFICATION_PARAMS[event].parse(params), shop.slug),
  };
}
