import { useQueryClient } from '@tanstack/react-query';
import { Link, type LinkProps, useRouter } from '@tanstack/react-router';
import {
  Avatar,
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
  VertexMark,
} from '@vertex-digital/ui';
import { ChevronDownIcon, HouseIcon, LogOutIcon, type LucideIcon, MenuIcon } from 'lucide-react';
import { type ReactNode, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { authClient, leaveSession, type StaffSession, useSession } from '../lib/auth';
import { ThemeToggle } from './theme-toggle';

interface NavItem {
  to: LinkProps['to'];
  label: 'nav.home';
  icon: LucideIcon;
  /** Active only on this exact path; otherwise also on its sub-pages. */
  exact?: boolean;
}

/** Each feature adds its section here, hidden from staff without its permission (cosmetic). */
const navItems: NavItem[] = [{ to: '/', label: 'nav.home', icon: HouseIcon, exact: true }];

export function AppShell({ children }: { children: ReactNode }) {
  const { t } = useTranslation();
  const session = useSession();
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
          <div className="mx-auto flex max-w-6xl flex-col gap-8 px-4 py-8 md:px-8">{children}</div>
        </main>
      </div>
    </div>
  );
}

const navLink = cn(
  'relative flex h-10 items-center gap-3 rounded-md px-3 text-base text-sidebar-muted-foreground transition-colors duration-150 ease-out',
  'hover:bg-sidebar-hover hover:text-sidebar-foreground',
  'data-[status=active]:bg-sidebar-active data-[status=active]:font-medium data-[status=active]:text-sidebar-foreground',
  'before:absolute before:inset-y-2 before:start-0 before:w-0.5 before:bg-sidebar-marker before:opacity-0 data-[status=active]:before:opacity-100',
);

/** Vertex Green navigation with the sand mark and a sand marker on the active item (§2). */
function Sidebar({ onNavigate }: { onNavigate?: () => void }) {
  const { t } = useTranslation();
  return (
    <div className="flex h-full w-full flex-col border-e border-sidebar-border bg-sidebar text-sidebar-foreground [--ring:var(--sidebar-ring)]">
      <div className="flex h-16 shrink-0 items-center gap-3 border-b border-sidebar-border px-5">
        <VertexMark className="w-8 text-sidebar-marker" />
        <div className="flex flex-col">
          <span className="text-base font-bold" dir="ltr">
            {t('app.name')}
          </span>
          <span className="text-xs text-sidebar-muted-foreground">{t('app.panel')}</span>
        </div>
      </div>
      <nav
        aria-label={t('nav.label')}
        className="flex min-h-0 flex-1 flex-col gap-1 overflow-y-auto p-3"
      >
        {navItems.map(({ to, label, icon: Icon, exact }) => (
          <Link
            key={to}
            to={to}
            onClick={onNavigate}
            activeOptions={{ exact: exact ?? false }}
            className={navLink}
          >
            <Icon className="size-5" />
            {t(label)}
          </Link>
        ))}
      </nav>
    </div>
  );
}

function TopBar({ session }: { session: StaffSession }) {
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

function UserMenu({ session }: { session: StaffSession }) {
  const { t } = useTranslation();
  const router = useRouter();
  const queryClient = useQueryClient();
  const { user } = session;

  async function signOut() {
    await authClient.signOut();
    await leaveSession(queryClient, () => router.navigate({ to: '/login' }));
  }

  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={<Button variant="ghost" className="h-10 gap-2 px-2" aria-label={t('user.menu')} />}
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
          <span className="mt-1 text-xs text-muted-foreground">{t(`roles.${user.role}`)}</span>
        </DropdownMenuHeader>
        <DropdownMenuItem onClick={signOut}>
          <LogOutIcon className="rtl:-scale-x-100" />
          {t('user.signOut')}
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
