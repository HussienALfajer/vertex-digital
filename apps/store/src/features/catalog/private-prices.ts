'use client';

import type { CustomerPrices, PriceKind, StoreProduct } from '@vertex-digital/contracts';
import { useCallback, useEffect, useState } from 'react';
import type { Customer } from '@/features/purchase/session';
import { PRIVATE_PRICES_HINT_KEY } from '@/lib/session';
import { readCustomerPrices } from './customer-prices';

/*
 * S20 AT4: the signed-in account's own prices for a game page. The page is the cached retail one;
 * an account on another list reads `/api/catalog/games/:slug/prices` (never cached) and its packs
 * take those prices. A browser whose account had private prices at its last read hides the
 * retail figures before paint (`data-private-prices-hint`), so a merchant never sees them flash.
 */

export type PrivatePrices =
  /** Retail: signed out, or an account on the retail list. */
  | { status: 'retail' }
  | { status: 'loading'; hinted: boolean }
  | { status: 'failed'; retry: () => void }
  | { status: 'ready'; kind: Exclude<PriceKind, 'retail'>; products: StoreProduct[] };

const HINT_ATTRIBUTE = 'data-private-prices-hint';

export function rememberPrivatePrices(on: boolean) {
  try {
    if (on) localStorage.setItem(PRIVATE_PRICES_HINT_KEY, '1');
    else localStorage.removeItem(PRIVATE_PRICES_HINT_KEY);
  } catch {
    // Storage can be unavailable (private mode): the page then waits for the read without a hint.
  }
  if (on) document.documentElement.setAttribute(HINT_ATTRIBUTE, '');
  else document.documentElement.removeAttribute(HINT_ATTRIBUTE);
}

/** The game's packs with the account's prices, availability and savings in place of retail's. */
export function withPrivatePrices(
  products: readonly StoreProduct[],
  prices: CustomerPrices,
): StoreProduct[] {
  return products.map((product) => {
    const own = prices.products.find((row) => row.id === product.id);
    return own
      ? { ...product, ...own }
      : { ...product, available: false, priceUsdUnits: null, priceSypUnits: null, savings: null };
  });
}

export function usePrivatePrices(
  slug: string,
  customer: Customer,
  products: readonly StoreProduct[],
): PrivatePrices {
  const [state, setState] = useState<PrivatePrices>({ status: 'loading', hinted: false });
  const [attempt, setAttempt] = useState(0);
  const retry = useCallback(() => setAttempt((count) => count + 1), []);

  // biome-ignore lint/correctness/useExhaustiveDependencies: read again on a retry.
  useEffect(() => {
    if (customer.status === 'loading') {
      setState({
        status: 'loading',
        hinted: document.documentElement.hasAttribute(HINT_ATTRIBUTE),
      });
      return;
    }
    // An unverified account cannot read its prices (EMAIL_NOT_VERIFIED) nor buy: retail's show.
    if (customer.status === 'signedOut' || !customer.verified) {
      rememberPrivatePrices(false);
      setState({ status: 'retail' });
      return;
    }
    let live = true;
    // Until the account's prices answer, the cached figures stay under their skeletons and no
    // pack can be chosen, hint or not (decision 9: never the retail figure for another list).
    document.documentElement.setAttribute(HINT_ATTRIBUTE, '');
    setState({ status: 'loading', hinted: true });
    void readCustomerPrices(slug).then((result) => {
      if (!live) return;
      if (!result) return setState({ status: 'failed', retry });
      const { priceKind } = result;
      rememberPrivatePrices(priceKind !== 'retail');
      setState(
        priceKind === 'retail'
          ? { status: 'retail' }
          : {
              status: 'ready',
              kind: priceKind,
              products: withPrivatePrices(products, result),
            },
      );
    });
    return () => {
      live = false;
    };
  }, [slug, customer.status, attempt]);

  return state;
}
