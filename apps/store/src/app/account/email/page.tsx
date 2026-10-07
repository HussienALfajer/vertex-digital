import { PageHeader } from '@vertex-digital/ui/components/page-header';
import type { Metadata } from 'next';
import { ChangeEmailPanel } from '@/features/account/change-email-panel';
import { t } from '@/lib/i18n';

export const metadata: Metadata = {
  title: t('changeEmail.title'),
  robots: { index: false },
};

/** Read in the browser with the session cookie: nothing about the customer is rendered here. */
export default function ChangeEmailRoute() {
  return (
    <div className="mx-auto flex w-full max-w-md flex-col gap-8 px-4 py-10 md:py-16">
      <PageHeader title={t('changeEmail.title')} description={t('changeEmail.subtitle')} />
      <ChangeEmailPanel />
    </div>
  );
}
