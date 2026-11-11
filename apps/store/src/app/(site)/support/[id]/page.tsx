import { PageHeader } from '@vertex-digital/ui/components/page-header';
import type { Metadata } from 'next';
import { Suspense } from 'react';
import { TicketPage, TicketSkeleton } from '@/features/support/ticket-page';
import { t } from '@/lib/i18n';

export const metadata: Metadata = {
  title: t('support.ticket.title'),
  robots: { index: false },
};

/**
 * A static shell: the ticket loads in the browser with the session cookie, by the id in the URL
 * (known only at request time, hence the boundary), and is never cached.
 */
export default function TicketRoute() {
  return (
    <div className="mx-auto flex w-full max-w-2xl flex-col gap-8 px-4 py-10 md:py-16">
      <PageHeader title={t('support.ticket.title')} />
      <Suspense fallback={<TicketSkeleton />}>
        <TicketPage />
      </Suspense>
    </div>
  );
}
