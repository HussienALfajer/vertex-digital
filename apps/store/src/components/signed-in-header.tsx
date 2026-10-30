'use client';

import { useEffect } from 'react';
import { NotificationBell } from '@/features/notifications/notification-bell';
import { BalanceChip } from '@/features/wallet/balance-chip';
import { AccountMenu } from './account-menu';

/**
 * The header's entries for a signed-in customer: the wallet balance (S02 rule W8), the
 * notification bell (S05) and the account menu. One chunk, loaded only once a session is known.
 */
export function SignedInHeader({ name, email }: { name: string; email: string }) {
  // S15 PS6, PS7: a device that allowed push re-registers its subscription with this session.
  // Its own chunk, fetched only where push was allowed.
  useEffect(() => {
    if ('Notification' in window && Notification.permission === 'granted') {
      void import('@/features/push/device').then((device) => device.refreshDevice());
    }
  }, []);
  return (
    <div data-signed-in="" className="flex items-center sm:gap-1">
      <BalanceChip />
      <NotificationBell />
      <AccountMenu name={name} email={email} />
    </div>
  );
}
