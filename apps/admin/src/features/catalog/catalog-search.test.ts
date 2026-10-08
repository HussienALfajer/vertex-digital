import { describe, expect, it } from 'vitest';
import { filtersOf, moved, parseCatalogSearch } from './catalog-search';

const ID = '0199a000-0000-7000-8000-000000000c01';

describe('parseCatalogSearch', () => {
  it('keeps a valid category, status, archive filter and search', () => {
    expect(
      parseCatalogSearch({ category: ID, status: 'paused', archived: 'true', q: ' pubg ' }),
    ).toEqual({ category: ID, status: 'paused', archived: true, q: 'pubg' });
    expect(parseCatalogSearch({ archived: true })).toEqual({ archived: true });
  });

  it('drops anything else', () => {
    expect(
      parseCatalogSearch({ category: 'games', status: 'gone', archived: 'yes', q: '   ' }),
    ).toEqual({});
    expect(parseCatalogSearch({ q: 'x'.repeat(61) })).toEqual({});
  });
});

describe('filtersOf', () => {
  it('drops the category only', () => {
    expect(filtersOf({ category: ID, status: 'active', q: 'a' })).toEqual({
      status: 'active',
      q: 'a',
    });
  });
});

describe('moved', () => {
  const ids = ['a', 'b', 'c'];

  it('swaps an item with its neighbour', () => {
    expect(moved(ids, 1, -1)).toEqual(['b', 'a', 'c']);
    expect(moved(ids, 1, 1)).toEqual(['a', 'c', 'b']);
  });

  it('leaves the list as it is at either end', () => {
    expect(moved(ids, 0, -1)).toEqual(ids);
    expect(moved(ids, 2, 1)).toEqual(ids);
    expect(moved(ids, -1, 1)).toEqual(ids);
  });
});
