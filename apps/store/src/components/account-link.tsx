'use client';

import { Button } from '@vertex-digital/ui/components/button';
import dynamic from 'next/dynamic';
import Link from 'next/link';
import { useEffect, useState } from 'react';
import { t } from '@/lib/i18n';
import { readSessionResult, type Session } from '@/lib/session';

/** A failed session read is tried again after this long, and when the tab is seen again. */
const RETRY_MS = 5_000;

/** The signed-in header's shape (balance, bell, menu) while it loads. */
function SignedInPlaceholder({ className }: { className?: string }) {
  return (
    <div aria-hidden="true" className={`items-center sm:gap-1 ${className ?? 'flex'}`}>
      {/* The Skeleton component's classes, without its import in every page's first load. */}
      <span className="h-11 w-24 animate-pulse rounded-md bg-muted" />
      <span className="size-11 animate-pulse rounded-md bg-muted" />
      <span className="size-11 animate-pulse rounded-full bg-muted" />
    </div>
  );
}

// Only signed-in customers download the balance, the bell and the menu, as one chunk: the first
// load stays within its budget.
const SignedInHeader = dynamic(
  () => import('./signed-in-header').then((module) => module.SignedInHeader),
  { loading: () => <SignedInPlaceholder /> },
);

/**
 * The header's account entry. Read in the browser, so every page stays static and cacheable:
 * "sign in" (beside the server's "create account", `SiteHeader`) until a session is known to exist,
 * then the wallet balance (rule W8 of S02), the notification bell (S05) and the
 * customer's initial with the account menu. While the session is read, a browser that was signed
 * in last time (`data-signed-in-hint`, set before paint by SESSION_HINT_SCRIPT) shows the
 * signed-in placeholder instead of flashing "sign in".
 */
export function AccountLink() {
  // Undefined while the read is under way.
  const [session, setSession] = useState<Session | undefined>(undefined);

  useEffect(() => {
    let active = true;
    let retry: ReturnType<typeof setTimeout> | undefined;
    // A failed read is not "signed out" (audit A10-17): the header keeps its placeholder (or the
    // sign-in button for a browser with no hint) and reads again, instead of telling a signed-in
    // customer to sign in until the next full page load.
    const read = () =>
      readSessionResult().then(({ session: value, known }) => {
        if (!active) return;
        if (!known) {
          clearTimeout(retry);
          retry = setTimeout(read, RETRY_MS);
          return;
        }
        document.removeEventListener('visibilitychange', onVisible);
        setSession(value);
        if (value) return;
        // Signed out since the last visit: the phone header shows the theme switch again.
        document.documentElement.removeAttribute('data-signed-in-hint');
      });
    const onVisible = () => {
      if (document.visibilityState === 'visible') void read();
    };
    document.addEventListener('visibilitychange', onVisible);
    void read();
    return () => {
      active = false;
      clearTimeout(retry);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, []);

  if (session) {
    return (
      <SignedInHeader
        name={session.user.name}
        email={session.user.email}
        merchant={session.user.accountType === 'merchant'}
      />
    );
  }

  const signedOut = (
    <div
      className={`items-center gap-1 ${session === undefined ? 'flex [[data-signed-in-hint]_&]:hidden' : 'flex'}`}
    >
      {/* Not prefetched: the sign-in page carries the form validation (Zod), which every visitor
          of every page would otherwise download (the performance budget, e2e/store.spec.ts). */}
      <Button
        variant="outline"
        size="xl"
        className="px-4"
        render={<Link href="/sign-in" prefetch={false} />}
      >
        {t('header.signIn')}
      </Button>
    </div>
  );

  if (session === null) return signedOut;
  return (
    <>
      <SignedInPlaceholder className="hidden [[data-signed-in-hint]_&]:flex" />
      {signedOut}
    </>
  );
}
