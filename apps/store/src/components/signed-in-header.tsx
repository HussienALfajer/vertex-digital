'use client';

import { NotificationBell } from '@/features/notifications/notification-bell';
import { BalanceChip } from '@/features/wallet/balance-chip';
import { AccountMenu } from './account-menu';

/**
 * The header's entries for a signed-in customer: the wallet balance (S02 rule W8), the
 * notification bell (S05) and the account menu. One chunk, loaded only once a session is known.
 */
export function SignedInHeader({ name, email }: { name: string; email: string }) {
  return (
    <div className="flex items-center sm:gap-1">
      <BalanceChip />
      <NotificationBell />
      <AccountMenu name={name} email={email} />
    </div>
  );
}
