import { SHOP_STATUSES, type ShopStatus } from '@vertex-digital/contracts';

/*
 * The shops pages' tab, search and the shop page's tab as the URL holds them (S26 Screens), so a
 * view can be reloaded and shared. Anything invalid is dropped.
 */

/** The list's tabs: the requests first (the default), then each state, then all. */
export const SHOP_TABS = ['requested', 'active', 'suspended', 'closed', 'rejected', 'all'] as const;

export type ShopTab = (typeof SHOP_TABS)[number];

export interface ShopsSearch {
  /** Absent for "الطلبات" (`requested`), so a plain link to `/shops` opens the requests. */
  tab?: Exclude<ShopTab, 'requested'>;
  /** A slug or a shop name, as typed. */
  q?: string;
}

export function parseShopsSearch(search: Record<string, unknown>): ShopsSearch {
  const parsed: ShopsSearch = {};
  if ((SHOP_TABS as readonly unknown[]).includes(search.tab) && search.tab !== 'requested') {
    parsed.tab = search.tab as ShopsSearch['tab'];
  }
  const q = typeof search.q === 'string' ? search.q.trim() : '';
  if (q.length >= 1 && q.length <= 100) parsed.q = q;
  return parsed;
}

export const tabOf = (search: ShopsSearch): ShopTab => search.tab ?? 'requested';

/** The API's status filter of a tab; none for "all". */
export const statusOf = (search: ShopsSearch): ShopStatus | undefined => {
  const tab = tabOf(search);
  return tab === 'all' ? undefined : (SHOP_STATUSES.find((status) => status === tab) as ShopStatus);
};

/** The shop page's tabs, in their order; `overview` is the default. */
export const SHOP_PAGE_TABS = ['overview', 'customers', 'orders', 'tickets', 'history'] as const;

export type ShopPageTab = (typeof SHOP_PAGE_TABS)[number];

/** `?tab=`: absent for the overview. */
export function parseShopTab(search: Record<string, unknown>): {
  tab?: Exclude<ShopPageTab, 'overview'>;
} {
  return (SHOP_PAGE_TABS as readonly unknown[]).includes(search.tab) && search.tab !== 'overview'
    ? { tab: search.tab as Exclude<ShopPageTab, 'overview'> }
    : {};
}
