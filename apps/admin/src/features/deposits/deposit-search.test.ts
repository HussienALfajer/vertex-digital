import { describe, expect, it } from 'vitest';
import { parseDepositSearch, tabOf, withTab } from './deposit-search';

describe('the deposits search', () => {
  it('opens the queue by default', () => {
    expect(parseDepositSearch({})).toEqual({});
    expect(parseDepositSearch({ status: 'submitted' })).toEqual({});
    expect(parseDepositSearch({ status: 'credited' })).toEqual({});
    expect(tabOf({})).toBe('submitted');
  });

  it('keeps a known tab and a search of 3 characters or more', () => {
    expect(parseDepositSearch({ status: 'all', q: ' vd-7kq2m ' })).toEqual({
      status: 'all',
      q: 'vd-7kq2m',
    });
    expect(parseDepositSearch({ status: 'pending', q: 'sa' })).toEqual({ status: 'pending' });
    expect(parseDepositSearch({ q: 42 })).toEqual({});
    expect(tabOf({ status: 'pending' })).toBe('pending');
  });

  it('changes the tab and keeps the text', () => {
    expect(withTab({ q: 'sara' }, 'all')).toEqual({ status: 'all', q: 'sara' });
    expect(withTab({ status: 'all' }, 'submitted')).toEqual({});
  });
});
