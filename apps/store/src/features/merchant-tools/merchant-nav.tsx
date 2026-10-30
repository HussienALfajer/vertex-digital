'use client';

import { Button } from '@vertex-digital/ui/components/button';
import { Sheet, SheetContent, SheetTitle } from '@vertex-digital/ui/components/sheet';
import {
  SidebarPanel,
  sidebarChildSize,
  sidebarItemSize,
  sidebarLink,
  sidebarSection,
} from '@vertex-digital/ui/components/sidebar';
import { Skeleton } from '@vertex-digital/ui/components/skeleton';
import {
  ChevronsUpDownIcon,
  FileTextIcon,
  GaugeIcon,
  type LucideIcon,
  MenuIcon,
  StoreIcon,
  TagsIcon,
} from 'lucide-react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { type ReactNode, Suspense, useEffect, useState } from 'react';
import { readSessionResult } from '@/lib/session';
import { type MerchantMessageKey, tm } from './i18n';
import { setSaleMode, useSaleMode } from './sale-mode';
import { MerchantTierBadge } from './tier-state';

/** Where "وضع البيع" opens: the home page, with the mode on (read by `HomeMerchantSlot`). */
export const SALE_HOME = '/?sale=1';

const GROUPS: readonly {
  label: MerchantMessageKey;
  icon: LucideIcon;
  links: readonly { href: string; label: MerchantMessageKey }[];
}[] = [
  {
    label: 'nav.groups.overview',
    icon: GaugeIcon,
    links: [
      { href: '/merchant', label: 'nav.dashboard' },
      { href: '/merchant/tier', label: 'nav.tier' },
    ],
  },
  {
    label: 'nav.groups.selling',
    icon: StoreIcon,
    links: [
      { href: SALE_HOME, label: 'nav.saleMode' },
      { href: '/merchant/bulk', label: 'nav.bulk' },
    ],
  },
  {
    label: 'nav.groups.pricing',
    icon: TagsIcon,
    links: [
      { href: '/merchant/prices', label: 'nav.prices' },
      { href: '/merchant/price-list', label: 'nav.priceList' },
    ],
  },
  {
    label: 'nav.groups.account',
    icon: FileTextIcon,
    links: [
      { href: '/merchant/statements', label: 'nav.statements' },
      { href: '/merchant/alerts', label: 'nav.alerts' },
      { href: '/merchant/receipt', label: 'nav.receipt' },
    ],
  },
];

const isCurrent = (href: string, pathname: string | null, saleOn: boolean) =>
  href === SALE_HOME
    ? pathname === '/' && saleOn
    : pathname !== null &&
      (pathname === href || (href !== '/merchant' && pathname.startsWith(`${href}/`)));

/** The merchant's name from the session; undefined while it is read, null without one. */
function useMerchantName() {
  const [name, setName] = useState<string | null | undefined>(undefined);
  useEffect(() => {
    let live = true;
    // A failed read on a re-show keeps the name already shown.
    void readSessionResult().then(({ session, known }) => {
      if (live) setName((shown) => (known ? (session?.user.name ?? null) : (shown ?? null)));
    });
    return () => {
      live = false;
    };
  }, []);
  return name;
}

/** The merchant's name and tier, between the panel's header and its links. */
function MerchantIdentity() {
  const name = useMerchantName();
  return (
    <div className="flex shrink-0 flex-col items-start gap-2 border-b border-sidebar-border px-5 py-4">
      {name === undefined && <Skeleton className="h-6 w-32" aria-hidden="true" />}
      {name && <p className="font-bold wrap-anywhere">{name}</p>}
      {/* The panel is green in both themes: the badge takes its dark colors in both. */}
      <div className="dark">
        <MerchantTierBadge />
      </div>
    </div>
  );
}

/** The merchant's sections, as the admin panel's: a section with its pages under it. */
function MerchantLinks({
  pathname,
  onNavigate,
}: {
  pathname: string | null;
  onNavigate?: () => void;
}) {
  const saleOn = useSaleMode();
  const onLink = (href: string) => {
    // The address alone would not turn it on when the home page is already open.
    if (href === SALE_HOME) setSaleMode(true);
    onNavigate?.();
  };
  return (
    <>
      {GROUPS.map(({ label, icon: Icon, links }) => {
        const first = links[0]?.href ?? '/merchant';
        return (
          <div key={label} className="flex flex-col gap-1">
            <Link
              href={first}
              prefetch={false}
              onClick={() => onLink(first)}
              data-current={links.some((link) => isCurrent(link.href, pathname, saleOn))}
              className={`${sidebarSection} ${sidebarItemSize}`}
            >
              <Icon className="size-5" aria-hidden="true" />
              {tm(label)}
            </Link>
            <div className="flex flex-col gap-0.5">
              {links.map((link) => {
                const current = isCurrent(link.href, pathname, saleOn);
                return (
                  <Link
                    key={link.href}
                    href={link.href}
                    prefetch={false}
                    aria-current={current ? 'page' : undefined}
                    data-status={current ? 'active' : undefined}
                    onClick={() => onLink(link.href)}
                    className={`${sidebarLink} ${sidebarChildSize}`}
                  >
                    {tm(link.label)}
                  </Link>
                );
              })}
            </div>
          </div>
        );
      })}
    </>
  );
}

