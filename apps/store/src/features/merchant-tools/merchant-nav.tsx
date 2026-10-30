'use client';

import { Button } from '@vertex-digital/ui/components/button';
import { AscentBar } from '@vertex-digital/ui/components/page-header';
import { Sheet, SheetContent, SheetTitle } from '@vertex-digital/ui/components/sheet';
import { Skeleton } from '@vertex-digital/ui/components/skeleton';
import {
  BellIcon,
  ChevronsUpDownIcon,
  FileTextIcon,
  GaugeIcon,
  LayersIcon,
  type LucideIcon,
  MedalIcon,
  ReceiptTextIcon,
  ScrollTextIcon,
  StoreIcon,
  TagsIcon,
  XIcon,
} from 'lucide-react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { Suspense, useEffect, useState } from 'react';
import { readSessionResult } from '@/lib/session';
import { type MerchantMessageKey, tm } from './i18n';
import { MerchantTierBadge } from './tier-state';

const GROUPS: readonly {
  label: MerchantMessageKey;
  links: readonly { href: string; label: MerchantMessageKey; icon: LucideIcon }[];
}[] = [
  {
    label: 'nav.groups.overview',
    links: [
      { href: '/merchant', label: 'nav.dashboard', icon: GaugeIcon },
      { href: '/merchant/tier', label: 'nav.tier', icon: MedalIcon },
    ],
  },
  {
    label: 'nav.groups.selling',
    links: [
      { href: '/merchant/pos', label: 'nav.pos', icon: StoreIcon },
      { href: '/merchant/bulk', label: 'nav.bulk', icon: LayersIcon },
    ],
  },
  {
    label: 'nav.groups.pricing',
    links: [
      { href: '/merchant/prices', label: 'nav.prices', icon: TagsIcon },
      { href: '/merchant/price-list', label: 'nav.priceList', icon: ScrollTextIcon },
    ],
  },
  {
    label: 'nav.groups.account',
    links: [
      { href: '/merchant/statements', label: 'nav.statements', icon: FileTextIcon },
      { href: '/merchant/alerts', label: 'nav.alerts', icon: BellIcon },
      { href: '/merchant/receipt', label: 'nav.receipt', icon: ReceiptTextIcon },
    ],
  },
];

const isCurrent = (href: string, pathname: string | null) =>
  pathname !== null &&
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

function SectionLinks({
  pathname,
  onNavigate,
}: {
  pathname: string | null;
  onNavigate?: () => void;
}) {
  return (
    <nav aria-label={tm('title')} className="flex flex-col gap-4">
      {GROUPS.map((group) => (
        <div key={group.label} className="flex flex-col gap-1">
          <p aria-hidden="true" className="px-3 text-xs font-medium text-muted-foreground">
            {tm(group.label)}
          </p>
          <ul aria-label={tm(group.label)} className="flex flex-col gap-0.5">
            {group.links.map(({ href, label, icon: Icon }) => {
              const current = isCurrent(href, pathname);
              return (
                <li key={href}>
                  <Link
                    href={href}
                    prefetch={false}
                    aria-current={current ? 'page' : undefined}
                    onClick={onNavigate}
                    className={`relative flex min-h-11 items-center gap-3 rounded-md ps-4 pe-3 text-md transition-colors duration-150 ${
                      current
                        ? 'bg-muted font-medium text-foreground'
                        : 'text-muted-foreground hover:bg-muted hover:text-foreground'
                    }`}
                  >
                    {current && <AscentBar className="absolute start-2 h-5" />}
                    <Icon
                      className={`size-5 shrink-0 ${current ? 'text-accent-text' : ''}`}
                      strokeWidth={1.75}
                      aria-hidden="true"
                    />
                    {tm(label)}
                  </Link>
                </li>
              );
            })}
          </ul>
        </div>
      ))}
    </nav>
  );
}

/** The merchant's name and tier: the sidebar's top; only the badge, beside the button, on a phone. */
function MerchantIdentity() {
  const name = useMerchantName();
  return (
    <div className="order-1 flex shrink-0 flex-col items-start gap-2 lg:order-none lg:border-b lg:border-border lg:px-3 lg:pt-1 lg:pb-4">
      <div className="hidden w-full lg:block">
        {name === undefined && <Skeleton className="h-6 w-32" aria-hidden="true" />}
        {name && <p className="font-bold wrap-anywhere text-foreground">{name}</p>}
      </div>
      <MerchantTierBadge />
    </div>
  );
}

/**
 * The sections with the current one marked; `pathname` null before the URL is known (the
 * `<Suspense>` fallback on a dynamic page, the statement of a month). Below `lg` a button naming
 * the current section opens them in a bottom sheet, within the thumb's reach and above the bottom
 * bar; the sidebar's list is hidden there, so one list is ever exposed.
 */
function MerchantSections({ pathname }: { pathname: string | null }) {
  const [open, setOpen] = useState(false);
  const section = GROUPS.flatMap((group) => group.links).find((link) =>
    isCurrent(link.href, pathname),
  );
  const SectionIcon = section?.icon ?? GaugeIcon;
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
        className="min-w-0 flex-1 justify-start lg:hidden"
        onClick={() => setOpen(true)}
      >
        <SectionIcon className="text-accent-text" strokeWidth={1.75} aria-hidden="true" />
        <span className="min-w-0 truncate">{sectionName}</span>
        <ChevronsUpDownIcon
          className="ms-auto text-muted-foreground"
          strokeWidth={1.75}
          aria-hidden="true"
        />
      </Button>
      <div className="hidden lg:block">
        <SectionLinks pathname={pathname} />
      </div>
      <Sheet open={open} onOpenChange={setOpen}>
        <SheetContent
          side="bottom"
          className="gap-3 bg-surface p-4 pb-[calc(1rem+env(safe-area-inset-bottom))]"
        >
          <div className="flex items-center justify-between gap-2 ps-3">
            <SheetTitle className="text-lg font-bold">{tm('title')}</SheetTitle>
            <Button
              variant="ghost"
              size="icon"
              className="size-11"
              aria-label={tm('common.close')}
              onClick={() => setOpen(false)}
            >
              <XIcon strokeWidth={1.75} aria-hidden="true" />
            </Button>
          </div>
          <SectionLinks pathname={pathname} onNavigate={() => setOpen(false)} />
        </SheetContent>
      </Sheet>
    </>
  );
}

function CurrentSections() {
  return <MerchantSections pathname={usePathname()} />;
}

/**
 * The merchant area's navigation (S21 screens): a sticky sidebar on a wide screen. The identity
 * stays outside the `<Suspense>`: the tier's read may land before that boundary hydrates, and a
 * badge inside it would then not match the server's placeholder.
 */
export function MerchantNav() {
  return (
    <aside className="flex items-center gap-2 lg:sticky lg:top-6 lg:col-start-1 lg:row-span-2 lg:row-start-1 lg:max-h-[calc(100dvh-3rem)] lg:flex-col lg:items-stretch lg:gap-4 lg:self-start lg:overflow-y-auto lg:rounded-lg lg:border lg:border-border lg:bg-surface lg:p-3">
      <MerchantIdentity />
      {/* A dynamic page (a month's statement) knows its URL only at request time. */}
      <Suspense fallback={<MerchantSections pathname={null} />}>
        <CurrentSections />
      </Suspense>
    </aside>
  );
}
