import type { CustomerPrices } from '@vertex-digital/contracts';

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
