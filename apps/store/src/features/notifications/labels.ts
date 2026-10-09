import { type CustomerNotification, formatUsd } from '@vertex-digital/contracts';
import { ltr } from '@/lib/format';
import { t } from '@/lib/i18n';

/** A reference code kept whole: left to right, and no line break after its hyphen (U+2060). */
const reference = (code: string) => ltr(code.replace('-', '-\u2060'));

/** The notification's sentence (rule NT3): rendered here from its params, never by the API. */
export function notificationText(notification: CustomerNotification): string {
  switch (notification.event) {
    case 'deposit_credited':
      return t('notifications.events.deposit_credited', {
        amount: ltr(formatUsd(notification.params.creditedUsdUnits)),
        reference: reference(notification.params.referenceCode),
      });
    case 'deposit_rejected':
      return t('notifications.events.deposit_rejected', {
        reference: reference(notification.params.referenceCode),
        reason: t(`deposits.rejectReasons.${notification.params.reason}`),
      });
    case 'deposit_receipt_requested':
      return t('notifications.events.deposit_receipt_requested', {
        reference: reference(notification.params.referenceCode),
      });
    case 'wallet_adjusted': {
      const { params } = notification;
      const category = t(`wallet.categories.${params.category}`);
      return t(`notifications.events.wallet_adjusted_${params.direction}`, {
        amount: ltr(formatUsd(params.amountUnits)),
        category: params.reversal ? t('wallet.reversal', { category }) : category,
      });
    }
    // S08: the order number and product, never codes or account fields.
    case 'order_delivered':
      return t('notifications.events.order_delivered', {
        product: notification.params.productNameAr,
        number: reference(notification.params.orderNumber),
      });
    case 'order_partially_refunded':
      return t('notifications.events.order_partially_refunded', {
        product: notification.params.productNameAr,
        number: reference(notification.params.orderNumber),
        amount: ltr(formatUsd(notification.params.refundedUsdUnits)),
      });
    case 'order_refunded':
      return t('notifications.events.order_refunded', {
        product: notification.params.productNameAr,
        number: reference(notification.params.orderNumber),
        amount: ltr(formatUsd(notification.params.refundedUsdUnits)),
        reason: t(`orders.refundReasons.${notification.params.reason}`),
      });
    case 'order_delayed':
      return t('notifications.events.order_delayed', {
        product: notification.params.productNameAr,
        number: reference(notification.params.orderNumber),
      });
    // S09: a reservation paid after a deposit, or cancelled by the system.
    case 'order_paid':
      return t('notifications.events.order_paid', {
        product: notification.params.productNameAr,
        number: reference(notification.params.orderNumber),
      });
    case 'order_cancelled':
      return t('notifications.events.order_cancelled', {
        product: notification.params.productNameAr,
        number: reference(notification.params.orderNumber),
        reason: t(`orders.cancelReasons.${notification.params.reason}`),
      });
    // S10 rule CT8: once per checkout, the counts that are not zero.
    case 'checkout_finished': {
      const { params } = notification;
      const parts = [
        params.delivered > 0 &&
          t('notifications.events.checkout_finished_delivered', { count: params.delivered }),
        params.partiallyRefunded > 0 &&
          t('notifications.events.checkout_finished_partial', { count: params.partiallyRefunded }),
        params.refunded > 0 &&
          t('notifications.events.checkout_finished_refunded', { count: params.refunded }),
      ].filter((part) => part !== false);
      const amount =
        params.refundedUsdUnits > 0
          ? ` ${t('notifications.events.checkout_finished_amount', {
              amount: ltr(formatUsd(params.refundedUsdUnits)),
            })}`
          : '';
      return t('notifications.events.checkout_finished', {
        summary: `${parts.join('، ')}${amount}`,
      });
    }
  }
}

/** Where a notification leads (rule NT4). */
export function notificationHref(notification: CustomerNotification): string {
  switch (notification.event) {
    case 'wallet_adjusted':
      return '/wallet';
    case 'deposit_credited':
    case 'deposit_rejected':
    case 'deposit_receipt_requested':
      return `/wallet/deposits/${notification.params.depositId}`;
    case 'checkout_finished':
      return `/orders?checkout=${notification.params.checkoutId}`;
    default:
      return `/orders/${notification.params.orderId}`;
  }
}

/** The bell's badge: nothing at 0, "9+" above 9. */
export function badgeText(count: number): string | null {
  if (count <= 0) return null;
  return count > 9 ? '9+' : String(count);
}
