'use client';

import type { ShopWallet } from '@vertex-digital/contracts';
import { useCallback, useEffect, useState } from 'react';
import { getShopWallet } from './requests';

/*
 * The shop customer's balance, the shop's rate and the pending return request (S26 WL5), read in
 * the browser and never cached. The header's pill, the home's return card and the buy box share
 * one read; `refreshShopWallet` reads it again after a purchase or an answered return.
 */

export type WalletState =
  | { status: 'loading' }
  | { status: 'failed' }
  | { status: 'ready'; wallet: ShopWallet };

const reads = new Map<string, Promise<WalletState>>();
const listeners = new Map<string, Set<(state: WalletState) => void>>();

function read(slug: string): Promise<WalletState> {
  let pending = reads.get(slug);
  if (!pending) {
    pending = getShopWallet(slug).then(
      (result): WalletState =>
        result.ok ? { status: 'ready', wallet: result.data } : { status: 'failed' },
    );
    reads.set(slug, pending);
    void pending.finally(() => setTimeout(() => reads.delete(slug), 2_000));
  }
  return pending;
}

export async function refreshShopWallet(slug: string): Promise<void> {
  reads.delete(slug);
  const state = await read(slug);
  for (const listener of listeners.get(slug) ?? []) listener(state);
}

/** The wallet while `enabled` (a signed-in customer); a failed refresh keeps what was shown. */
export function useShopWallet(slug: string, enabled: boolean) {
  const [state, setState] = useState<WalletState>({ status: 'loading' });
  useEffect(() => {
    if (!enabled) return;
    let live = true;
    const listener = (next: WalletState) => {
      if (!live) return;
      setState((current) =>
        next.status === 'failed' && current.status === 'ready' ? current : next,
      );
    };
    const set = listeners.get(slug) ?? new Set();
    set.add(listener);
    listeners.set(slug, set);
    void read(slug).then(listener);
    return () => {
      live = false;
      set.delete(listener);
    };
  }, [slug, enabled]);
  const refresh = useCallback(() => void refreshShopWallet(slug), [slug]);
  return { state, refresh };
}
