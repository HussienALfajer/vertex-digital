'use client';

import { useEffect, useState } from 'react';

/*
 * Who is visiting the game page (S09 rule BB3), read in the browser so the page stays cached. Its
 * own small module: the game page loads it at once, the buy box only when a pack is chosen.
 */

export type Customer =
  | { status: 'loading' }
  | { status: 'signedOut' }
  | { status: 'signedIn'; email: string; verified: boolean };

type Session = { user: { email: string; emailVerified?: boolean } } | null;

export function useCustomer(): Customer {
  const [customer, setCustomer] = useState<Customer>({ status: 'loading' });
  useEffect(() => {
    let live = true;
    fetch('/api/auth/get-session', { credentials: 'same-origin', cache: 'no-store' })
      .then((response) => (response.ok ? (response.json() as Promise<Session>) : null))
      .catch(() => null)
      .then((session) => {
        if (!live) return;
        setCustomer(
          session
            ? {
                status: 'signedIn',
                email: session.user.email,
                verified: session.user.emailVerified !== false,
              }
            : { status: 'signedOut' },
        );
      });
    return () => {
      live = false;
    };
  }, []);
  return customer;
}
