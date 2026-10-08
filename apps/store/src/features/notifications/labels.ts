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
  }
}

/** Where a notification leads (rule NT4). */
export function notificationHref(notification: CustomerNotification): string {
  return notification.event === 'wallet_adjusted'
    ? '/wallet'
    : `/wallet/deposits/${notification.params.depositId}`;
}

/** The bell's badge: nothing at 0, "9+" above 9. */
export function badgeText(count: number): string | null {
  if (count <= 0) return null;
  return count > 9 ? '9+' : String(count);
}
