import { SUPPLIER_CODES, type SupplierCode } from '@vertex-digital/contracts';

/*
 * A supplier page's tab, and the offers tab's filters, as the URL holds them, so a view can be
 * reloaded and shared.
 */

export const SUPPLIER_TABS = ['connection', 'offers', 'runs', 'health'] as const;

export type SupplierTab = (typeof SUPPLIER_TABS)[number];

type Flag = 'true' | 'false';

export interface OfferSearch {
  /** Part of the offer's name or of the supplier's offer id (1–100 characters, the API's rule). */
  q?: string;
  /** The supplier's group, exactly (1–200 characters). */
  group?: string;
  mapped?: Flag;
  missing?: Flag;
  inStock?: Flag;
  /** Absent for the first page. */
  page?: number;
}

export interface SupplierSearch extends OfferSearch {
  /** Absent for the connection tab. */
  tab?: Exclude<SupplierTab, 'connection'>;
}

const flag = (value: unknown): Flag | undefined =>
  value === true || value === 'true'
    ? 'true'
    : value === false || value === 'false'
      ? 'false'
      : undefined;

const text = (value: unknown, max: number): string | undefined => {
  const trimmed = typeof value === 'string' ? value.trim() : '';
  return trimmed.length >= 1 && trimmed.length <= max ? trimmed : undefined;
};

/** Keeps only what is valid; anything else in the URL is dropped. */
export function parseSupplierSearch(search: Record<string, unknown>): SupplierSearch {
  const parsed: SupplierSearch = {};
  if ((SUPPLIER_TABS as readonly unknown[]).includes(search.tab) && search.tab !== 'connection') {
    parsed.tab = search.tab as SupplierSearch['tab'];
  }
  const q = text(search.q, 100);
  if (q) parsed.q = q;
  const group = text(search.group, 200);
  if (group) parsed.group = group;
  for (const name of ['mapped', 'missing', 'inStock'] as const) {
    const value = flag(search[name]);
    if (value) parsed[name] = value;
  }
  const page = Number(search.page);
  if (Number.isInteger(page) && page > 1 && page <= 10_000) parsed.page = page;
  return parsed;
}

/** The offers tab's filters, without the tab. */
export function offerFilters(search: SupplierSearch): OfferSearch {
  const { tab: _tab, ...filters } = search;
  return filters;
}

/** A `:code` from the URL that names a supplier, or null. */
export const supplierCodeOf = (code: string): SupplierCode | null =>
  (SUPPLIER_CODES as readonly string[]).includes(code) ? (code as SupplierCode) : null;
