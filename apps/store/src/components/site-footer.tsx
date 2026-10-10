import Link from 'next/link';
import { Suspense } from 'react';
import { telegramSupportUrl } from '@/features/support/data';
import { t } from '@/lib/i18n';

const LINK = 'inline-flex min-h-11 items-center underline-offset-4 hover:underline';

/**
 * The footer: "الدعم" (S12), the support Telegram link when the panel sets one (SC2, read at
 * request time from the cached channels route, so the build never calls the API), the rights.
 */
export function SiteFooter() {
  return (
    <footer className="border-t border-border">
      <div className="mx-auto flex max-w-6xl flex-col gap-2 px-4 py-6 text-sm text-muted-foreground sm:flex-row sm:items-center sm:justify-between">
        <nav aria-label={t('footer.nav')} className="flex flex-wrap items-center gap-x-6">
          {/* Not prefetched: on every page, it would download the support pages' code (the
              performance budget, e2e/store.spec.ts). */}
          <Link href="/support" prefetch={false} className={LINK}>
            {t('footer.support')}
          </Link>
          <Suspense fallback={null}>
            <TelegramLink />
          </Suspense>
        </nav>
        <Rights />
      </div>
    </footer>
  );
}

async function TelegramLink() {
  const url = await telegramSupportUrl();
  if (!url) return null;
  return (
    <a href={url} target="_blank" rel="noopener noreferrer" className={LINK}>
      {t('footer.telegram')}
    </a>
  );
}

async function Rights() {
  'use cache';
  return <span dir="ltr">{t('footer.rights', { year: new Date().getFullYear() })}</span>;
}
