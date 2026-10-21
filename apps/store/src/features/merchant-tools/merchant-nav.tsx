'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { tm } from './i18n';

const LINKS = [
  { href: '/merchant', label: 'nav.dashboard' },
  { href: '/merchant/prices', label: 'nav.prices' },
  { href: '/merchant/alerts', label: 'nav.alerts' },
] as const;

/** The merchant area's sections (S21 screens), scrolled sideways on a phone. */
export function MerchantNav() {
  const pathname = usePathname();
  return (
    <nav aria-label={tm('title')} className="-mx-4 overflow-x-auto px-4">
      <ul className="flex min-w-max gap-1 border-b border-border">
        {LINKS.map((link) => {
          const current = pathname === link.href;
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
