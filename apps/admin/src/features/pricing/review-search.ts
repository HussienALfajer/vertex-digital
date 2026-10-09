import {
  PRICE_REVIEW_STATUSES,
  type PriceReviewStatus,
  SUPPLIER_CODES,
  type SupplierCode,
} from '@vertex-digital/contracts';

/* The price reviews page's filters as the URL holds them (S07 screens). */

export interface ReviewSearch {
  /** Absent for `open`. */
  status?: Exclude<PriceReviewStatus, 'open'>;
  supplier?: SupplierCode;
  /** Absent for the first page. */
  page?: number;
}

/** Keeps only what is valid; anything else in the URL is dropped. */
export function parseReviewSearch(search: Record<string, unknown>): ReviewSearch {
  const parsed: ReviewSearch = {};
  if (
    (PRICE_REVIEW_STATUSES as readonly unknown[]).includes(search.status) &&
    search.status !== 'open'
  ) {
    parsed.status = search.status as ReviewSearch['status'];
  }
  if ((SUPPLIER_CODES as readonly unknown[]).includes(search.supplier)) {
    parsed.supplier = search.supplier as SupplierCode;
  }
  const page = Number(search.page);
  if (Number.isInteger(page) && page > 1 && page <= 10_000) parsed.page = page;
  return parsed;
}
