'use client';

import { Button } from '@vertex-digital/ui/components/button';
import dynamic from 'next/dynamic';
import Link from 'next/link';
import { useEffect, useState } from 'react';
import { t } from '@/lib/i18n';
import { readSession, type Session } from '@/lib/session';

// Only signed-in customers download the balance, the bell and the menu, as one chunk: the first
// load stays within its budget.
const SignedInHeader = dynamic(() =>
  import('./signed-in-header').then((module) => module.SignedInHeader),
);

/**
 * The header's account entry. Read in the browser, so every page stays static and cacheable:
 * "sign in" (and "create account" while registration is open, rule C16) until a session is known
 * to exist, then the wallet balance (rule W8 of S02), the notification bell (S05) and the
 * customer's initial with the account menu.
 */
export function AccountLink() {
  const [session, setSession] = useState<Session>(null);
  const [canSignUp, setCanSignUp] = useState(false);

  useEffect(() => {
    let active = true;
    readSession().then(async (value) => {
      if (!active) return;
      setSession(value);
      if (value) return;
      const registration = await fetch('/api/auth/registration', {
        credentials: 'same-origin',
        cache: 'no-store',
      })
        .then((response) => (response.ok ? (response.json() as Promise<{ open: boolean }>) : null))
        .catch(() => null);
      if (active) setCanSignUp(registration?.open === true);
    });
    return () => {
      active = false;
    };
  }, []);

  if (session) return <SignedInHeader name={session.user.name} email={session.user.email} />;

  return (
    <div className="flex items-center gap-1">
      {canSignUp && (
        <Button
          variant="ghost"
          size="xl"
          className="hidden px-4 sm:inline-flex"
          render={<Link href="/sign-up" prefetch={false} />}
        >
          {t('header.signUp')}
        </Button>
      )}
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
}
