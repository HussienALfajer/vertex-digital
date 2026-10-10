import { CUSTOMER_FILTERS, type CustomerFilter } from '@vertex-digital/contracts';

/*
 * The customers page's search text and status tab as the URL holds them (S12 screens), and the
 * profile's open tab, so a view can be reloaded and shared. Anything invalid is dropped.
 */

export interface CustomerSearch {
  /** An order, deposit or ticket number, an email, a phone, or a name (rule CS1). */
  q?: string;
  /** Absent for "الكل". */
  status?: Exclude<CustomerFilter, 'all'>;
}

export function parseCustomerSearch(search: Record<string, unknown>): CustomerSearch {
  const parsed: CustomerSearch = {};
  const q = typeof search.q === 'string' ? search.q.trim() : '';
  if (q.length >= 1 && q.length <= 100) parsed.q = q;
  if ((CUSTOMER_FILTERS as readonly unknown[]).includes(search.status) && search.status !== 'all') {
    parsed.status = search.status as CustomerSearch['status'];
  }
  return parsed;
}

/** The status tab a search shows. */
export const statusOf = (search: CustomerSearch): CustomerFilter => search.status ?? 'all';

/** The search for a tab, keeping the text. */
export function withStatus(search: CustomerSearch, status: CustomerFilter): CustomerSearch {
  const { status: _previous, ...rest } = search;
  return status === 'all' ? rest : { ...rest, status };
}

/** The search for a text (empty clears it), keeping the tab. */
export function withText(search: CustomerSearch, text: string): CustomerSearch {
  const { q: _previous, ...rest } = search;
  const q = text.trim();
  return q ? { ...rest, q } : rest;
}

/** The profile's tabs (S12 screens), in their order; `summary` is the default. */
export const CUSTOMER_TABS = [
  'summary',
  'wallet',
  'orders',
  'deposits',
  'tickets',
  'devices',
  'notes',
  'history',
] as const;

export type CustomerTab = (typeof CUSTOMER_TABS)[number];

/** `?tab=`: absent for the summary. */
export function parseCustomerTab(search: Record<string, unknown>): {
  tab?: Exclude<CustomerTab, 'summary'>;
} {
  return (CUSTOMER_TABS as readonly unknown[]).includes(search.tab) && search.tab !== 'summary'
    ? { tab: search.tab as Exclude<CustomerTab, 'summary'> }
    : {};
}
