import {
  PRODUCT_KINDS,
  type ProductKind,
  SUPPLIER_CATEGORY_STATES,
  SUPPLIER_CODES,
  type SupplierCategoryState,
  type SupplierCode,
} from '@vertex-digital/contracts';

/*
 * A supplier page's tab, the offers tab's filters, the catalog tab's filters and selected node,
 * and the statement's list and page, as the URL holds them, so a view can be reloaded and shared.
 */

export const SUPPLIER_TABS = [
  'connection',
  'catalog',
  'offers',
  'statement',
  'runs',
  'health',
] as const;

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
  /** S16 SF1: the supplier category (its subtree). */
  categoryId?: string;
  supported?: Flag;
  ignored?: Flag;
  lowStock?: Flag;
  /** Absent for the first page. */
  page?: number;
}

/** The catalog tab (S16 SC4): a search or a state lists nodes at any depth with their path. */
export interface CategorySearch {
  /** Part of a category's name (1–100 characters). */
  cq?: string;
  state?: SupplierCategoryState;
  kind?: ProductKind;
  /** The selected node, whose packs show below the tree. */
  node?: string;
  /** The page of a search; absent for the first. */
  cpage?: number;
}

/** The statement tab (S16 SF3): absent `list` for the orders. */
export interface StatementSearch {
  list?: 'transactions';
  spage?: number;
}

export interface SupplierSearch extends OfferSearch, CategorySearch, StatementSearch {
  /** Absent for the connection tab. */
  tab?: Exclude<SupplierTab, 'connection'>;
}

const CATEGORY_ID = /^[A-Za-z0-9_.-]{1,64}$/;

const pageOf = (value: unknown): number | undefined => {
  const page = Number(value);
  return Number.isInteger(page) && page > 1 && page <= 10_000 ? page : undefined;
};

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
  const categoryId = text(search.categoryId, 64);
  if (categoryId && CATEGORY_ID.test(categoryId)) parsed.categoryId = categoryId;
  for (const name of [
    'mapped',
    'missing',
    'inStock',
    'supported',
    'ignored',
    'lowStock',
  ] as const) {
    const value = flag(search[name]);
    if (value) parsed[name] = value;
  }
  const page = pageOf(search.page);
  if (page) parsed.page = page;
  const cq = text(search.cq, 100);
  if (cq) parsed.cq = cq;
  if ((SUPPLIER_CATEGORY_STATES as readonly unknown[]).includes(search.state)) {
    parsed.state = search.state as SupplierCategoryState;
  }
  if ((PRODUCT_KINDS as readonly unknown[]).includes(search.kind)) {
    parsed.kind = search.kind as ProductKind;
  }
  if (typeof search.node === 'string' && CATEGORY_ID.test(search.node)) parsed.node = search.node;
  const cpage = pageOf(search.cpage);
  if (cpage) parsed.cpage = cpage;
  if (search.list === 'transactions') parsed.list = 'transactions';
  const spage = pageOf(search.spage);
  if (spage) parsed.spage = spage;
  return parsed;
}

/** The offers tab's filters, without the tab or another tab's state. */
export function offerFilters(search: SupplierSearch): OfferSearch {
  const { q, group, mapped, missing, inStock, categoryId, supported, ignored, lowStock, page } =
    search;
  return Object.fromEntries(
    Object.entries({
      q,
      group,
      mapped,
      missing,
      inStock,
      categoryId,
      supported,
      ignored,
      lowStock,
      page,
    }).filter(([, value]) => value !== undefined),
  ) as OfferSearch;
}

/** The catalog tab's filters and node. */
export function categoryFilters(search: SupplierSearch): CategorySearch {
  const { cq, state, kind, node, cpage } = search;
  return Object.fromEntries(
    Object.entries({ cq, state, kind, node, cpage }).filter(([, value]) => value !== undefined),
  ) as CategorySearch;
}

/** A `:code` from the URL that names a supplier, or null. */
export const supplierCodeOf = (code: string): SupplierCode | null =>
  (SUPPLIER_CODES as readonly string[]).includes(code) ? (code as SupplierCode) : null;