function CurrentLinks() {
  return <MerchantLinks pathname={usePathname()} />;
}

/** The panel, the admin panel's sidebar with the merchant's name, tier and sections in it. */
function MerchantPanel({ children }: { children: ReactNode }) {
  return (
    <SidebarPanel title={tm('title')} navLabel={tm('title')} top={<MerchantIdentity />}>
      {children}
    </SidebarPanel>
  );
}

/**
 * The sidebar on a wide screen, like the admin panel's: fixed to the screen's edge while the page
 * scrolls. A dynamic page (a month's statement) knows its URL only at request time, hence the
 * boundary; the identity stays outside it: the tier's read may land before that boundary hydrates,
 * and a badge inside it would then not match the server's placeholder.
 */
export function MerchantSidebar({ className = '' }: { className?: string }) {
  return (
    <aside className={`sticky top-0 hidden h-dvh w-64 shrink-0 self-start lg:flex ${className}`}>
      <MerchantPanel>
        <Suspense fallback={<MerchantLinks pathname={null} />}>
          <CurrentLinks />
        </Suspense>
      </MerchantPanel>
    </aside>
  );
}

/**
 * The same panel below `lg`, as in the admin panel: a sheet from the screen's edge, over the bottom
 * bar. `pathname` null before the URL is known (the `<Suspense>` fallback on a dynamic page).
 */
function SectionsSheet({ pathname, compact }: { pathname: string | null; compact: boolean }) {
  const [open, setOpen] = useState(false);
  const saleOn = useSaleMode();
  const section = GROUPS.flatMap((group) => group.links).find((link) =>
    isCurrent(link.href, pathname, saleOn),
  );
  const sectionName = section ? tm(section.label) : tm('title');

  // The phone's Back leaves the page with no link pressed: the sheet must not stay over the next.
  useEffect(() => {
    if (!open) return;
    const close = () => setOpen(false);
    window.addEventListener('popstate', close);
    return () => window.removeEventListener('popstate', close);
  }, [open]);

  return (
    <>
      <Button
        variant="outline"
        size="xl"
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-label={tm('nav.open', { section: sectionName })}
        className={compact ? 'lg:hidden' : 'min-w-0 flex-1 justify-start lg:hidden'}
        onClick={() => setOpen(true)}
      >
        <MenuIcon strokeWidth={1.75} aria-hidden="true" />
        <span className="min-w-0 truncate">{compact ? tm('title') : sectionName}</span>
        {!compact && (
          <ChevronsUpDownIcon
            className="ms-auto text-muted-foreground"
            strokeWidth={1.75}
            aria-hidden="true"
          />
        )}
      </Button>
      <Sheet open={open} onOpenChange={setOpen}>
        <SheetContent>
          <SheetTitle className="sr-only">{tm('title')}</SheetTitle>
          {/* Only while open: the desktop panel is the one list a wide screen exposes. */}
          <MerchantPanel>
            <MerchantLinks pathname={pathname} onNavigate={() => setOpen(false)} />
          </MerchantPanel>
        </SheetContent>
      </Sheet>
    </>
  );
}

function CurrentSheet({ compact }: { compact: boolean }) {
  return <SectionsSheet pathname={usePathname()} compact={compact} />;
}

/** The button that opens the sections below `lg`; `compact` on the home page, beside the switch. */
export function MerchantSectionsButton({ compact = false }: { compact?: boolean }) {
  return (
    <Suspense fallback={<SectionsSheet pathname={null} compact={compact} />}>
      <CurrentSheet compact={compact} />
    </Suspense>
  );
}

/** The tier's badge beside the button on a phone, where the panel stays closed. */
export function MerchantPhoneBar() {
  return (
    <div className="flex items-center gap-2 lg:hidden">
      <MerchantSectionsButton />
      <MerchantTierBadge />
    </div>
  );
}
