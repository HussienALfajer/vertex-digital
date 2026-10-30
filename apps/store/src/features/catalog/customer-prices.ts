import type { CustomerPrices, StoreGame } from '@vertex-digital/contracts';

/**
 * S20 AT4: the signed-in account's own prices of a game, or null when the read fails. A plain
 * `fetch`, not `apiRequest`: that one brings the contracts' error codes (and zod) into the game
 * page's first load, which only needs to know the read failed.
 */
export async function readCustomerPrices(slug: string): Promise<CustomerPrices | null> {
  try {
    const response = await fetch(`/api/catalog/games/${encodeURIComponent(slug)}/prices`, {
      credentials: 'same-origin',
      cache: 'no-store',
    });
    return response.ok ? ((await response.json()) as CustomerPrices) : null;
  } catch {
    return null;
  }
}

/**
 * S23 OP5: a game in early access, read for a merchant of an early-access tier; null for anyone
 * else, a game outside a window, or a failed read (the page then stays not found).
 */
export async function readEarlyAccessGame(slug: string): Promise<StoreGame | null> {
  try {
    const response = await fetch(`/api/catalog/games/${encodeURIComponent(slug)}/early-access`, {
      credentials: 'same-origin',
      cache: 'no-store',
    });
    return response.ok ? ((await response.json()) as StoreGame) : null;
  } catch {
    return null;
  }
}
