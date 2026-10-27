'use client';

import { Button } from '@vertex-digital/ui/components/button';
import { Switch } from '@vertex-digital/ui/components/switch';
import { useId, useState } from 'react';
import { FormAlert } from '@/components/form-alert';
import { useInstall } from '@/features/pwa/install-button';
import { t } from '@/lib/i18n';
import { disablePush, enablePush } from './device';
import { type PushDevice, usePushDevice } from './use-push-device';

/** The switch exists only where push is configured and the browser can do it or install first. */
function switchShown(
  device: PushDevice,
): device is Extract<PushDevice, { status: 'ready' }> & { publicKey: string } {
  return device.status === 'ready' && device.publicKey !== null && device.support !== 'none';
}

/**
 * PC4: "إشعارات الهاتف على هذا الجهاز". On is PC2's tap (no prompt once permission is granted);
 * off makes the browser forget its subscription and deletes the row. Disabled with the
 * browser-settings hint once denied; iOS Safari outside the app shows the install hint instead.
 * Hidden when push is not configured or the browser cannot do it.
 */
export function DeviceSwitch({
  device,
  reload,
}: {
  device: PushDevice;
  reload: () => Promise<void>;
}) {
  const labelId = useId();
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<'on' | 'off' | null>(null);
  const [saved, setSaved] = useState<'on' | 'off' | null>(null);
  const install = useInstall();

  if (!switchShown(device)) return null;
  if (device.support === 'ios-install') {
    return (
      <div data-testid="push-device" className="flex flex-col items-start gap-2 py-2">
        <p className="text-sm text-muted-foreground">{t('push.card.ios')}</p>
        <Button variant="outline" size="xl" onClick={install.start}>
          {t('push.card.iosSteps')}
        </Button>
        {install.steps}
      </div>
    );
  }

  const { publicKey } = device;
  const change = async (on: boolean) => {
    setBusy(true);
    setFailure(null);
    setSaved(null);
    if (on) {
      const result = await enablePush(publicKey);
      if (result.outcome === 'failed') setFailure('on');
      else if (result.outcome === 'enabled') setSaved('on');
    } else {
      const result = await disablePush();
      setFailure(result.ok ? null : 'off');
      setSaved(result.ok ? 'off' : null);
    }
    await reload();
    setBusy(false);
  };

  const denied = device.permission === 'denied';
  return (
    <div data-testid="push-device" className="flex flex-col gap-2 py-2">
      <div className="flex min-h-11 items-center justify-between gap-4">
        <span id={labelId} className="font-medium">
          {t('push.device.label')}
        </span>
        <Switch
          aria-labelledby={labelId}
          checked={device.subscribed}
          disabled={busy || (denied && !device.subscribed)}
          onCheckedChange={(checked) => void change(checked)}
        />
      </div>
      {denied && !device.subscribed ? (
        <p className="text-sm text-muted-foreground">{t('push.denied.hint')}</p>
      ) : (
        !device.subscribed && (
          <p className="text-sm text-muted-foreground">{t('push.device.off')}</p>
        )
      )}
      {saved && (
        <FormAlert tone="success">
          {saved === 'on' ? t('push.device.onSaved') : t('push.device.offSaved')}
        </FormAlert>
      )}
      {failure && (
        <FormAlert>
          {failure === 'on' ? t('push.card.failed') : t('push.device.offFailed')}
        </FormAlert>
      )}
    </div>
  );
}

/** PC4 at the top of `/notifications`: only while push is not on for this device. */
export function NotificationsDeviceSwitch() {
  const { device, reload } = usePushDevice();
  const [onAtFirstRead, setOnAtFirstRead] = useState<boolean | null>(null);
  if (device.status === 'ready' && onAtFirstRead === null) setOnAtFirstRead(device.subscribed);
  if (onAtFirstRead !== false || !switchShown(device)) return null;
  return (
    <div className="rounded-lg border border-border bg-surface px-4">
      <DeviceSwitch device={device} reload={reload} />
    </div>
  );
}
