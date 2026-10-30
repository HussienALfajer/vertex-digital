import { VertexMark } from '@vertex-digital/ui/brand/logo';
import { Button } from '@vertex-digital/ui/components/button';
import Link from 'next/link';
import { Suspense } from 'react';
import { siteContent } from '@/features/content/data';
import { SearchButton } from '@/features/search/search-trigger';
import { t } from '@/lib/i18n';
import { AccountLink } from './account-link';
import { CartButton } from './cart-button';
import { ThemeToggle } from './theme-toggle';

/** Rule C16: "إنشاء حساب" while registration is open; no answer leaves only "دخول". */
function SignUpButton({ className }: { className?: string }) {
  return (
    <Button
      variant="ghost"
      size="xl"
      className={`px-4 ${className ?? ''}`}
      render={<Link href="/sign-up" prefetch={false} />}
    >
      {t('header.signUp')}
    </Button>
  );
}

async function HeaderSignUp() {
  const site = await siteContent();
  return site?.registrationOpen ? <SignUpButton /> : null;
}

export function SiteHeader() {
  return (
    <header className="group/header border-b border-border bg-background">
      <div className="mx-auto flex h-16 max-w-6xl items-center justify-between gap-2 px-4">
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
        {/* No gap at phone width, where the search and the cart live in the bottom bar (S24 NH5; the
            search button stays mounted, it holds the dialog). Signed in, the theme switch moves into
            the account menu there; also while the signed-in placeholder shows. */}
        <div className="flex items-center sm:gap-1">
          <span className="flex items-center max-sm:hidden sm:gap-1">
            <SearchButton />
            <CartButton />
          </span>
          <span className="flex max-sm:group-has-data-signed-in/header:hidden max-sm:[[data-signed-in-hint]_&]:hidden">
            <ThemeToggle />
          </span>
          {/* In the cached HTML, its place held meanwhile so nothing shifts; signed in or about to
              be (the hint), the account's parts take its place. */}
          <span className="hidden sm:flex sm:group-has-data-signed-in/header:hidden sm:[[data-signed-in-hint]_&]:hidden">
            <Suspense fallback={<SignUpButton className="invisible" />}>
              <HeaderSignUp />
            </Suspense>
          </span>
          <AccountLink />
        </div>
      </div>
    </header>
  );
}
