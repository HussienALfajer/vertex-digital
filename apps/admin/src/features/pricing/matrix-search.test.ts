import { describe, expect, it } from 'vitest';
import { parseMatrixSearch } from './matrix-search';

const id = '01a15a8c-b312-75f3-92d2-65b29d838051';
const other = '01a15a8c-b312-75f3-92d2-691f7e3bf413';

describe('parseMatrixSearch', () => {
  it('keeps a game, a trimmed search, valid lists once and the warnings filter', () => {
    expect(
      parseMatrixSearch({ gameId: id, q: '  شدة ', lists: [id, 'x', id, other], warnings: 'true' }),
    ).toEqual({ gameId: id, q: 'شدة', lists: [id, other], warnings: true });
    expect(parseMatrixSearch({ lists: `${id},${other}`, warnings: true })).toEqual({
      lists: [id, other],
      warnings: true,
    });
  });

  it('drops what is not valid', () => {
    expect(parseMatrixSearch({ gameId: 'x', q: '   ', lists: 7, warnings: 'no' })).toEqual({});
    expect(
      parseMatrixSearch({
        lists: Array(9)
          .fill(0)
          .map((_, i) => `${id.slice(0, -1)}${i}`),
      }).lists,
    ).toHaveLength(7);
  });
});
