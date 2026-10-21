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
    case 'order_partially_refunded': {
      const { params } = notification;
      // S16 AP11: an order the store paid returns nothing to the wallet.
      if (params.refundedUsdUnits === null) {
        return t('notifications.events.order_partially_failed', {
          product: params.productNameAr,
          number: reference(params.orderNumber),
        });
      }
      return t('notifications.events.order_partially_refunded', {
        product: params.productNameAr,
        number: reference(params.orderNumber),
        amount: ltr(formatUsd(params.refundedUsdUnits)),
      });
    }
    case 'order_refunded': {
      const { params } = notification;
      if (params.refundedUsdUnits === null) {
        return t('notifications.events.order_failed', {
          product: params.productNameAr,
          number: reference(params.orderNumber),
          reason: t(`orders.refundReasons.${params.reason}`),
        });
      }
      return t('notifications.events.order_refunded', {
        product: params.productNameAr,
        number: reference(params.orderNumber),
        amount: ltr(formatUsd(params.refundedUsdUnits)),
        reason: t(`orders.refundReasons.${params.reason}`),
      });
    }
    // S16 AP11: the mode and the store's note, never its internal reason.
    case 'order_placed_for_you': {
      const { params } = notification;
      const text = t(`notifications.events.order_placed_for_you_${params.purpose}`, {
        product: params.productNameAr,
        number: reference(params.orderNumber),
      });
      return params.message
        ? `${text} ${t('notifications.events.order_placed_for_you_message', { message: params.message })}`
        : text;
    }
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
    // S12 TK9: the ticket, never the reply.
    case 'ticket_replied':
      return t('notifications.events.ticket_replied', {
        number: reference(notification.params.number),
      });
    // S20 AT4: the kind of price only, never the list.
    case 'price_list_changed':
      return t(`notifications.events.price_list_changed_${notification.params.priceKind}`);
    // S20 MA4–MA7: the admin's message is written to this customer; a revocation's reason is not.
    case 'merchant_info_requested':
      return t('notifications.events.merchant_info_requested', {
        message: notification.params.message,
      });
    case 'merchant_approved':
      return t('notifications.events.merchant_approved');
    case 'merchant_rejected':
      return t('notifications.events.merchant_rejected', {
        reason: notification.params.reason,
      });
    case 'merchant_application_expired':
      return t('notifications.events.merchant_application_expired');
    case 'merchant_revoked':
      return t('notifications.events.merchant_revoked');
    // S21: the level's name and the price kind, never a list's name.
    case 'merchant_level_changed': {
      const { params } = notification;
      const kind = t(`merchant.priceKinds.${params.priceKind}`);
      return params.levelNameAr === null
        ? t('notifications.events.merchant_level_none', { kind })
        : t(`notifications.events.merchant_level_${params.direction}`, {
            level: params.levelNameAr,
            kind,
          });
    }
    case 'merchant_watch_digest': {
      const { params } = notification;
      return t('notifications.events.merchant_watch_digest', {
        prices: params.priceDown + params.priceUp,
        back: params.backInStock,
        out: params.outOfStock,
      });
    }
    case 'merchant_low_balance':
      return t('notifications.events.merchant_low_balance', {
        balance: ltr(formatUsd(notification.params.balanceUsdUnits)),
        threshold: ltr(formatUsd(notification.params.thresholdUsdUnits)),
      });
    case 'merchant_statement_ready':
      return t('notifications.events.merchant_statement_ready', {
        month: ltr(notification.params.month),
      });
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
    case 'ticket_replied':
      return `/support/${notification.params.ticketId}`;
    case 'price_list_changed':
      return '/';
    case 'merchant_info_requested':
    case 'merchant_rejected':
    case 'merchant_application_expired':
      return '/account/merchant';
    case 'merchant_approved':
    case 'merchant_revoked':
      return '/account';
    case 'merchant_level_changed':
      return '/merchant';
    case 'merchant_watch_digest':
      return '/merchant/alerts';
    case 'merchant_low_balance':
      return '/wallet';
    case 'merchant_statement_ready':
      return `/merchant/statements/${notification.params.month}`;
    default:
      return `/orders/${notification.params.orderId}`;
  }
}

/** The bell's badge: nothing at 0, "9+" above 9. */
export function badgeText(count: number): string | null {
  if (count <= 0) return null;
  return count > 9 ? '9+' : String(count);
}
