'use client';

import {
  HouseIcon,
  type LucideIcon,
  ReceiptTextIcon,
  SearchIcon,
  ShoppingCartIcon,
  WalletIcon,
} from 'lucide-react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { Suspense, useEffect, useState, useSyncExternalStore } from 'react';
import { storedLineCount, subscribeCart } from '@/features/cart/cart-keys';
import { openSearch } from '@/features/search/search-trigger';
import { t } from '@/lib/i18n';
import { readSessionResult } from '@/lib/session';

const ITEM =
  'relative flex min-h-14 flex-1 flex-col items-center justify-center gap-0.5 text-xs font-medium text-muted-foreground transition-colors duration-150 aria-[current=page]:text-accent-text';

function NavLink({
  href,
  label,
  ariaLabel,
  icon: Icon,
  active,
  badge,
}: {
  href: string;
  label: string;
  ariaLabel?: string;
  icon: LucideIcon;
  active: boolean;
  badge?: number;
}) {
  return (
    <Link
      href={href}
      prefetch={false}
      aria-label={ariaLabel}
      aria-current={active ? 'page' : undefined}
      className={ITEM}
    >
      {active && <span aria-hidden="true" className="absolute inset-x-4 top-0 h-0.5 bg-accent" />}
      <Icon className="size-5" strokeWidth={1.75} aria-hidden="true" />
      {label}
      {badge !== undefined && badge > 0 && (
        <span
          aria-hidden="true"
          className="absolute start-1/2 top-1 flex h-4 min-w-4 items-center justify-center rounded-full bg-accent px-1 text-[0.625rem] font-bold text-accent-foreground tabular-nums"
        >
          {badge}
        </span>
      )}
    </Link>
  );
}

/** Rule NH4: the path to a customer page, or to sign-in with `next` once known to be signed out. */
const customerHref = (path: string, signedOut: boolean) =>
  signedOut ? `/sign-in?next=${encodeURIComponent(path)}` : path;

function Bar({ pathname }: { pathname: string | null }) {
  // In the server's HTML with no count: appearing after hydration would move the other items. Only
  // a browser without storage then drops it (CT1).
  const cartCount = useSyncExternalStore(subscribeCart, storedLineCount, () => 0);
  const [signedOut, setSignedOut] = useState(false);
  useEffect(() => {
    let live = true;
    // A failed read is not "signed out" (audit A10-17): the links go to the pages, which decide.
    void readSessionResult().then(({ session, known }) => {
      if (live) setSignedOut(known && session === null);
    });
    return () => {
      live = false;
    };
  }, []);
  if (pathname?.endsWith('/print')) return null;
  const under = (path: string) => pathname === path || !!pathname?.startsWith(`${path}/`);
  const home = pathname === '/' || under('/categories') || under('/games');
  return (
    <nav
      aria-label={t('nav.label')}
      className="fixed inset-x-0 bottom-0 z-40 flex border-t border-border bg-background pb-[env(safe-area-inset-bottom)] sm:hidden print:hidden"
    >
      <NavLink href="/" label={t('nav.home')} icon={HouseIcon} active={home} />
      <button
        type="button"
        aria-haspopup="dialog"
        aria-label={t('search.open')}
        className={ITEM}
        onClick={openSearch}
      >
        <SearchIcon className="size-5" strokeWidth={1.75} aria-hidden="true" />
        {t('nav.search')}
      </button>
      {cartCount !== null && (
        <NavLink
          href="/cart"
          label={t('nav.cart')}
          ariaLabel={cartCount > 0 ? t('header.cartCount', { count: cartCount }) : t('header.cart')}
          icon={ShoppingCartIcon}
          active={under('/cart')}
          badge={cartCount}
        />
      )}
      <NavLink
        href={customerHref('/orders', signedOut)}
        label={t('nav.orders')}
        icon={ReceiptTextIcon}
        active={under('/orders')}
      />
      <NavLink
        href={customerHref('/wallet', signedOut)}
        label={t('nav.wallet')}
        icon={WalletIcon}
        active={under('/wallet')}
      />
    </nav>
  );
}

function CurrentBar() {
  return <Bar pathname={usePathname()} />;
}

/** The phone's bottom bar (S24 NH4); a dynamic route knows its path only at request time. */
export function BottomNav() {
  return (
    <Suspense fallback={<Bar pathname={null} />}>
      <CurrentBar />
    </Suspense>
  );
}
