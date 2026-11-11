'use client';

import type { ShopCustomerProfile } from '@vertex-digital/contracts';
import { useEffect, useState } from 'react';
import { getShopProfile } from './requests';

/*
 * Who is visiting a shop's page (S26, ADR 0040), read in the browser so the pages stay cached:
 * the shop's own session (`GET /api/shops/<slug>/me`). Every part of a page shares one request
 * while it is in flight; `refreshShopCustomer` reads it again after a sign-in or a sign-out and
 * tells every mounted part. Only a verified customer of this shop has a session.
 */

export type ShopCustomer =
  | { status: 'loading' }
  | { status: 'signedOut' }
  /** The read failed (network, server): shown data stays, nothing decides on it. */
  | { status: 'failed' }
  | { status: 'signedIn'; profile: ShopCustomerProfile };

const reads = new Map<string, Promise<ShopCustomer>>();
const listeners = new Map<string, Set<(customer: ShopCustomer) => void>>();

function read(slug: string): Promise<ShopCustomer> {
  let pending = reads.get(slug);
  if (!pending) {
    pending = getShopProfile(slug).then((result): ShopCustomer => {
      if (result.ok) return { status: 'signedIn', profile: result.data };
      return result.reason === 'UNAUTHORIZED' ||
        result.reason === 'EMAIL_NOT_VERIFIED' ||
        result.reason === 'NOT_FOUND'
        ? { status: 'signedOut' }
        : { status: 'failed' };
    });
    reads.set(slug, pending);
    // A later mount reads again: a sign-in elsewhere, a freeze or an ended session since.
    void pending.finally(() => setTimeout(() => reads.delete(slug), 2_000));
  }
  return pending;
}

/** Reads the session again and tells every part of the page. */
export async function refreshShopCustomer(slug: string): Promise<ShopCustomer> {
  reads.delete(slug);
  const customer = await read(slug);
  for (const listener of listeners.get(slug) ?? []) listener(customer);
  return customer;
}

export function useShopCustomer(slug: string): ShopCustomer {
  const [customer, setCustomer] = useState<ShopCustomer>({ status: 'loading' });
  useEffect(() => {
    let live = true;
    const listener = (next: ShopCustomer) => live && setCustomer(next);
    const set = listeners.get(slug) ?? new Set();
    set.add(listener);
    listeners.set(slug, set);
    void read(slug).then(listener);
    return () => {
      live = false;
      set.delete(listener);
    };
  }, [slug]);
  return customer;
}
