import { PageHeader } from '@vertex-digital/ui/components/page-header';
import type { Metadata } from 'next';
import { Suspense } from 'react';
import { FaqCallout } from '@/features/content/site-links';
import { NewTicketPage } from '@/features/support/new-ticket-page';
import { t } from '@/lib/i18n';

export const metadata: Metadata = {
  title: t('support.new.title'),
  robots: { index: false },
};

/** A static shell (with the cached FAQ callout, S14 SL3): the form reads the session and the customer's records in the browser. */
export default function NewTicketRoute() {
  return (
    <div className="mx-auto flex w-full max-w-2xl flex-col gap-8 px-4 py-10 md:py-16">
      <PageHeader title={t('support.new.title')} description={t('support.new.subtitle')} />
      <Suspense fallback={null}>
        <FaqCallout />
      </Suspense>
      <NewTicketPage />
    </div>
  );
}
