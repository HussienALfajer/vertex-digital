'use client';

import { Button } from '@vertex-digital/ui/components/button';
import dynamic from 'next/dynamic';
import Link from 'next/link';
import { useEffect, useState } from 'react';
import { t } from '@/lib/i18n';

type Session = { user: { name: string; email: string } } | null;

// Only signed-in customers download the menu: the first load stays within its budget.
const AccountMenu = dynamic(() => import('./account-menu').then((module) => module.AccountMenu));
const BalanceChip = dynamic(() =>
  import('@/features/wallet/balance-chip').then((module) => module.BalanceChip),
);

/**
 * The header's account entry. Read in the browser, so every page stays static and cacheable:
 * "sign in" (and "create account" while registration is open, rule C16) until a session is known
 * to exist, then the wallet balance (rule W8 of S02) and the customer's initial with the account
 * menu.
 */
export function AccountLink() {
  const [session, setSession] = useState<Session>(null);
  const [canSignUp, setCanSignUp] = useState(false);

  useEffect(() => {
    let active = true;
    const read = <T,>(path: string) =>
      fetch(path, { credentials: 'same-origin', cache: 'no-store' })
        .then((response) => (response.ok ? (response.json() as Promise<T>) : null))
        .catch(() => null);
    read<Session>('/api/auth/get-session').then(async (value) => {
      if (!active) return;
      setSession(value);
      if (value) return;
      const registration = await read<{ open: boolean }>('/api/auth/registration');
      if (active) setCanSignUp(registration?.open === true);
    });
    return () => {
      active = false;
    };
  }, []);

  if (session) {
    return (
      <div className="flex items-center gap-1">
        <BalanceChip />
        <AccountMenu name={session.user.name} email={session.user.email} />
      </div>
    );
  }

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
