'use client';

import {
  EMAIL_NOTIFICATION_EVENTS,
  isPushNotificationEvent,
  type NotificationEvent,
  type NotificationPreferences,
  PUSH_NOTIFICATION_EVENTS,
  type PushNotificationEvent,
} from '@vertex-digital/contracts';
import { Card, CardDescription, CardHeader, CardTitle } from '@vertex-digital/ui/components/card';
import { Skeleton } from '@vertex-digital/ui/components/skeleton';
import { Switch } from '@vertex-digital/ui/components/switch';
import { Toaster, toast } from '@vertex-digital/ui/components/toast';
import { ShieldCheckIcon } from 'lucide-react';
import { useEffect, useState } from 'react';
import { DeviceSwitch } from '@/features/push/device-switch';
import { usePushDevice } from '@/features/push/use-push-device';
import { errorText } from '@/lib/errors';
import { t } from '@/lib/i18n';
import { getNotificationPreferences, setNotificationPreference } from './requests';

/**
 * `/account` → الإشعارات (S05 rule NT8): one email switch per event, and where push is configured
 * a "الهاتف" switch beside it with this device's switch above the list (S15 PP1, PP2, PC4); each
 * saved on toggle with a toast. The push switches apply to all the customer's devices, so they stay
 * editable without a subscription here. Security emails are listed as always on. The toasts live
 * with the card, so pages without it load no toast code.
 */
/** The events with a switch: every email event, then the push-only ones (S21 AL3). */
const PREFERENCE_EVENTS: readonly PushNotificationEvent[] = [
  ...EMAIL_NOTIFICATION_EVENTS,
  ...PUSH_NOTIFICATION_EVENTS.filter(
    (event) => !(EMAIL_NOTIFICATION_EVENTS as readonly NotificationEvent[]).includes(event),
  ),
];

export function NotificationPreferencesCard() {
  const [preferences, setPreferences] = useState<NotificationPreferences | null>(null);
  const [failed, setFailed] = useState(false);
  const [saving, setSaving] = useState<NotificationEvent | null>(null);
  const { device, reload } = usePushDevice();
  const pushConfigured = device.status === 'ready' && device.publicKey !== null;

  useEffect(() => {
    void getNotificationPreferences().then((result) =>
      result.ok ? setPreferences(result.data) : setFailed(true),
    );
  }, []);

  const change = async (event: NotificationEvent, channel: 'email' | 'push', on: boolean) => {
    setSaving(event);
    const result = await setNotificationPreference(event, channel, on);
    setSaving(null);
    if (result.ok) {
      setPreferences(result.data);
      toast.add({ title: t('account.notifications.saved'), type: 'success' });
    } else {
      toast.add({
        title: t('account.notifications.saveFailed'),
        description: errorText(result.reason),
        type: 'error',
      });
    }
  };

  // A failed read hides the card: the rest of the account still works.
  if (failed) return null;
  return (
    <Toaster closeLabel={t('account.notifications.close')}>
      <Card>
        <CardHeader>
          <CardTitle>{t('account.notifications.title')}</CardTitle>
          <CardDescription>
            {pushConfigured
              ? t('account.notifications.descriptionPush')
              : t('account.notifications.description')}
          </CardDescription>
        </CardHeader>
        {pushConfigured && <DeviceSwitch device={device} reload={reload} />}
        <ul className="flex flex-col divide-y divide-border">
          {pushConfigured && (
            <li
              aria-hidden="true"
              className="flex min-h-10 items-center justify-end gap-4 text-sm text-muted-foreground"
            >
              <span className="w-12 text-center">{t('account.notifications.emailColumn')}</span>
              <span className="w-12 text-center">{t('account.notifications.pushColumn')}</span>
            </li>
          )}
          {(pushConfigured ? PREFERENCE_EVENTS : EMAIL_NOTIFICATION_EVENTS).map((event) => {
            const label = t(`account.notifications.events.${event}`);
            const email = (EMAIL_NOTIFICATION_EVENTS as readonly NotificationEvent[]).includes(
              event,
            );
            const channels: ('email' | 'push')[] = [
              ...(email ? (['email'] as const) : []),
              ...(pushConfigured && isPushNotificationEvent(event) ? (['push'] as const) : []),
            ];
            return (
              <li key={event} className="flex min-h-14 items-center justify-between gap-4 py-2">
                <span id={`notification-${event}`}>{label}</span>
                <span className="flex shrink-0 items-center gap-4">
                  {/* S21: a push-only event (the follow digest) keeps the email column empty. */}
                  {!email && <span className="w-12" aria-hidden="true" />}
                  {channels.map((channel) =>
                    preferences ? (
                      <span key={channel} className="flex w-12 justify-center">
                        <Switch
                          aria-label={t(
                            channel === 'email'
                              ? 'account.notifications.emailLabel'
                              : 'account.notifications.pushLabel',
                            { event: label },
                          )}
                          checked={preferences[channel][event]}
                          disabled={saving !== null}
                          onCheckedChange={(checked) => void change(event, channel, checked)}
                        />
                      </span>
                    ) : (
                      <span key={channel} className="flex w-12 justify-center">
                        <Skeleton className="h-6 w-10" aria-hidden="true" />
                      </span>
                    ),
                  )}
                </span>
              </li>
            );
          })}
          <li className="flex min-h-14 items-center justify-between gap-4 py-2 text-muted-foreground">
            <span className="flex items-center gap-2">
              <ShieldCheckIcon className="size-5 shrink-0" aria-hidden="true" />
              {t('account.notifications.security')}
            </span>
            <span className="shrink-0 text-sm">{t('account.notifications.alwaysOn')}</span>
          </li>
        </ul>
      </Card>
    </Toaster>
  );
}
