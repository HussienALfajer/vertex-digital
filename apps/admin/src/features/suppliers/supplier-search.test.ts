import { describe, expect, it } from 'vitest';
import { offerFilters, parseSupplierSearch, supplierCodeOf } from './supplier-search';

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
  it('leaves the tab out', () => {
    expect(offerFilters({ tab: 'offers', q: 'uc', page: 2 })).toEqual({ q: 'uc', page: 2 });
  });
});

describe('supplierCodeOf', () => {
  it('names only the known suppliers', () => {
    expect(supplierCodeOf('fake')).toBe('fake');
    expect(supplierCodeOf('wdgzone')).toBe('wdgzone');
    expect(supplierCodeOf('policy')).toBeNull();
  });
});
