import {
  LIVE_TEST_FILTERS,
  type LiveBoardQuery,
  SUPPLIER_CODES,
  type SupplierCode,
} from '@vertex-digital/contracts';

/*
 * The live room's filters as the URL holds them (S11 screens): supplier, game and test orders.
 * "الكل" is the absence of a filter; anything invalid in the URL is dropped.
 */

export interface LiveSearch {
  supplier?: SupplierCode;
  gameId?: string;
  test?: 'hide' | 'only';
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function parseLiveSearch(search: Record<string, unknown>): LiveSearch {
  const parsed: LiveSearch = {};
  if ((SUPPLIER_CODES as readonly unknown[]).includes(search.supplier)) {
    parsed.supplier = search.supplier as SupplierCode;
  }
  if (typeof search.gameId === 'string' && UUID.test(search.gameId)) {
    parsed.gameId = search.gameId;
  }
  if ((LIVE_TEST_FILTERS as readonly unknown[]).includes(search.test) && search.test !== 'all') {
    parsed.test = search.test as LiveSearch['test'];
  }
  return parsed;
}

/** The board's query: the API's default (`all`) when no test filter is set. */
export const liveQuery = (search: LiveSearch): LiveBoardQuery => ({ ...search });
