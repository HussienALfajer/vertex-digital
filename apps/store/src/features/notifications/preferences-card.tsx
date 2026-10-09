'use client';

import {
  EMAIL_NOTIFICATION_EVENTS,
  type NotificationEvent,
  type NotificationPreferences,
} from '@vertex-digital/contracts';
import { Card, CardDescription, CardHeader, CardTitle } from '@vertex-digital/ui/components/card';
import { Skeleton } from '@vertex-digital/ui/components/skeleton';
import { Switch } from '@vertex-digital/ui/components/switch';
import { Toaster, toast } from '@vertex-digital/ui/components/toast';
import { ShieldCheckIcon } from 'lucide-react';
import { useEffect, useState } from 'react';
import { errorText } from '@/lib/errors';
import { t } from '@/lib/i18n';
import { getNotificationPreferences, setNotificationPreference } from './requests';

/**
 * `/account` → الإشعارات (S05 rule NT8): one email switch per event, saved on toggle with a toast.
 * Security emails are listed as always on. The toasts live with the card, so pages without it
 * load no toast code.
 */
export function NotificationPreferencesCard() {
  const [preferences, setPreferences] = useState<NotificationPreferences | null>(null);
  const [failed, setFailed] = useState(false);
  const [saving, setSaving] = useState<NotificationEvent | null>(null);

  useEffect(() => {
    void getNotificationPreferences().then((result) =>
      result.ok ? setPreferences(result.data) : setFailed(true),
    );
  }, []);

  const change = async (event: NotificationEvent, email: boolean) => {
    setSaving(event);
    const result = await setNotificationPreference(event, email);
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
          <CardDescription>{t('account.notifications.description')}</CardDescription>
        </CardHeader>
        <ul className="flex flex-col divide-y divide-border">
          {EMAIL_NOTIFICATION_EVENTS.map((event) => {
            const label = t(`account.notifications.events.${event}`);
            return (
              <li key={event} className="flex min-h-14 items-center justify-between gap-4 py-2">
                <span id={`notification-${event}`}>{label}</span>
                {preferences ? (
                  <Switch
                    aria-labelledby={`notification-${event}`}
                    checked={preferences.email[event]}
                    disabled={saving !== null}
                    onCheckedChange={(checked) => void change(event, checked)}
                  />
                ) : (
                  <Skeleton className="h-6 w-10" aria-hidden="true" />
                )}
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
