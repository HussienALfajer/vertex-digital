import { describe, expect, it } from 'vitest';
import {
  clearMatrixFilters,
  hasMatrixFilters,
  nextMatrixSort,
  parseMatrixSearch,
} from './matrix-search';

const id = '01a15a8c-b312-75f3-92d2-65b29d838051';
const other = '01a15a8c-b312-75f3-92d2-691f7e3bf413';

describe('parseMatrixSearch', () => {
  it('keeps a game, a trimmed search and valid lists once', () => {
    expect(parseMatrixSearch({ gameId: id, lists: [id, 'x', id, other] })).toEqual({
      gameId: id,
      lists: [id, other],
    });
    expect(parseMatrixSearch({ q: '  شدة ', lists: `${id},${other}` })).toEqual({
      q: 'شدة',
      lists: [id, other],
    });
  });

  it('keeps every filter, the sort and the page', () => {
    expect(
      parseMatrixSearch({
        categoryId: id,
        status: 'low_margin',
        supplier: 'manual',
        sort: 'margin',
        sortList: other,
        direction: 'desc',
        marginList: other,
        marginBelowBp: '500',
        page: 3,
      }),
    ).toEqual({
      categoryId: id,
      status: 'low_margin',
      supplier: 'manual',
      sort: 'margin',
      sortList: other,
      direction: 'desc',
      marginList: other,
      marginBelowBp: 500,
      page: 3,
    });
  });

  it('a game takes no category or search, and a sort direction needs a sort', () => {
    expect(parseMatrixSearch({ gameId: id, categoryId: other, q: 'x' })).toEqual({ gameId: id });
    expect(parseMatrixSearch({ sortList: id, direction: 'desc' })).toEqual({});
  });

  it('keeps an empty list as retail alone (A05-33)', () => {
    expect(parseMatrixSearch({ lists: [] })).toEqual({ lists: [] });
    expect(parseMatrixSearch({ lists: ['x'] })).toEqual({ lists: [] });
  });

  it('drops what is not valid', () => {
    expect(
      parseMatrixSearch({
        gameId: 'x',
        q: '   ',
        lists: 7,
        warnings: 'true',
        status: 'x',
        supplier: 'x',
        sort: 'x',
        marginBelowBp: 0,
        page: '1.5',
      }),
    ).toEqual({});
    expect(parseMatrixSearch({ marginBelowBp: 10_001 })).toEqual({});
    expect(
      parseMatrixSearch({
        lists: Array(9)
          .fill(0)
          .map((_, i) => `${id.slice(0, -1)}${i}`),
      }).lists,
    ).toHaveLength(7);
  });
});

describe('the clear button', () => {
  it('shows with any filter or sort, never for the columns alone', () => {
    expect(hasMatrixFilters({ lists: [id] })).toBe(false);
    for (const search of [
      { gameId: id },
      { categoryId: id },
      { q: 'x' },
      { status: 'held' },
      { supplier: 'manual' },
      { sort: 'cost' },
      { marginBelowBp: 500 },
    ] as const) {
      expect(hasMatrixFilters(search)).toBe(true);
    }
  });

  it('keeps the columns', () => {
    expect(clearMatrixFilters({ lists: [id], q: 'x', sort: 'cost', page: 2 })).toEqual({
      lists: [id],
    });
    expect(clearMatrixFilters({ q: 'x' })).toEqual({});
  });
});

describe('nextMatrixSort', () => {
  it('goes lowest first, then highest first, then off, from page 1', () => {
    const first = nextMatrixSort({ q: 'x', page: 4 }, 'margin', other);
    expect(first).toEqual({ q: 'x', sort: 'margin', sortList: other });
    const second = nextMatrixSort(first, 'margin', other);
    expect(second).toEqual({ q: 'x', sort: 'margin', sortList: other, direction: 'desc' });
    expect(nextMatrixSort(second, 'margin', other)).toEqual({ q: 'x' });
  });

  it('starts over on another column or list', () => {
    const sorted = { sort: 'margin', sortList: other, direction: 'desc' } as const;
    expect(nextMatrixSort(sorted, 'price', other)).toEqual({ sort: 'price', sortList: other });
    expect(nextMatrixSort(sorted, 'margin', undefined)).toEqual({ sort: 'margin' });
  });
});
