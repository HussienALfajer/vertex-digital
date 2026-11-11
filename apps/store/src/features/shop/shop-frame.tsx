import type { ShopPublic } from '@vertex-digital/contracts';
import { Skeleton } from '@vertex-digital/ui/components/skeleton';
import Link from 'next/link';
import type { ReactNode } from 'react';
import { ThemeToggle } from '@/components/theme-toggle';
import { InstallLink } from '@/features/pwa/install-button';
import { BalancePill } from './balance-pill';
import { brandStyle } from './brand';
import { ts } from './i18n';
import { shopPath } from './paths';
import { ShopMark } from './shop-mark';
import { ShopBottomNav, ShopHeaderNav } from './shop-nav';
import { ShopBell } from './unread';
import { VisitCounter } from './visit-counter';

const LINK = 'inline-flex min-h-11 items-center underline-offset-4 hover:underline';

/**
 * A shop's frame (S26 screens), in place of the store's header, footer and bottom bar: the
 * merchant's name and logo lead, the brand color is the primary; the footer says «يعمل بـ VERTEX
 * DIGITAL» with no link to the store (decision 12), with the shop's own terms and privacy pages.
 */
export function ShopFrame({ shop, children }: { shop: ShopPublic; children: ReactNode }) {
  const home = shopPath(shop.slug);
  return (
    <div data-shop-frame="" style={brandStyle(shop.brandColor)} className="flex flex-1 flex-col">
      <header className="border-b border-border">
        <div aria-hidden="true" className="h-1 bg-(--shop-brand)" />
        <div className="mx-auto flex max-w-6xl items-center gap-3 px-4 py-3">
          <Link href={home} className="flex min-w-24 flex-1 items-center gap-3 sm:flex-none">
            <ShopMark name={shop.name} logoUrl={shop.logoUrl} letter={shop.letter} />
            {/* Decision 12: the merchant's name leads; two lines on a phone rather than cut. */}
            <span className="line-clamp-2 text-base leading-tight font-bold break-words sm:text-lg">
              {shop.name}
            </span>
          </Link>
          <ShopHeaderNav slug={shop.slug} />
          <div className="ms-auto flex shrink-0 items-center gap-1 sm:gap-2">
            <ShopBell slug={shop.slug} />
            <BalancePill slug={shop.slug} />
            {/* On a phone the theme switch lives in "حسابي": the name keeps the room. */}
            <span className="hidden sm:inline-flex">
              <ThemeToggle />
            </span>
          </div>
        </div>
      </header>
      <main className="flex flex-1 flex-col">{children}</main>
      <footer className="border-t border-border">
        <div className="mx-auto flex max-w-6xl flex-col gap-2 px-4 py-6 text-sm text-muted-foreground sm:flex-row sm:items-center sm:justify-between">
          <nav className="flex flex-wrap items-center gap-x-6">
            <Link href={shopPath(shop.slug, '/support')} prefetch={false} className={LINK}>
              {ts('nav.support')}
            </Link>
            <Link href={shopPath(shop.slug, '/terms')} prefetch={false} className={LINK}>
              {ts('footer.terms')}
            </Link>
            <Link href={shopPath(shop.slug, '/privacy')} prefetch={false} className={LINK}>
              {ts('footer.privacy')}
            </Link>
            <InstallLink className={LINK} />
          </nav>
          <p dir="rtl" className="text-xs">
            {ts('footer.poweredBy')}
          </p>
        </div>
      </footer>
      <ShopBottomNav slug={shop.slug} />
      <VisitCounter slug={shop.slug} />
    </div>
  );
}

export function ShopFrameSkeleton() {
  return (
    <div className="flex flex-1 flex-col" aria-hidden="true">
      <div className="mx-auto flex w-full max-w-6xl items-center gap-3 px-4 py-4">
        <Skeleton className="size-10" />
        <Skeleton className="h-6 w-40" />
      </div>
    </div>
  );
}
