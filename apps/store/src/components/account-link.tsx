'use client';

import { Button } from '@vertex-digital/ui/components/button';
import Link from 'next/link';
import { useEffect, useState } from 'react';
import { t } from '@/lib/i18n';

type Session = { user: { name: string; email: string } } | null;

/**
 * The header's account entry. Read in the browser, so every page stays static and cacheable:
 * a sign-in link until the session is known to exist, then the customer's name and sign-out.
 */
export function AccountLink() {
  const [session, setSession] = useState<Session>(null);

  useEffect(() => {
    let active = true;
    fetch('/api/auth/get-session', { credentials: 'same-origin' })
      .then((response) => (response.ok ? (response.json() as Promise<Session>) : null))
      .then((value) => active && setSession(value))
      .catch(() => {});
    return () => {
      active = false;
    };
  }, []);

  if (!session) {
    return (
      // Not prefetched: the sign-in page carries the form validation (Zod), which every visitor
      // of every page would otherwise download (the performance budget, e2e/store.spec.ts).
      <Button
        variant="outline"
        size="xl"
        className="px-4"
        render={<Link href="/sign-in" prefetch={false} />}
      >
        {t('header.signIn')}
      </Button>
    );
  }

  const signOut = async () => {
    await fetch('/api/auth/sign-out', { method: 'POST', credentials: 'same-origin' }).catch(
      () => {},
    );
    setSession(null);
  };

  return (
    <div className="flex items-center gap-2">
      <span className="hidden text-sm text-muted-foreground sm:inline">{session.user.name}</span>
      <Button variant="ghost" size="xl" onClick={signOut}>
        {t('header.signOut')}
      </Button>
    </div>
  );
}
