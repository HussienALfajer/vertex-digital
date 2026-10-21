import type { MerchantApplicationStatus } from '@vertex-digital/contracts';

/*
 * The merchant pages' tabs and filters as the URL holds them (S20 screens), so a view can be
 * reloaded and shared. Anything invalid is dropped.
 */

/** The queue's tabs: under review (the default, oldest first), waiting for information, all. */
export const APPLICATION_TABS = ['under_review', 'info_requested', 'all'] as const;

export type ApplicationTab = (typeof APPLICATION_TABS)[number];

export interface ApplicationsSearch {
  /** Absent for "قيد المراجعة", so a plain link to the queue opens it. */
  tab?: Exclude<ApplicationTab, 'under_review'>;
}

export function parseApplicationsSearch(search: Record<string, unknown>): ApplicationsSearch {
  return search.tab === 'info_requested' || search.tab === 'all' ? { tab: search.tab } : {};
}

export const tabOf = (search: ApplicationsSearch): ApplicationTab => search.tab ?? 'under_review';

/** The API's status filter of a tab; none for "all". */
export const statusOf = (tab: ApplicationTab): MerchantApplicationStatus | undefined =>
  tab === 'all' ? undefined : tab;

export interface MerchantsSearch {
  q?: string;
  listId?: string;
  /** S21: a level's merchants, or `none` for those without a level. */
  levelId?: string;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function parseMerchantsSearch(search: Record<string, unknown>): MerchantsSearch {
  const parsed: MerchantsSearch = {};
  const q = typeof search.q === 'string' ? search.q.trim() : '';
  if (q.length >= 1 && q.length <= 100) parsed.q = q;
  if (typeof search.listId === 'string' && UUID.test(search.listId)) parsed.listId = search.listId;
  if (
    typeof search.levelId === 'string' &&
    (search.levelId === 'none' || UUID.test(search.levelId))
  ) {
    parsed.levelId = search.levelId;
  }
  return parsed;
}
