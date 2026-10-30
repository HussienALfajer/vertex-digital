import { PageHeader } from '@vertex-digital/ui/components/page-header';
import type { Metadata } from 'next';
import { Suspense } from 'react';
import { PageBackLink } from '@/components/page-back-link';
import { FaqCallout } from '@/features/content/site-links';
import { TelegramCard } from '@/features/support/telegram-card';
import { TicketsList } from '@/features/support/tickets-list';
import { t } from '@/lib/i18n';

export const metadata: Metadata = {
  title: t('support.title'),
};

/**
 * "الدعم" (S12 screens): the Telegram card from the cached channels route, then the customer's
 * tickets, read in the browser with the session and never cached.
 */
export default function SupportRoute() {
  return (
    <div className="mx-auto flex w-full max-w-2xl flex-col gap-8 px-4 py-10 md:py-16">
      <PageHeader
        back={<PageBackLink href="/">{t('back.home')}</PageBackLink>}
        title={t('support.title')}
        description={t('support.subtitle')}
      />
      <Suspense fallback={null}>
        <FaqCallout />
      </Suspense>
      <Suspense fallback={null}>
        <TelegramCard />
      </Suspense>
      <TicketsList />
    </div>
  );
}
