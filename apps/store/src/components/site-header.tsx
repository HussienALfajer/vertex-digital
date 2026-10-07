import { VertexMark } from '@vertex-digital/ui/brand/logo';
import Link from 'next/link';
import { t } from '@/lib/i18n';
import { AccountLink } from './account-link';
import { ThemeToggle } from './theme-toggle';

export function SiteHeader() {
  return (
    <header className="border-b border-border bg-background">
      <div className="mx-auto flex h-16 max-w-6xl items-center justify-between gap-4 px-4">
        <Link
          href="/"
          aria-label={t('app.home')}
          className="flex min-h-11 items-center gap-2 rounded-md text-accent-text"
        >
          <VertexMark className="w-8" />
          <span
            className="hidden text-lg font-bold whitespace-nowrap text-foreground sm:inline"
            dir="ltr"
          >
            {t('app.name')}
          </span>
        </Link>
        <div className="flex items-center gap-1">
          <ThemeToggle />
          <AccountLink />
        </div>
      </div>
    </header>
  );
}
