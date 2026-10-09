import {
  ADMIN_ORDER_TABS,
  type AdminOrderTab,
  SUPPLIER_CODES,
  type SupplierCode,
} from '@vertex-digital/contracts';

/*
 * The orders page's tab, filters and page as the URL holds them (S08 screens), so a view can be
 * reloaded and shared. Anything invalid in the URL is dropped.
 */

export interface OrderSearch {
  /** Absent for "الكل", so a plain link to `/orders` opens every order. */
  tab?: Exclude<AdminOrderTab, 'all'>;
  /** An order number or part of the customer's email. */
  q?: string;
  productId?: string;
  supplier?: SupplierCode;
  test?: 'true' | 'false';
  /** Calendar dates (`YYYY-MM-DD`), the day included. */
  from?: string;
  to?: string;
  /** Absent for the first page. */
  page?: number;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DATE = /^\d{4}-\d{2}-\d{2}$/;

export const tabOf = (search: OrderSearch): AdminOrderTab => search.tab ?? 'all';

export function parseOrderSearch(search: Record<string, unknown>): OrderSearch {
  const parsed: OrderSearch = {};
  if ((ADMIN_ORDER_TABS as readonly unknown[]).includes(search.tab) && search.tab !== 'all') {
    parsed.tab = search.tab as OrderSearch['tab'];
  }
  const q = typeof search.q === 'string' ? search.q.trim() : '';
  if (q.length >= 1 && q.length <= 100) parsed.q = q;
  if (typeof search.productId === 'string' && UUID.test(search.productId)) {
    parsed.productId = search.productId;
  }
  if ((SUPPLIER_CODES as readonly unknown[]).includes(search.supplier)) {
    parsed.supplier = search.supplier as SupplierCode;
  }
  if (search.test === 'true' || search.test === 'false') parsed.test = search.test;
  for (const key of ['from', 'to'] as const) {
    const value = search[key];
    if (typeof value === 'string' && DATE.test(value) && !Number.isNaN(Date.parse(value))) {
      parsed[key] = value;
    }
  }
  const page = Number(search.page);
  if (Number.isSafeInteger(page) && page > 1) parsed.page = page;
  return parsed;
}

/** A change of tab or filter starts again at the first page; `undefined` or "الكل" clears. */
export function withFilter(
  search: OrderSearch,
  change: Partial<Omit<OrderSearch, 'tab' | 'page'>> & { tab?: AdminOrderTab },
): OrderSearch {
  const { page: _page, ...kept } = search;
  const next: Record<string, unknown> = { ...kept, ...change };
  if (next.tab === 'all') delete next.tab;
  for (const key of Object.keys(next)) if (next[key] === undefined) delete next[key];
  return next as OrderSearch;
}

/** The API's query for a search: dates as the start of `from` and the end of `to`, local time. */
export function listQuery(search: OrderSearch) {
  const dayStart = (date: string) => new Date(`${date}T00:00:00`).toISOString();
  const dayEnd = (date: string) => new Date(`${date}T23:59:59.999`).toISOString();
  return {
    tab: tabOf(search),
    ...(search.q && { q: search.q }),
    ...(search.productId && { productId: search.productId }),
    ...(search.supplier && { supplier: search.supplier }),
    ...(search.test && { test: search.test }),
    ...(search.from && { from: dayStart(search.from) }),
    ...(search.to && { to: dayEnd(search.to) }),
    page: search.page ?? 1,
  };
}
