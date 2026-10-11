import { useCallback, useEffect, useState } from 'react';
import { currentSubscription, devicePermission, deviceSupport, pushPublicKey } from './device';
import { type Permission, type PushSupport, sameKey } from './rules';

export type PushDevice =
  | { status: 'loading' }
  | {
      status: 'ready';
      /** Null: push is not configured, no push control shows (S15 environment). */
      publicKey: string | null;
      support: PushSupport;
      permission: Permission;
      /** This browser holds a subscription made with the served key. */
      subscribed: boolean;
    };

/** What this device can do and has done about push, read once on mount (PC1, PC4). */
export function usePushDevice(): { device: PushDevice; reload: () => Promise<void> } {
  const [device, setDevice] = useState<PushDevice>({ status: 'loading' });
  const reload = useCallback(async () => {
    const publicKey = await pushPublicKey();
    const support = deviceSupport();
    const held = publicKey && support === 'push' ? await currentSubscription() : null;
    setDevice({
      status: 'ready',
      publicKey,
      support,
      permission: devicePermission(),
      subscribed: held !== null && sameKey(held.options.applicationServerKey, publicKey ?? ''),
    });
  }, []);
  useEffect(() => {
    void reload();
  }, [reload]);
  return { device, reload };
}
