import { describe, expect, it } from 'vitest';
import { liveQuery, parseLiveSearch } from './live-search';

const GAME = '0199b000-0000-7000-8000-000000000080';

describe('parseLiveSearch', () => {
  it('keeps valid filters', () => {
    expect(parseLiveSearch({ supplier: 'manual', gameId: GAME, test: 'hide' })).toEqual({
      supplier: 'manual',
      gameId: GAME,
      test: 'hide',
    });
  });

  it('drops unknown suppliers, bad ids and the default test filter', () => {
    expect(parseLiveSearch({ supplier: 'other', gameId: '12', test: 'all' })).toEqual({});
    expect(parseLiveSearch({ test: 'maybe', gameId: 5 })).toEqual({});
  });

  it('sends the filters as they are', () => {
    expect(liveQuery({ test: 'only' })).toEqual({ test: 'only' });
  });
});
