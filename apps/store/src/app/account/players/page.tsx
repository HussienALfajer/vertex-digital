import { PageHeader } from '@vertex-digital/ui/components/page-header';
import type { Metadata } from 'next';
import { PlayersPage } from '@/features/players/players-page';
import { t } from '@/lib/i18n';

export const metadata: Metadata = {
  title: t('players.title'),
  robots: { index: false },
};

/** "معرّفاتي" (S10 rule SP5): read in the browser with the session cookie, never cached. */
export default function PlayersRoute() {
  return (
    <div className="mx-auto flex w-full max-w-2xl flex-col gap-8 px-4 py-10 md:py-16">
      <PageHeader title={t('players.title')} description={t('players.subtitle')} />
      <PlayersPage />
    </div>
  );
}
