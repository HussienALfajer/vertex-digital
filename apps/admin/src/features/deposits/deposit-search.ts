import { DEPOSIT_METHODS, type DepositMethod } from '@vertex-digital/contracts';

/*
 * The deposits page's tab, method and search as the URL holds them, so a view can be reloaded and shared.
 * The tabs are the queue (`submitted`, rule RV10, the default), the deposits waiting for a
 * receipt, and all of them.
 */

export const DEPOSIT_TABS = ['submitted', 'pending', 'all'] as const;

export type DepositTab = (typeof DEPOSIT_TABS)[number];

export interface DepositSearch {
  /** Absent for the queue, so a plain link to `/deposits` opens it. */
  status?: Exclude<DepositTab, 'submitted'>;
  /** Absent for every method (S04). */
  method?: DepositMethod;
  /** A reference code or the customer's email prefix, 3 characters at least (the API's rule). */
  q?: string;
}

/** The tab a search shows. */
export const tabOf = (search: DepositSearch): DepositTab => search.status ?? 'submitted';

/** Keeps only what is valid; anything else in the URL is dropped. */
export function parseDepositSearch(search: Record<string, unknown>): DepositSearch {
  const parsed: DepositSearch = {};
  if (search.status === 'pending' || search.status === 'all') parsed.status = search.status;
  if ((DEPOSIT_METHODS as readonly unknown[]).includes(search.method)) {
    parsed.method = search.method as DepositMethod;
  }
  const q = typeof search.q === 'string' ? search.q.trim() : '';
  if (q.length >= 3 && q.length <= 254) parsed.q = q;
  return parsed;
}

/** The search for a tab, keeping the method and the text searched. */
export function withTab(search: DepositSearch, tab: DepositTab): DepositSearch {
  const { status: _previous, ...rest } = search;
  return tab === 'submitted' ? rest : { ...rest, status: tab };
}

/** The search for a method, or every method; the tab and text stay. */
export function withMethod(search: DepositSearch, method: DepositMethod | null): DepositSearch {
  const { method: _previous, ...rest } = search;
  return method ? { ...rest, method } : rest;
}
