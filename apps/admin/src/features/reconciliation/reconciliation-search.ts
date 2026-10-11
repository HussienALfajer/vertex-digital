import { TREASURY_PLACES, type TreasuryPlace } from '@vertex-digital/contracts';

/*
 * The reconciliation page's tab and the movements' place filter as the URL holds them (S13
 * screens), so a view can be reloaded and shared.
 */

export const RECONCILIATION_TABS = ['overview', 'movements', 'history'] as const;

export type ReconciliationTab = (typeof RECONCILIATION_TABS)[number];

export interface ReconciliationSearch {
  /** Absent for the overview, so a plain link to `/reconciliation` opens it. */
  tab?: Exclude<ReconciliationTab, 'overview'>;
  /** The movements of one place; absent for all. */
  place?: TreasuryPlace;
}

export const tabOf = (search: ReconciliationSearch): ReconciliationTab => search.tab ?? 'overview';

/** Keeps only what is valid; anything else in the URL is dropped. */
export function parseReconciliationSearch(search: Record<string, unknown>): ReconciliationSearch {
  const parsed: ReconciliationSearch = {};
  if (search.tab === 'movements' || search.tab === 'history') parsed.tab = search.tab;
  if (
    parsed.tab === 'movements' &&
    (TREASURY_PLACES as readonly unknown[]).includes(search.place)
  ) {
    parsed.place = search.place as TreasuryPlace;
  }
  return parsed;
}

/** The search for a tab; the place filter stays only on the movements. */
export function withTab(
  search: ReconciliationSearch,
  tab: ReconciliationTab,
): ReconciliationSearch {
  if (tab === 'overview') return {};
  return tab === 'movements' ? { tab, ...(search.place ? { place: search.place } : {}) } : { tab };
}
