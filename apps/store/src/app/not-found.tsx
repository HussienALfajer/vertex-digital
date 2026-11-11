import type { Metadata } from 'next';
import { BottomNav } from '@/components/bottom-nav';
import { SiteFooter } from '@/components/site-footer';
import { SiteHeader } from '@/components/site-header';
import { t } from '@/lib/i18n';
import NotFound from './(site)/not-found';

export const metadata: Metadata = { title: t('notFound.title'), robots: { index: false } };

/** An address no route matches: outside every route group, so it draws the store's frame itself. */
export default function UnmatchedNotFound() {
  return (
    <>
      <SiteHeader />
      <main className="flex flex-1 flex-col">
        <NotFound />
      </main>
      <SiteFooter />
      <BottomNav />
    </>
  );
}
