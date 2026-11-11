'use client';

import { HouseIcon, type LucideIcon, ReceiptTextIcon, UserIcon, WalletIcon } from 'lucide-react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { ts } from './i18n';
import { shopPath } from './paths';

/** S26 screens: الرئيسية، طلباتي، رصيدي، حسابي, the shop's own pages only. */
function items(slug: string): { href: string; label: string; icon: LucideIcon }[] {
  return [
    { href: shopPath(slug), label: ts('nav.home'), icon: HouseIcon },
    { href: shopPath(slug, '/orders'), label: ts('nav.orders'), icon: ReceiptTextIcon },
    { href: shopPath(slug, '/wallet'), label: ts('nav.wallet'), icon: WalletIcon },
    { href: shopPath(slug, '/account'), label: ts('nav.account'), icon: UserIcon },
  ];
}

function useActive(slug: string) {
  const pathname = usePathname();
  const home = shopPath(slug);
  return (href: string) =>
    href === home
      ? pathname === home || !!pathname?.startsWith(`${home}/games/`)
      : pathname === href || !!pathname?.startsWith(`${href}/`);
}

/** The phone's bottom bar, in the shop's color. */
export function ShopBottomNav({ slug }: { slug: string }) {
  const active = useActive(slug);
  return (
    <nav
      aria-label={ts('nav.label')}
      className="fixed inset-x-0 bottom-0 z-40 flex border-t border-border bg-background pb-[env(safe-area-inset-bottom)] sm:hidden print:hidden"
    >
      {items(slug).map(({ href, label, icon: Icon }) => {
        const current = active(href);
        return (
          <Link
            key={href}
            href={href}
            prefetch={false}
            aria-current={current ? 'page' : undefined}
            className="relative flex min-h-14 flex-1 flex-col items-center justify-center gap-0.5 text-xs font-medium text-muted-foreground aria-[current=page]:text-foreground"
          >
            {current && (
              <span
                aria-hidden="true"
                className="absolute inset-x-4 top-0 h-0.5 bg-(--shop-brand)"
              />
            )}
            <Icon className="size-5" strokeWidth={1.75} aria-hidden="true" />
            {label}
          </Link>
        );
      })}
    </nav>
  );
}

/** From `sm` the same links sit in the header. */
export function ShopHeaderNav({ slug }: { slug: string }) {
  const active = useActive(slug);
  return (
    <nav aria-label={ts('nav.label')} className="hidden items-center gap-1 sm:flex">
      {items(slug).map(({ href, label }) => (
        <Link
          key={href}
          href={href}
          prefetch={false}
          aria-current={active(href) ? 'page' : undefined}
          className="inline-flex min-h-11 items-center rounded-md px-3 text-sm font-medium text-muted-foreground hover:text-foreground aria-[current=page]:text-foreground aria-[current=page]:underline aria-[current=page]:decoration-(--shop-brand) aria-[current=page]:decoration-2 aria-[current=page]:underline-offset-8"
        >
          {label}
        </Link>
      ))}
    </nav>
  );
}
