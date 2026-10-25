'use client';

import dynamic from 'next/dynamic';
import { useEffect, useState } from 'react';
import { readCardDismissal } from './dismissal';
import { cardVisible } from './rules';
import { usePushDevice } from './use-push-device';

const PermissionCard = dynamic(() => import('./permission-card').then((m) => m.PermissionCard), {
  ssr: false,
});

/**
 * The permission card's place on the order and deposit pages (PC1): the card's code loads only
 * once its conditions hold, and it stays through its own outcome (done, denied) for this visit.
 */
export function PushCard({ kind }: { kind: 'order' | 'deposit' | 'alert' }) {
  const { device } = usePushDevice();
  const [shown, setShown] = useState(false);
  useEffect(() => {
    if (device.status !== 'ready' || shown) return;
    setShown(
      cardVisible({
        configured: device.publicKey !== null,
        support: device.support,
        permission: device.permission,
        subscribed: device.subscribed,
        dismissedAt: readCardDismissal(),
        now: Date.now(),
      }),
    );
  }, [device, shown]);
  if (!shown || device.status !== 'ready' || !device.publicKey || device.support === 'none')
    return null;
  return <PermissionCard kind={kind} publicKey={device.publicKey} support={device.support} />;
}
