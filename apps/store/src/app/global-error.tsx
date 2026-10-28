'use client';

import { Button } from '@vertex-digital/ui/components/button';
import { EmptyState } from '@vertex-digital/ui/components/empty-state';
import { t } from '@/lib/i18n';
import './globals.css';

/**
 * An error in the root layout itself (the header, the footer, the banners), which `error.tsx`
 * sits inside and cannot catch: Arabic, right to left, with a full reload, instead of Next's
 * English page (audit A10-7). A chunk of an earlier release after a deploy ends here too.
 */
export default function GlobalError() {
  return (
    <html lang="ar" dir="rtl" className="dark">
      <body className="flex min-h-dvh flex-col">
        <main className="mx-auto w-full max-w-2xl px-4 py-16">
          <EmptyState
            titleAs="h1"
            title={t('error.title')}
            description={t('error.body')}
            action={
              <Button size="xl" onClick={() => window.location.reload()}>
                {t('error.retry')}
              </Button>
            }
          />
        </main>
      </body>
    </html>
  );
}
