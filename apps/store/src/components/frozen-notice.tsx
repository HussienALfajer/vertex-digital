import { LockIcon } from 'lucide-react';
import Link from 'next/link';
import { t } from '@/lib/i18n';

/** The frozen banner's text (S12 rule CF5), loaded only for a frozen customer. */
export function FrozenNotice() {
  return (
    <div role="status" className="bg-status-warning text-status-warning-foreground">
      <div className="mx-auto flex max-w-6xl items-start gap-2 px-4 py-3 text-sm sm:items-center">
        <LockIcon aria-hidden="true" className="mt-0.5 size-4 shrink-0 sm:mt-0" />
        <p>
          {t('frozen.banner')}{' '}
          <Link
            href="/support/new?category=account"
            prefetch={false}
            className="font-medium whitespace-nowrap underline underline-offset-4"
          >
            {t('frozen.contact')}
          </Link>
        </p>
      </div>
    </div>
  );
}
