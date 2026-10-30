import {
  PRICE_MATRIX_MAX_LISTS,
  PRICE_MATRIX_SORTS,
  PRICE_MATRIX_STATUSES,
  type PriceMatrixQuery,
  type PriceMatrixSort,
  type PriceMatrixStatus,
  SUPPLIER_CODES,
  type SupplierCode,
} from '@vertex-digital/contracts';

/* The price matrix's filters as the URL holds them (S20 screens). */

export interface MatrixSearch {
  gameId?: string;
  categoryId?: string;
  q?: string;
  /** The columns besides retail; absent for the default (wholesale, cost), empty for retail only. */
  lists?: string[];
  status?: PriceMatrixStatus;
  supplier?: SupplierCode;
  sort?: PriceMatrixSort;
  /** The list `sort` reads; absent for retail. */
  sortList?: string;
  direction?: NonNullable<PriceMatrixQuery['direction']>;
  /** The list the margin filter and the low margin chip read; absent for retail. */
  marginList?: string;
  marginBelowBp?: number;
  page?: number;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const uuid = (value: unknown) =>
  typeof value === 'string' && UUID.test(value) ? value : undefined;

const oneOf = <Value extends string>(values: readonly Value[], value: unknown) =>
  values.find((item) => item === value);

const wholeNumber = (value: unknown, max: number) => {
  const number = typeof value === 'string' ? Number(value) : value;
  return typeof number === 'number' && Number.isInteger(number) && number >= 1 && number <= max
    ? number
    : undefined;
};

/** Drops what a URL leaves undefined, so a search compares and serializes cleanly. */
const defined = (search: MatrixSearch): MatrixSearch =>
  Object.fromEntries(Object.entries(search).filter(([, value]) => value !== undefined));

/** Keeps only what is valid; anything else in the URL is dropped. */
export function parseMatrixSearch(search: Record<string, unknown>): MatrixSearch {
  const q = typeof search.q === 'string' ? search.q.trim().slice(0, 100) : '';
  const gameId = uuid(search.gameId);
  const lists = Array.isArray(search.lists)
    ? search.lists
    : typeof search.lists === 'string'
      ? search.lists.split(',')
      : null;
  const sort = oneOf(PRICE_MATRIX_SORTS, search.sort);
  return defined({
    gameId,
    // A game takes no category or search (the API refuses the pair).
    categoryId: gameId ? undefined : uuid(search.categoryId),
    q: gameId || q.length === 0 ? undefined : q,
    // An empty list is retail alone, the last box unticked (audit A05-33).
    lists: lists
      ? [
          ...new Set(lists.filter((id): id is string => typeof id === 'string' && UUID.test(id))),
        ].slice(0, PRICE_MATRIX_MAX_LISTS - 1)
      : undefined,
    status: oneOf(PRICE_MATRIX_STATUSES, search.status),
    supplier: oneOf(SUPPLIER_CODES, search.supplier),
    sort,
    sortList: sort ? uuid(search.sortList) : undefined,
    direction: sort ? oneOf(['asc', 'desc'] as const, search.direction) : undefined,
    marginList: uuid(search.marginList),
    marginBelowBp: wholeNumber(search.marginBelowBp, 10_000),
    page: wholeNumber(search.page, Number.MAX_SAFE_INTEGER),
  });
}

/** "مسح الفلاتر" shows while any filter or sort is on; the chosen columns are not a filter. */
export function hasMatrixFilters(search: MatrixSearch): boolean {
  return (
    search.gameId !== undefined ||
    search.categoryId !== undefined ||
    search.q !== undefined ||
    search.status !== undefined ||
    search.supplier !== undefined ||
    search.sort !== undefined ||
    search.marginBelowBp !== undefined
  );
}

/** Every filter and the sort off; the columns stay. */
export function clearMatrixFilters(search: MatrixSearch): MatrixSearch {
  return defined({ lists: search.lists });
}

/** A header's click: its column lowest first, then highest first, then the sort off. */
export function nextMatrixSort(
  search: MatrixSearch,
  sort: PriceMatrixSort,
  sortList: string | undefined,
): MatrixSearch {
  const { sort: _sort, sortList: _list, direction: _direction, page: _page, ...rest } = search;
  const same = search.sort === sort && search.sortList === sortList;
  if (same && search.direction === 'desc') return rest;
  return defined({
    ...rest,
    sort,
    sortList,
    direction: same ? 'desc' : undefined,
  });
}
