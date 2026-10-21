'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { tm } from './i18n';

const LINKS = [
  { href: '/merchant', label: 'nav.dashboard' },
  { href: '/merchant/pos', label: 'nav.pos' },
  { href: '/merchant/bulk', label: 'nav.bulk' },
  { href: '/merchant/prices', label: 'nav.prices' },
  { href: '/merchant/price-list', label: 'nav.priceList' },
  { href: '/merchant/statements', label: 'nav.statements' },
  { href: '/merchant/alerts', label: 'nav.alerts' },
  { href: '/merchant/receipt', label: 'nav.receipt' },
] as const;

/** The merchant area's sections (S21 screens), scrolled sideways on a phone. */
export function MerchantNav() {
  return <MerchantNavLinks pathname={usePathname()} />;
}

/**
 * The sections with the current one marked; `pathname` null before the URL is known (the
 * layout's `<Suspense>` fallback on a dynamic page, the statement of a month).
 */
export function MerchantNavLinks({ pathname }: { pathname: string | null }) {
  return (
    <nav aria-label={tm('title')} className="-mx-4 overflow-x-auto px-4">
      <ul className="flex min-w-max gap-1 border-b border-border">
        {LINKS.map((link) => {
          const current =
            pathname !== null &&
            (pathname === link.href ||
              (link.href !== '/merchant' && pathname.startsWith(`${link.href}/`)));
          return (
            <li key={link.href}>
              <Link
                href={link.href}
                prefetch={false}
                aria-current={current ? 'page' : undefined}
                className={`inline-flex min-h-11 items-center border-b-2 px-4 text-md transition-colors ${
                  current
                    ? 'border-primary font-medium text-foreground'
                    : 'border-transparent text-muted-foreground hover:text-foreground'
                }`}
              >
                {tm(link.label)}
              </Link>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}
