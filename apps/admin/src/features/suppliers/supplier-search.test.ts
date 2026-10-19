import { describe, expect, it } from 'vitest';
import {
  categoryFilters,
  categoryIdOf,
  offerFilters,
  parseOfferSearch,
  parseSupplierSearch,
  supplierCodeOf,
} from './supplier-search';

describe('parseSupplierSearch', () => {
  it('keeps a tab, the filters and a page', () => {
    expect(
      parseSupplierSearch({
        tab: 'offers',
        q: ' uc ',
        group: 'PUBG Mobile',
        mapped: 'false',
        missing: true,
        inStock: 'true',
        page: '3',
      }),
    ).toEqual({
      tab: 'offers',
      q: 'uc',
      group: 'PUBG Mobile',
      mapped: 'false',
      missing: 'true',
      inStock: 'true',
      page: 3,
    });
  });

  it('drops the default tab, the first page and anything invalid', () => {
    expect(
      parseSupplierSearch({
        tab: 'connection',
        q: '',
        group: 'x'.repeat(201),
        mapped: 'yes',
        page: '1',
      }),
    ).toEqual({});
    expect(parseSupplierSearch({ tab: 'admin', q: 'x'.repeat(101), page: '2.5' })).toEqual({});
    expect(parseSupplierSearch({ inStock: false, page: 10_001 })).toEqual({ inStock: 'false' });
  });
});

describe('offerFilters', () => {
  it('leaves the tab and the other tabs out', () => {
    expect(
      offerFilters({ tab: 'offers', q: 'uc', page: 2, lowStock: 'true', cq: 'pubg', spage: 3 }),
    ).toEqual({ q: 'uc', page: 2, lowStock: 'true' });
  });
});

describe('the S16 filters', () => {
  it('keeps the offer, catalog and statement filters', () => {
    expect(
      parseSupplierSearch({
        tab: 'catalog',
        categoryId: '12',
        supported: 'false',
        ignored: true,
        lowStock: 'true',
        cq: ' ببجي ',
        state: 'new_packs',
        kind: 'code',
        // S18: the selected node is a page of its own now.
        node: 'pubg-1',
        cpage: '2',
        list: 'transactions',
        spage: 4,
      }),
    ).toEqual({
      tab: 'catalog',
      categoryId: '12',
      supported: 'false',
      ignored: 'true',
      lowStock: 'true',
      cq: 'ببجي',
      state: 'new_packs',
      kind: 'code',
      cpage: 2,
      list: 'transactions',
      spage: 4,
    });
    expect(categoryFilters({ tab: 'catalog', cq: 'x', q: 'uc' })).toEqual({ cq: 'x' });
  });

  it('drops invalid catalog and statement values', () => {
    expect(
      parseSupplierSearch({
        categoryId: 'a b',
        state: 'gone',
        kind: 'voucher',
        node: 'x'.repeat(65),
        cpage: 1,
        list: 'orders',
        spage: 'two',
      }),
    ).toEqual({});
  });
});

describe('the S18 filters', () => {
  it('reads a category page: offer filters only, the discount filter too', () => {
    expect(
      parseOfferSearch({ discounted: 'true', tab: 'offers', cq: 'x', page: '2', q: ' 60 ' }),
    ).toEqual({ discounted: 'true', page: 2, q: '60' });
    expect(offerFilters({ discounted: 'false', cq: 'x' })).toEqual({ discounted: 'false' });
    expect(categoryIdOf('14693')).toBe('14693');
    expect(categoryIdOf('a b')).toBeNull();
  });
});

describe('supplierCodeOf', () => {
  it('names only the known suppliers', () => {
    expect(supplierCodeOf('fake')).toBe('fake');
    expect(supplierCodeOf('wdgzone')).toBe('wdgzone');
    expect(supplierCodeOf('policy')).toBeNull();
  });
});
