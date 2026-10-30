'use client';

import { useEffect, useState, useSyncExternalStore } from 'react';
import { readSessionResult, SALE_MODE_KEY } from '@/lib/session';

/*
 * S21 PS1, PS6: the merchant's sale mode and "إخفاء التكلفة", remembered on this browser until
 * turned off. Light: the home and game pages import it at once, so no contracts and no catalog. A
 * preference of the screen, never an access decision: the API decides everything again, and
 * `useMerchantAccount` or `useCustomer` keep both away from anyone who is not a merchant.
 */

const HIDE_COST_KEY = 'vd-hide-cost';
const SALE_ATTRIBUTE = 'data-sale-mode-hint';

const listeners = new Set<() => void>();
// Without storage (private mode) a choice still holds until the page is left.
const memory = new Map<string, boolean>();

function read(key: string): boolean {
  try {
    return localStorage.getItem(key) === '1';
  } catch {
    return memory.get(key) ?? false;
  }
}

function write(key: string, on: boolean) {
  memory.set(key, on);
  try {
    if (on) localStorage.setItem(key, '1');
    else localStorage.removeItem(key);
  } catch {
    // Kept in memory above.
  }
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  window.addEventListener('storage', listener);
  return () => {
    listeners.delete(listener);
    window.removeEventListener('storage', listener);
  };
}

export const useSaleMode = () =>
  useSyncExternalStore(
    subscribe,
    () => read(SALE_MODE_KEY),
    () => false,
  );

export const useCostHidden = () =>
  useSyncExternalStore(
    subscribe,
    () => read(HIDE_COST_KEY),
    () => false,
  );

export function setSaleMode(on: boolean) {
  write(SALE_MODE_KEY, on);
  if (on) document.documentElement.setAttribute(SALE_ATTRIBUTE, '');
  else document.documentElement.removeAttribute(SALE_ATTRIBUTE);
}

export const setCostHidden = (on: boolean) => write(HIDE_COST_KEY, on);

export const toggleCostHidden = () => setCostHidden(!read(HIDE_COST_KEY));

/** Who may see the merchant tools on a public page; `unknown` when the session read failed. */
export type MerchantAccount = 'loading' | 'merchant' | 'other' | 'signedOut' | 'unknown';

export function useMerchantAccount(): MerchantAccount {
  const [account, setAccount] = useState<MerchantAccount>('loading');
  useEffect(() => {
    let live = true;
    void readSessionResult().then(({ session, known }) => {
      if (!live) return;
      if (!known) setAccount('unknown');
      else if (!session) setAccount('signedOut');
      else
        setAccount(
          session.user.accountType === 'merchant' && session.user.emailVerified !== false
            ? 'merchant'
            : 'other',
        );
    });
    return () => {
      live = false;
    };
  }, []);
  return account;
}
