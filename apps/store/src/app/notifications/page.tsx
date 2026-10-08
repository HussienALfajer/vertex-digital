import { PageHeader } from '@vertex-digital/ui/components/page-header';
import type { Metadata } from 'next';
import { NotificationsPage } from '@/features/notifications/notifications-page';
import { t } from '@/lib/i18n';

export const metadata: Metadata = {
  title: t('notifications.title'),
  robots: { index: false },
};

/** Read in the browser with the session cookie and never cached (S05 F27). */
export default function NotificationsRoute() {
  return (
    <div className="mx-auto flex w-full max-w-2xl flex-col gap-8 px-4 py-10 md:py-16">
      <PageHeader title={t('notifications.title')} description={t('notifications.subtitle')} />
      <NotificationsPage />
    </div>
  );
}
