import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, type LinkProps, useRouter, useRouterState } from '@tanstack/react-router';
import {
  Avatar,
  Badge,
  Button,
  cn,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuHeader,
  DropdownMenuItem,
  DropdownMenuTrigger,
  Sheet,
  SheetContent,
  SheetTitle,
  SheetTrigger,
  toast,
  VertexMark,
} from '@vertex-digital/ui';
import {
  ArrowDownToLineIcon,
  ChartColumnIcon,
  ChevronDownIcon,
  ContactRoundIcon,
  Gamepad2Icon,
  HouseIcon,
  LifeBuoyIcon,
  LogOutIcon,
  type LucideIcon,
  MenuIcon,
  NewspaperIcon,
  PercentIcon,
  ScanSearchIcon,
  ScrollTextIcon,
  SettingsIcon,
  ShoppingBagIcon,
  StoreIcon,
  TruckIcon,
  UserRoundCogIcon,
  UsersRoundIcon,
  WalletIcon,
} from 'lucide-react';
import { type ReactNode, useLayoutEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { depositCountsQuery } from '../features/deposits/deposits.queries';
import { waitingApplicationsQuery } from '../features/merchants/merchants.queries';
import { orderCountsQuery } from '../features/orders/orders.queries';
import { openReviewCountQuery } from '../features/pricing/pricing.queries';
import { StaleRateBanner } from '../features/rates/stale-rate-banner';
import { reconciliationCountsQuery } from '../features/reconciliation/reconciliation.queries';
import { SwitchesBanner } from '../features/settings/switches-banner';
import { newPacksQuery } from '../features/suppliers/suppliers.queries';
import { supportOpenCountQuery } from '../features/support/support.queries';
import { type AdminSession, signOutAndLeave, useSession } from '../lib/auth';
import { ThemeToggle } from './theme-toggle';

type NavPath = NonNullable<LinkProps['to']>;

interface NavItem {
  to: NavPath;
  label:
    | 'nav.home'
    | 'nav.orders'
    | 'nav.deposits'
    | 'nav.wallets'
    | 'nav.customers'
    | 'nav.merchants'
    | 'nav.support'
    | 'nav.catalog'
    | 'nav.content'
    | 'nav.suppliers'
    | 'nav.pricing'
    | 'nav.reconciliation'
    | 'nav.reports'
    | 'nav.settings'
    | 'nav.audit'
    | 'nav.testCustomers'
    | 'nav.account';
  icon: LucideIcon;
  /** Active only on this exact path; otherwise also on its sub-pages. */
  exact?: boolean;
  /** Pages of the section, listed under it. */
  children?: NavChild[];
}

interface NavChild {
  to: NavPath;
  label:
    | 'nav.catalogGames'
    | 'nav.quickLinks'
    | 'nav.allOrders'
    | 'nav.liveOrders'
    | 'nav.depositRequests'
    | 'nav.usdtTransfers'
    | 'nav.depositSettings'
    | 'nav.tickets'
    | 'nav.supportSettings'
    | 'nav.priceReviews'
    | 'nav.priceLists'
    | 'nav.priceMatrix'
    | 'nav.rates'
    | 'nav.switches'
    | 'nav.telegram'
    | 'nav.merchantApplications'
    | 'nav.merchantsList'
    | 'nav.merchantTiers'
    | 'nav.merchantSettings';
  /** Sub-pages with their own navigation items, where this one is not active. */
  except?: readonly string[];
}

/** Each feature adds its section here. One admin, full access: no permission checks (ADR 0016). */
const navItems: NavItem[] = [
  { to: '/', label: 'nav.home', icon: HouseIcon, exact: true },
  {
    to: '/orders',
    label: 'nav.orders',
    icon: ShoppingBagIcon,
    children: [
      { to: '/orders', label: 'nav.allOrders', except: ['/orders/live'] },
      { to: '/orders/live', label: 'nav.liveOrders' },
    ],
  },
  {
    to: '/deposits',
    label: 'nav.deposits',
    icon: ArrowDownToLineIcon,
    children: [
      { to: '/deposits', label: 'nav.depositRequests', except: ['/deposits/transfers'] },
      { to: '/deposits/transfers', label: 'nav.usdtTransfers' },
      { to: '/settings/deposits', label: 'nav.depositSettings' },
    ],
  },
  { to: '/wallets', label: 'nav.wallets', icon: WalletIcon },
  { to: '/customers', label: 'nav.customers', icon: ContactRoundIcon },
  {
    to: '/merchants/applications',
    label: 'nav.merchants',
    icon: StoreIcon,
    children: [
      { to: '/merchants/applications', label: 'nav.merchantApplications' },
      {
        to: '/merchants',
        label: 'nav.merchantsList',
        except: ['/merchants/applications', '/merchants/tiers'],
      },
      { to: '/merchants/tiers', label: 'nav.merchantTiers' },
      { to: '/settings/merchants', label: 'nav.merchantSettings' },
    ],
  },
  {
    to: '/support',
    label: 'nav.support',
    icon: LifeBuoyIcon,
    children: [
      { to: '/support', label: 'nav.tickets' },
      { to: '/settings/support', label: 'nav.supportSettings' },
    ],
  },
  {
    to: '/catalog',
    label: 'nav.catalog',
    icon: Gamepad2Icon,
    children: [
      { to: '/catalog', label: 'nav.catalogGames', except: ['/catalog/quick-links'] },
      { to: '/catalog/quick-links', label: 'nav.quickLinks' },
    ],
  },
  { to: '/content', label: 'nav.content', icon: NewspaperIcon },
  { to: '/suppliers', label: 'nav.suppliers', icon: TruckIcon },
  {
    to: '/pricing/lists',
    label: 'nav.pricing',
    icon: PercentIcon,
    children: [
      { to: '/pricing/lists', label: 'nav.priceLists' },
      { to: '/pricing/matrix', label: 'nav.priceMatrix' },
      { to: '/pricing/reviews', label: 'nav.priceReviews' },
      { to: '/rates', label: 'nav.rates' },
    ],
  },
  { to: '/reconciliation', label: 'nav.reconciliation', icon: ScanSearchIcon },
  { to: '/reports', label: 'nav.reports', icon: ChartColumnIcon },
  {
    to: '/settings/switches',
    label: 'nav.settings',
    icon: SettingsIcon,
    children: [
      { to: '/settings/switches', label: 'nav.switches' },
      { to: '/settings/telegram', label: 'nav.telegram' },
    ],
  },
  { to: '/audit', label: 'nav.audit', icon: ScrollTextIcon },
  { to: '/test-customers', label: 'nav.testCustomers', icon: UsersRoundIcon },
  { to: '/account', label: 'nav.account', icon: UserRoundCogIcon },
];

/** The badge each page carries, beside its link. */
const navBadges: Partial<Record<string, () => ReactNode>> = {
  '/orders': OrdersBadge,
  '/deposits': DepositsBadge,
  '/deposits/transfers': TransfersBadge,
  '/pricing/reviews': ReviewsBadge,
  '/suppliers': SuppliersBadge,
  '/support': SupportBadge,
  '/reconciliation': ReconciliationBadge,
  '/merchants/applications': MerchantApplicationsBadge,
};

/**
 * The navigation item a page belongs to: the deepest whose path holds it, a section's own page
 * under its section (audit A10-28).
 */
export function navLabelOf(pathname: string): NavItem['label'] | NavChild['label'] | null {
  const holds = (to: string, exact?: boolean) =>
    pathname === to || (!exact && to !== '/' && pathname.startsWith(`${to}/`));
  let best: { label: NavItem['label'] | NavChild['label']; length: number } | null = null;
  for (const item of navItems) {
    const entries = [
      { to: item.to, label: item.label, exact: item.exact },
      ...(item.children ?? []),
    ];
    for (const entry of entries) {
      // At equal length a section's own child wins ("كل الطلبات" over "الطلبات").
      if (
        holds(entry.to, 'exact' in entry ? entry.exact : false) &&
        entry.to.length >= (best?.length ?? -1)
      ) {
        best = { label: entry.label, length: entry.to.length };
      }
    }
  }
  return best?.label ?? null;
}

export function AppShell({ children }: { children: ReactNode }) {
  const { t } = useTranslation();
  const session = useSession();
  const pathname = useRouterState({ select: (state) => state.location.pathname });
  // Each tab and history entry names its page (WCAG 2.4.2, audit A10-28). A layout effect, so a
  // page that writes its own title (the live room's counts) does it after.
  useLayoutEffect(() => {
    const label = navLabelOf(pathname);
    document.title = label ? `${t(label)} · ${t('app.name')}` : t('app.name');
  }, [pathname, t]);
  return (
    <div className="flex min-h-dvh bg-background">
      {/* Keyboard users skip the navigation on every page (WCAG 2.4.1). */}
      <a
        href="#main"
        className="sr-only focus-visible:not-sr-only focus-visible:fixed focus-visible:start-4 focus-visible:top-4 focus-visible:z-50 focus-visible:rounded-md focus-visible:bg-surface focus-visible:px-4 focus-visible:py-2 focus-visible:text-sm focus-visible:font-medium focus-visible:text-foreground focus-visible:shadow-float"
      >
        {t('nav.skip')}
      </a>
      <aside className="sticky top-0 hidden h-dvh w-64 shrink-0 md:flex">
        <Sidebar />
      </aside>
      <div className="flex min-w-0 flex-1 flex-col">
        <TopBar session={session} />
        <main id="main" tabIndex={-1} className="flex-1 outline-none">
          <div className="mx-auto flex max-w-6xl flex-col gap-8 px-4 py-8 md:px-8">
            <SwitchesBanner />
            <StaleRateBanner />
            {children}
          </div>
        </main>
      </div>
    </div>
  );
}

const navLink = cn(
  'relative flex items-center rounded-md text-sidebar-muted-foreground transition-colors duration-150 ease-out',
  'hover:bg-sidebar-hover hover:text-sidebar-foreground',
  'data-[status=active]:bg-sidebar-active data-[status=active]:font-medium data-[status=active]:text-sidebar-foreground',
  'before:absolute before:inset-y-2 before:start-0 before:w-0.5 before:bg-sidebar-marker before:opacity-0 data-[status=active]:before:opacity-100',
);

/** A section with pages under it: the active page is marked, the section only brightens. */
const navSection = cn(
  'flex items-center rounded-md text-sidebar-muted-foreground transition-colors duration-150 ease-out',
  'hover:bg-sidebar-hover hover:text-sidebar-foreground',
  'data-[current=true]:font-medium data-[current=true]:text-sidebar-foreground',
);

/** Vertex Green navigation with the sand mark and a sand marker on the active item (§2). */
function Sidebar({ onNavigate }: { onNavigate?: () => void }) {
  const { t } = useTranslation();
  const pathname = useRouterState({ select: (state) => state.location.pathname });
  // A section brightens on any of its pages, some of which live under another path (settings).
  const within = (to: string) => pathname === to || pathname.startsWith(`${to}/`);
  return (
    <div className="flex h-full w-full flex-col border-e border-sidebar-border bg-sidebar text-sidebar-foreground [--ring:var(--sidebar-ring)]">
      <div className="flex h-16 shrink-0 items-center gap-3 border-b border-sidebar-border px-5">
        <VertexMark className="w-8 text-sidebar-marker" />
        <span className="text-lg font-bold">{t('app.name')}</span>
      </div>
      {/* The links scroll under the fixed header on short screens and phones. */}
      <nav
        aria-label={t('nav.label')}
        className="flex min-h-0 flex-1 flex-col gap-1 overflow-y-auto p-3"
      >
        {navItems.map(({ to, label, icon: Icon, exact, children }) => {
          const NavBadge = navBadges[to];
          return (
            <div key={label} className="flex flex-col gap-1">
              <Link
                to={to}
                onClick={onNavigate}
                activeOptions={{ exact: exact ?? false }}
                data-current={children ? children.some((child) => within(child.to)) : undefined}
                className={cn(
                  children ? navSection : navLink,
                  'h-10 gap-3 px-3 text-base pointer-coarse:h-11',
                )}
              >
                <Icon className="size-5" />
                {t(label)}
                {!children && NavBadge && <NavBadge />}
              </Link>
              {children && (
                <div className="flex flex-col gap-0.5">
                  {children.map((child) => {
                    const ChildBadge = navBadges[child.to];
                    return (
                      <Link
                        key={child.label}
                        to={child.to}
                        onClick={onNavigate}
                        activeOptions={{
                          exact: child.except?.some((path) => pathname.startsWith(path)) ?? false,
                          includeSearch: false,
                        }}
                        className={cn(navLink, 'h-8 gap-3 ps-11 pe-3 text-sm pointer-coarse:h-11')}
                      >
                        {t(child.label)}
                        {ChildBadge && <ChildBadge />}
                      </Link>
                    );
                  })}
                </div>
              )}
            </div>
          );
        })}
      </nav>
    </div>
  );
}

/**
 * The deposits waiting for review, read every 30 seconds in the background; red when any of them
 * is flagged (S03 screens). Nothing while there are none or the count could not be read.
 */
function DepositsBadge() {
  const { t } = useTranslation();
  const counts = useQuery(depositCountsQuery);
  // F4-8: what the admin must decide, not a USDT deposit the worker is still checking.
  const submitted = counts.data?.waiting ?? 0;
  if (submitted === 0) return null;
  const flagged = (counts.data?.waitingFlagged ?? 0) > 0;
  return (
    <Badge
      tone={flagged ? 'danger' : 'gold'}
      className="ms-auto tabular-nums"
      aria-label={
        flagged
          ? t('nav.depositsBadgeFlagged', { submitted })
          : t('nav.depositsBadge', { submitted })
      }
    >
      {submitted}
    </Badge>
  );
}

/** S04 rule U13: the unmatched USDT transfers of the last 30 days, from the same counts. */
function TransfersBadge() {
  const { t } = useTranslation();
  const counts = useQuery(depositCountsQuery);
  const unmatched = counts.data?.unmatchedTransfers ?? 0;
  if (unmatched === 0) return null;
  return (
    <Badge
      tone="gold"
      className="ms-auto tabular-nums"
      aria-label={t('nav.usdtTransfersBadge', { unmatched })}
    >
      {unmatched}
    </Badge>
  );
}

/**
 * S08: the orders held for review and the manual orders waiting, read every minute in the
 * background; red while any order is held.
 */
function OrdersBadge() {
  const { t } = useTranslation();
  const counts = useQuery(orderCountsQuery);
  const needsReview = counts.data?.needsReview ?? 0;
  const manualWaiting = counts.data?.manualWaiting ?? 0;
  const total = needsReview + manualWaiting;
  if (total === 0) return null;
  return (
    <Badge
      tone={needsReview > 0 ? 'danger' : 'gold'}
      className="ms-auto tabular-nums"
      aria-label={t('nav.ordersBadge', { needsReview, manualWaiting })}
    >
      {total}
    </Badge>
  );
}

/** S13: the open mismatches, read every minute in the background; always red (rule RN7). */
function ReconciliationBadge() {
  const { t } = useTranslation();
  const counts = useQuery(reconciliationCountsQuery);
  const open = counts.data?.open ?? 0;
  if (open === 0) return null;
  return (
    <Badge
      tone="danger"
      className="ms-auto tabular-nums"
      aria-label={t('nav.reconciliationBadge', { open })}
    >
      {open}
    </Badge>
  );
}

/** S16 SC11: the new packs in imported categories, read every minute in the background. */
function SuppliersBadge() {
  const { t } = useTranslation();
  const count = useQuery(newPacksQuery);
  const packs = count.data ?? 0;
  if (packs === 0) return null;
  return (
    <Badge
      tone="gold"
      className="ms-auto tabular-nums"
      aria-label={t('nav.suppliersBadge', { packs })}
    >
      {packs}
    </Badge>
  );
}

/** S07: the open price reviews, read every minute in the background. */
function ReviewsBadge() {
  const { t } = useTranslation();
  const count = useQuery(openReviewCountQuery);
  const open = count.data ?? 0;
  if (open === 0) return null;
  return (
    <Badge
      tone="gold"
      className="ms-auto tabular-nums"
      aria-label={t('nav.priceReviewsBadge', { open })}
    >
      {open}
    </Badge>
  );
}

/** S12 TK13: the tickets waiting for the admin's answer, read every minute in the background. */
function SupportBadge() {
  const { t } = useTranslation();
  const count = useQuery(supportOpenCountQuery);
  const open = count.data ?? 0;
  if (open === 0) return null;
  return (
    <Badge
      tone="gold"
      className="ms-auto tabular-nums"
      aria-label={t('nav.supportBadge', { open })}
    >
      {open}
    </Badge>
  );
}

/**
 * S20 MA8 (audit A07-12, A10-25): the merchant applications under review, read every minute in
 * the background through a count of its own.
 */
function MerchantApplicationsBadge() {
  const { t } = useTranslation();
  const count = useQuery(waitingApplicationsQuery);
  const waiting = count.data ?? 0;
  if (waiting === 0) return null;
  return (
    <Badge
      tone="gold"
      className="ms-auto tabular-nums"
      aria-label={t('nav.merchantApplicationsBadge', { waiting })}
    >
      {waiting}
    </Badge>
  );
}

function TopBar({ session }: { session: AdminSession }) {
  const { t } = useTranslation();
  const [navOpen, setNavOpen] = useState(false);
  return (
    <header className="sticky top-0 z-40 flex h-16 items-center justify-between gap-4 border-b border-border bg-surface px-4 md:px-8">
      <div className="flex items-center gap-2 md:invisible">
        <Sheet open={navOpen} onOpenChange={setNavOpen}>
          <SheetTrigger render={<Button variant="ghost" size="icon" aria-label={t('nav.open')} />}>
            <MenuIcon />
          </SheetTrigger>
          <SheetContent>
            <SheetTitle className="sr-only">{t('nav.label')}</SheetTitle>
            <Sidebar onNavigate={() => setNavOpen(false)} />
          </SheetContent>
        </Sheet>
        <VertexMark className="w-6 text-primary" label={t('app.brand')} />
      </div>
      <div className="flex items-center gap-2">
        <ThemeToggle />
        <UserMenu session={session} />
      </div>
    </header>
  );
}

function UserMenu({ session }: { session: AdminSession }) {
  const { t } = useTranslation();
  const router = useRouter();
  const queryClient = useQueryClient();
  const { user } = session;

  async function signOut() {
    const left = await signOutAndLeave(queryClient, () => router.navigate({ to: '/login' }));
    if (!left) toast.add({ title: t('user.signOutFailed'), type: 'error' });
  }

  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={
          <Button
            variant="ghost"
            className="h-10 gap-2 px-2 pointer-coarse:h-11"
            aria-label={t('user.menu')}
          />
        }
      >
        <Avatar name={user.name} size="sm" className="size-8" />
        <span className="hidden max-w-40 truncate text-sm font-medium sm:inline">{user.name}</span>
        <ChevronDownIcon className="size-4 text-muted-foreground" />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="min-w-60">
        <DropdownMenuHeader>
          <span className="font-medium">{user.name}</span>
          <span dir="ltr" className="text-end text-sm text-muted-foreground">
            {user.email}
          </span>
        </DropdownMenuHeader>
        <DropdownMenuItem render={<Link to="/account" />}>
          <UserRoundCogIcon />
          {t('user.account')}
        </DropdownMenuItem>
        <DropdownMenuItem onClick={signOut}>
          <LogOutIcon className="rtl:-scale-x-100" />
          {t('user.signOut')}
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
