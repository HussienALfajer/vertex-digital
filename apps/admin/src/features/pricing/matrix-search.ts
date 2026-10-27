import { PRICE_MATRIX_MAX_LISTS } from '@vertex-digital/contracts';

/* The price matrix's filters as the URL holds them (S20 screens). */

export interface MatrixSearch {
  gameId?: string;
  q?: string;
  /** The columns besides retail; absent for the default (wholesale, cost), empty for retail only. */
  lists?: string[];
  /** "التحذيرات فقط". */
  warnings?: true;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Keeps only what is valid; anything else in the URL is dropped. */
export function parseMatrixSearch(search: Record<string, unknown>): MatrixSearch {
  const parsed: MatrixSearch = {};
  if (typeof search.gameId === 'string' && UUID.test(search.gameId)) parsed.gameId = search.gameId;
  if (typeof search.q === 'string') {
    const q = search.q.trim().slice(0, 100);
    if (q.length > 0) parsed.q = q;
  }
  const lists = Array.isArray(search.lists)
    ? search.lists
    : typeof search.lists === 'string'
      ? search.lists.split(',')
      : null;
  if (lists) {
    // An empty list is retail alone, the last box unticked (audit A05-33).
    parsed.lists = [
      ...new Set(lists.filter((id): id is string => typeof id === 'string' && UUID.test(id))),
    ].slice(0, PRICE_MATRIX_MAX_LISTS - 1);
  }
  if (search.warnings === true || search.warnings === 'true') parsed.warnings = true;
  return parsed;
}
