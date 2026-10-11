'use client';

import { useEffect, useState } from 'react';
import { isFrozen, readSession } from '@/lib/session';

/*
 * Who is visiting the game page (S09 rule BB3), read in the browser so the page stays cached. Its
 * own small module: the game page loads it at once, the buy box only when a pack is chosen. S12
 * CF5: `frozen` disables buying, the cart's slide, the player check and the deposit wizard.
 */

export type Customer =
  | { status: 'loading' }
  | { status: 'signedOut' }
  | { status: 'signedIn'; email: string; verified: boolean; frozen: boolean };

export function useCustomer(): Customer {
  const [customer, setCustomer] = useState<Customer>({ status: 'loading' });
  useEffect(() => {
    let live = true;
    void readSession().then((session) => {
      if (!live) return;
      setCustomer(
        session
          ? {
              status: 'signedIn',
              email: session.user.email,
              verified: session.user.emailVerified !== false,
              frozen: isFrozen(session),
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

/** Rule CF5: a signed-in customer whose account is frozen. */
export const isFrozenCustomer = (customer: Customer): boolean =>
  customer.status === 'signedIn' && customer.frozen;
