import { CATALOG_STATUSES, type CatalogStatus } from '@vertex-digital/contracts';

/*
 * The catalog page's category, filters and search as the URL holds them, so a view can be
 * reloaded and shared.
 */

export interface CatalogSearch {
  /** The category tab; absent for the first category. */
  category?: string;
  /** Absent for every status. */
  status?: CatalogStatus;
  /** The archive filter (rule CT1): archived games only. */
  archived?: true;
  /** Part of the Arabic or English name, or of the slug (1–60 characters, the API's rule). */
  q?: string;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Keeps only what is valid; anything else in the URL is dropped. */
export function parseCatalogSearch(search: Record<string, unknown>): CatalogSearch {
  const parsed: CatalogSearch = {};
  if (typeof search.category === 'string' && UUID.test(search.category)) {
    parsed.category = search.category;
  }
  if ((CATALOG_STATUSES as readonly unknown[]).includes(search.status)) {
    parsed.status = search.status as CatalogStatus;
  }
  if (search.archived === true || search.archived === 'true') parsed.archived = true;
  const q = typeof search.q === 'string' ? search.q.trim() : '';
  if (q.length >= 1 && q.length <= 60) parsed.q = q;
  return parsed;
}

/** The filters without the category: what the games query of a category takes. */
export function filtersOf(search: CatalogSearch): CatalogSearch {
  const { category: _category, ...filters } = search;
  return filters;
}

/**
 * The ids with the one at `index` moved one place up (`-1`) or down (`1`), for the move buttons
 * (rule CT5: the full list in its new order); the same list when it cannot move further.
 */
export function moved(ids: readonly string[], index: number, step: -1 | 1): string[] {
  const target = index + step;
  const next = [...ids];
  if (index < 0 || target < 0 || target >= ids.length) return next;
  [next[index], next[target]] = [next[target] as string, next[index] as string];
  return next;
}
