import { describe, expect, it } from 'vitest';
import { parseShopsSearch, parseShopTab, statusOf, tabOf } from './shops-search';

describe('the shops pages in the URL (S26 Screens)', () => {
  it('opens the requests by default and keeps a valid tab and search', () => {
    expect(parseShopsSearch({})).toEqual({});
    expect(tabOf({})).toBe('requested');
    expect(statusOf({})).toBe('requested');
    expect(parseShopsSearch({ tab: 'closed', q: '  abu  ' })).toEqual({ tab: 'closed', q: 'abu' });
    expect(statusOf({ tab: 'all' })).toBeUndefined();
  });

  it('drops anything invalid', () => {
    expect(parseShopsSearch({ tab: 'requested', q: '' })).toEqual({});
    expect(parseShopsSearch({ tab: 'nope', q: 'x'.repeat(101) })).toEqual({});
    expect(parseShopTab({ tab: 'overview' })).toEqual({});
    expect(parseShopTab({ tab: 'nope' })).toEqual({});
    expect(parseShopTab({ tab: 'customers' })).toEqual({ tab: 'customers' });
  });
});
