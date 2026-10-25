import { PageHeader } from '@vertex-digital/ui/components/page-header';
import { BellRingIcon } from 'lucide-react';
import type { Metadata } from 'next';
import Link from 'next/link';
import { NotificationsPage } from '@/features/notifications/notifications-page';
import { NotificationsDeviceSwitch } from '@/features/push/device-switch';
import { t } from '@/lib/i18n';

export const metadata: Metadata = {
  title: t('notifications.title'),
  robots: { index: false },
};

/**
 * Read in the browser with the session cookie and never cached (S05 F27); this device's push
 * switch on top while push is not on here (S15 PC4).
 */
export default function NotificationsRoute() {
  return (
    <div className="mx-auto flex w-full max-w-2xl flex-col gap-8 px-4 py-10 md:py-16">
      <PageHeader
        title={t('notifications.title')}
        description={t('notifications.subtitle')}
        actions={
          <Link
            href="/account/alerts"
            prefetch={false}
            className="flex min-h-11 items-center gap-2 font-medium underline-offset-4 hover:underline"
          >
            <BellRingIcon className="size-4" aria-hidden="true" />
            {t('header.alerts')}
          </Link>
        }
      />
      <NotificationsDeviceSwitch />
      <NotificationsPage />
    </div>
  );
}
