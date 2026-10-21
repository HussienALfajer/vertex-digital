import { QUICK_LINK_RETENTION_DAYS, QUICK_LINK_STATS_DAYS } from '@vertex-digital/contracts';

/*
 * `/catalog/quick-links`'s URL (S22 DL5): the days back (within the 90 days kept) and a product.
 * A light module: the route file imports it eagerly.
 */

export interface QuickLinksSearch {
  days?: number;
  productId?: string;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The periods offered; the default is the spec's 30 days. */
export const QUICK_LINK_PERIODS = [7, QUICK_LINK_STATS_DAYS, QUICK_LINK_RETENTION_DAYS] as const;

export function parseQuickLinksSearch(search: Record<string, unknown>): QuickLinksSearch {
  const days = Number(search.days);
  return {
    ...((QUICK_LINK_PERIODS as readonly number[]).includes(days) &&
      days !== QUICK_LINK_STATS_DAYS && { days }),
    ...(typeof search.productId === 'string' &&
      UUID.test(search.productId) && { productId: search.productId }),
  };
}

/** The API's range: the last `days` days up to now. */
export function quickLinksRange(days: number, now = Date.now()): { from: string; to: string } {
  return {
    from: new Date(now - days * 86_400_000).toISOString(),
    to: new Date(now).toISOString(),
  };
}
